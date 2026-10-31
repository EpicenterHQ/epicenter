/**
 * Sign-in with Epicenter in a standalone desktop app: an `AuthClient` over
 * the native shell's account commands (`epicenter-account`,
 * `packages/tauri-epicenter-account`).
 *
 * The shell holds the sign-in: it signs in through the system browser,
 * keeps the refresh token in the keychain, and sends each of the account's
 * requests to Epicenter's API with a token this page never sees
 * (`account_fetch`). So the account's `fetch` here is a relay, and every
 * component reads `auth` the same way as in a browser build.
 *
 * The same relay sends a connected endpoint's requests (`connectionFetch`,
 * over `connection_fetch`), with the key the shell keeps for it.
 *
 * ```ts
 * const { client, ready } = createTauriAuth();
 * export const auth = fromAuth(client); // from '@epicenter/auth/svelte'
 * ```
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import type {
	Account,
	AuthClient,
	AuthFetch,
	AuthState,
} from './auth-contract.js';
import { AccountUnavailable, AuthError } from './auth-errors.js';
import { Principal } from './auth-types.js';
import { getProfileVia } from './read-profile.js';

/** What this module needs of the native shell; tests stand in for it. */
export type AccountShell = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	/** A channel that hands each message the shell sends to `onMessage`. */
	channel(onMessage: (message: unknown) => void): unknown;
};

const tauriShell: AccountShell = {
	invoke: (command, args) => invoke(command, args),
	channel: (onMessage) => new Channel<unknown>(onMessage),
};

/** `account_state`'s answer. */
type ShellState = {
	origin: string;
	signedIn: SignedIn | null;
	/** The server ended the sign-in; only signing in again helps. */
	refused: boolean;
};
type SignedIn = { origin: string; principalId: string };

/**
 * What the shell sends on a request's channel besides the body's raw chunks
 * (`relay.rs`). An error event carries its relay's own failure beside `kind`.
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
type Relay = {
	fetch: 'account_fetch' | 'connection_fetch';
	cancel: 'account_fetch_cancel' | 'connection_fetch_cancel';
	/** Fields the shell reads beside the request's own. */
	fields: Record<string, unknown>;
	/**
	 * What a request rejects with when the command refuses it (`cause`
	 * is the command's error) or an error event ends it (the event).
	 */
	failure(cause: unknown): unknown;
};

/** The id of a request in flight, unique among every relay of this page. */
let lastRequest = 0;

/**
 * Send `request` through `relay` and read the answer as it streams back:
 * the head resolves the `Response`, the body's chunks fill it, and the end
 * closes it. Aborting `lifetime` or the request's signal stops it in the
 * shell.
 */
async function sendThrough(
	shell: AccountShell,
	relay: Relay,
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
					headers: [...request.headers],
					body,
				},
				onEvent: channel,
			})
			.catch((cause: unknown) => fail(relay.failure(cause)));
	});
}

/** A failure's message, whether the shell sent a string or an object. */
function messageOf(cause: unknown): string {
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
	shell: AccountShell,
	origin: string,
	lifetime: AbortSignal,
	onRefusal: (code: 'reauth-required' | 'auth-unavailable') => void,
): AuthFetch {
	const relay: Relay = {
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
		return sendThrough(shell, relay, request, lifetime);
	};
}

/**
 * Why the shell did not send a connection's request, or why its answer
 * ended early (`ConnectionFetchError` in `connection.rs`).
 */
export const ConnectionFetchError = defineErrors({
	/** The request does not read, or carried a credential of the page's. */
	InvalidRequest: ({ message }: { message: string }) => ({ message }),
	/** Neither `https`, nor `http` to `localhost` or `127.0.0.1`. */
	SchemeRefused: ({ message }: { message: string }) => ({ message }),
	/** Not on the origin of the endpoint the connection's key was saved for. */
	OriginRefused: ({ message }: { message: string }) => ({ message }),
	/** The keychain could not be read. */
	KeychainFailed: ({ message }: { message: string }) => ({ message }),
	/** The endpoint could not be reached, or its answer broke off. */
	SendFailed: ({ message }: { message: string }) => ({ message }),
});
export type ConnectionFetchError = InferErrors<typeof ConnectionFetchError>;

/** The shell's `ConnectionFetchError` as this page's, or a `TypeError` for anything else. */
function connectionFailure(cause: unknown) {
	const name =
		cause && typeof cause === 'object' && 'name' in cause
			? String(cause.name)
			: '';
	if (Object.hasOwn(ConnectionFetchError, name))
		return ConnectionFetchError[name as ConnectionFetchError['name']]({
			message: messageOf(cause),
		}).error;
	return new TypeError(messageOf(cause));
}

