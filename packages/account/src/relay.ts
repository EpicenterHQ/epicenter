/**
 * The shell's relays: a request a page hands the native shell, which sends
 * it with a credential the page never holds and streams the answer back.
 * `relayThroughShell` is the one reader; the account's `fetch`
 * (`account_fetch`, `relayFetch`) and `@epicenter/ai`'s connected endpoints
 * (`connection_fetch`) use it. Only a Tauri window loads this module, with
 * its first relayed request.
 */
import type { AuthFetch } from './auth-contract.js';
import { AccountUnavailable } from './auth-errors.js';
import type { TauriShell } from './tauri.js';

/**
 * What the shell sends on a request's channel besides the body's raw chunks
 * (`relay.rs` in `epicenter-account`). An error event carries its relay's own
 * failure beside `kind`.
 */
type RelayEvent =
	| { kind: 'head'; status: number; headers: [string, string][] }
	| { kind: 'end' }
	| ({ kind: 'error' } & Record<string, unknown>);

/** Statuses whose response has no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function isChunk(
	message: unknown,
): message is ArrayBuffer | ArrayBufferView | number[] {
	return (
		message instanceof ArrayBuffer ||
		ArrayBuffer.isView(message) ||
		Array.isArray(message)
	);
}

function toBytes(chunk: ArrayBuffer | ArrayBufferView | number[]): Uint8Array {
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk))
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	return Uint8Array.from(chunk);
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return btoa(binary);
}

/** One of the shell's relays: its two commands, and what its failures become. */
export type ShellRelay = {
	/** The command that sends a request, such as `account_fetch`. */
	fetch: string;
	/** The command that stops one, by the id the page gave it. */
	cancel: string;
	/** Fields the shell reads beside the request's own. */
	fields: Record<string, unknown>;
	/**
	 * What a request rejects with when the command refuses it (`cause`
	 * is the command's error) or an error event ends it (the event).
	 */
	failure(cause: unknown): unknown;
};

/** `headers` as name and value pairs, read without the iterable DOM types a server build lacks. */
function entriesOf(headers: Headers): [string, string][] {
	const entries: [string, string][] = [];
	headers.forEach((value, name) => entries.push([name, value]));
	return entries;
}

/** The id of a request in flight, unique among every relay of this page. */
let lastRequest = 0;

/**
 * Send `request` through `relay` and read the answer as it streams back:
 * the head resolves the `Response`, the body's chunks fill it, and the end
 * closes it. Aborting `lifetime` or the request's signal stops it in the
 * shell.
 */
export async function relayThroughShell(
	shell: TauriShell,
	relay: ShellRelay,
	request: Request,
	lifetime?: AbortSignal,
): Promise<Response> {
	const body =
		request.body === null
			? null
			: toBase64(new Uint8Array(await request.arrayBuffer()));
	const signal = lifetime
		? AbortSignal.any([lifetime, request.signal])
		: request.signal;
	signal.throwIfAborted();
	const id = ++lastRequest;
	const cancel = () => void shell.invoke(relay.cancel, { id }).catch(() => {});

	return new Promise<Response>((resolve, reject) => {
		let headed = false;
		let finished = false;
		let sink!: ReadableStreamDefaultController<Uint8Array>;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				sink = controller;
			},
			cancel: () => {
				if (!finished) cancel();
			},
		});
		const fail = (error: unknown) => {
			if (finished) return;
			finished = true;
			signal.removeEventListener('abort', abort);
			if (!headed) reject(error);
			else sink.error(error);
		};
		const abort = () => {
			cancel();
			fail(signal.reason);
		};
		signal.addEventListener('abort', abort, { once: true });
		const channel = shell.channel((message) => {
			if (finished) return;
			if (isChunk(message)) {
				sink.enqueue(toBytes(message));
				return;
			}
			const event = message as RelayEvent;
			if (event.kind === 'head') {
				headed = true;
				const empty = NO_BODY.has(event.status);
				resolve(
					new Response(empty ? null : stream, {
						status: event.status,
						headers: event.headers,
					}),
				);
				return;
			}
			if (event.kind === 'end') {
				finished = true;
				signal.removeEventListener('abort', abort);
				sink.close();
				return;
			}
			fail(relay.failure(event));
		});
		shell
			.invoke(relay.fetch, {
				request: {
					...relay.fields,
					id,
					url: request.url,
					method: request.method,
					headers: entriesOf(request.headers),
					body,
				},
				onEvent: channel,
			})
			.catch((cause: unknown) => fail(relay.failure(cause)));
	});
}

/** A failure's message, whether the shell sent a string or an object. */
export function messageOf(cause: unknown): string {
	if (typeof cause === 'string') return cause;
	if (cause && typeof cause === 'object' && 'message' in cause)
		return String(cause.message);
	return String(cause);
}

/**
 * The account's `fetch`: each request goes to the shell, which sends it to
 * `origin` with the account's token and streams the answer back. A request
 * anywhere else is refused here, as the shell refuses it too. `lifetime`
 * aborts when the account is retired; `onRefusal` hears that the shell had
 * no token to send.
 */
export function relayFetch(
	shell: TauriShell,
	origin: string,
	lifetime: AbortSignal,
	onRefusal: (code: 'reauth-required' | 'auth-unavailable') => void,
): AuthFetch {
	const relay: ShellRelay = {
		fetch: 'account_fetch',
		cancel: 'account_fetch_cancel',
		fields: {},
		failure(cause) {
			const refusal =
				cause && typeof cause === 'object' && 'refusal' in cause
					? (cause.refusal as 'reauth-required' | 'auth-unavailable' | null)
					: null;
			if (!refusal) return new TypeError(messageOf(cause));
			onRefusal(refusal);
			return AccountUnavailable({ code: refusal }).error;
		},
	};
	return async (input, init) => {
		const target =
			input instanceof Request
				? input.url
				: new URL(String(input), `${origin}/`).href;
		const url = new URL(target);
		if (url.origin !== origin || url.username || url.password)
			throw new TypeError(
				`Account requests must go to ${origin}, not ${target}.`,
			);
		lifetime.throwIfAborted();
		const request = new Request(input instanceof Request ? input : url, init);
		return relayThroughShell(shell, relay, request, lifetime);
	};
}