/**
 * The `fetch` of one connected endpoint (`connection` is its id): each
 * request goes to the shell, which reads the key the keychain keeps for the
 * connection, sends the request only to the endpoint that key was saved for
 * and with the key, and streams the answer back. The page sends no
 * credential, and no endpoint needs to allow this window's origin (CORS). A
 * refusal rejects with a {@link ConnectionFetchError}, as `fetch` rejects.
 */
export function connectionFetch(
	connection: string,
	shell: AccountShell = tauriShell,
): AuthFetch {
	const relay: Relay = {
		fetch: 'connection_fetch',
		cancel: 'connection_fetch_cancel',
		fields: { connection },
		failure: connectionFailure,
	};
	return (input, init) => sendThrough(shell, relay, new Request(input, init));
}

/**
 * The desktop's `AuthClient` over the shell's account commands. `ready`
 * answers once the shell said who, if anyone, is signed in; until then, and
 * when the shell cannot answer, it is signed out.
 */
export function createTauriAuth(shell: AccountShell = tauriShell): {
	client: AuthClient;
	ready: Promise<void>;
} {
	let state: AuthState = { status: 'signed-out' };
	let baseURL = '';
	let current: { account: Account; lifetime: AbortController } | undefined;
	const listeners = new Set<(state: AuthState) => void>();

	function publish(next: AuthState) {
		if (next.status === state.status && next.account === state.account) return;
		state = next;
		for (const listener of listeners) listener(state);
	}

	function retire() {
		current?.lifetime.abort(
			AccountUnavailable({ code: 'reauth-required' }).error,
		);
		current = undefined;
	}

	/** Publish `signedIn`, keeping the Account when it is the same person. */
	function adopt(signedIn: SignedIn, refused: boolean) {
		const principalId = Principal.assert({ id: signedIn.principalId }).id;
		let account = current?.account;
		if (
			account?.principalId !== principalId ||
			account.baseURL !== signedIn.origin
		) {
			retire();
			const lifetime = new AbortController();
			const fetch = relayFetch(
				shell,
				signedIn.origin,
				lifetime.signal,
				(code) => {
					if (code === 'reauth-required' && current?.account === opened)
						publish({ status: 'reauth-required', account: opened });
				},
			);
			const opened: Account = {
				authorityId: signedIn.origin,
				principalId,
				baseURL: signedIn.origin,
				signal: lifetime.signal,
				fetch,
				getProfile: () => getProfileVia(fetch, signedIn.origin),
			};
			current = { account: opened, lifetime };
			account = opened;
		}
		publish({ status: refused ? 'reauth-required' : 'signed-in', account });
	}

	async function refresh() {
		const answer = await shell.invoke<ShellState>('account_state');
		baseURL = answer.origin;
		if (answer.signedIn) adopt(answer.signedIn, answer.refused);
		else {
			retire();
			publish({ status: 'signed-out' });
		}
	}

	const client = {
		getState: () => state,
		refresh,
		get baseURL() {
			return baseURL;
		},
		onStateChange(listener: (state: AuthState) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async startSignIn() {
			try {
				adopt(await shell.invoke<SignedIn>('account_sign_in'), false);
				return Ok(undefined);
			} catch (cause) {
				return AuthError.StartSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				await shell.invoke('account_sign_out');
			} catch (cause) {
				return AuthError.SignOutFailed({ cause });
			}
			retire();
			publish({ status: 'signed-out' });
			return Ok(undefined);
		},
		async getProfile() {
			if (state.status === 'signed-out')
				return AuthError.ProfileUnavailable({ cause: 'signed out' });
			return state.account.getProfile();
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	} satisfies AuthClient;
	const ready = refresh().catch(() => {});
	return { client, ready };
}

/**
 * The keys a page saves in the keychain under names of its own (a provider
 * such as `openai`, or a connection's id): letters, digits, `_` and `-`.
 */
export const keychain = {
	/** The saved keys among `names`, by name; a name with none is absent. */
	get: (names: string[], shell: AccountShell = tauriShell) =>
		shell.invoke<Record<string, string>>('keychain_get', { names }),
	/** Save the key `name`, or remove it for `null`. */
	set: (name: string, value: string | null, shell: AccountShell = tauriShell) =>
		shell.invoke<void>('keychain_set', { name, value }),
};
