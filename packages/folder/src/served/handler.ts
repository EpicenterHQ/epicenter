/**
 * The program's half of the served wire (`wire.ts`): answers a page's
 * store verbs over a store the program opened, for a server that has
 * already decided the request is its own page's (the program checks the
 * request's host and origin, not this).
 *
 * Each watch request is its own watch of the store, stopped when the page
 * goes away or the handler closes.
 */
import { ClientError } from '@epicenter/definition/contract';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Store, Unavailable, Version } from '../device/store.js';
import {
	fromBase64,
	isRecord,
	isStrings,
	KEEP_ALIVE_MS,
	toBase64,
	VERBS,
	type Verb,
} from './wire.js';

const encoder = new TextEncoder();
const line = (message: unknown) =>
	encoder.encode(`${JSON.stringify(message)}\n`);

const unreadable = (message: string) =>
	Response.json({ error: 'bad_request', message }, { status: 400 });

/** `503` with why the store could not be reached. */
const unavailable = (error: Unavailable) =>
	Response.json(
		{ unavailable: extractErrorMessage(error.cause) },
		{ status: 503 },
	);

/** The store's answer as JSON, or `503` when it could not be reached. */
function answer<T>(
	result: Result<T, Unavailable>,
	shape: (data: T) => unknown,
) {
	if (result.error !== null) return unavailable(result.error);
	return Response.json(shape(result.data));
}

export type StoreHandler = {
	/** Answer one request; its verb is the last segment of its path. */
	fetch(request: Request): Promise<Response>;
	/** Stop every watch; later requests are answered `503`. */
	close(): void;
};

/**
 * Answer the served wire over the store `open` gives: called for each
 * request until it gives one, so a store that could not be opened (a
 * directory that could not be made) is tried again by the next request.
 */
export function storeHandler(
	open: () => Promise<Result<Store, Unavailable>>,
): StoreHandler {
	let opened: Store | undefined;
	let closed = false;
	const watches = new Set<() => void>();

	async function storeNow(): Promise<Result<Store, Unavailable>> {
		if (closed)
			return ClientError.Unavailable({ cause: 'the program is stopping' });
		if (opened !== undefined) return { data: opened, error: null };
		const result = await open();
		if (result.error === null) opened = result.data;
		return result;
	}

	async function watch(store: Store, signal: AbortSignal) {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let stopped = false;
		let stopWatch = () => {};
		let timer: ReturnType<typeof setInterval> | undefined;
		const send = (message: unknown) => {
			if (stopped) return;
			try {
				controller.enqueue(line(message));
			} catch {
				stop();
			}
		};
		function stop() {
			if (stopped) return;
			stopped = true;
			stopWatch();
			clearInterval(timer);
			watches.delete(stop);
			try {
				controller.close();
			} catch {}
		}
		const stream = new ReadableStream<Uint8Array>({
			start(given) {
				controller = given;
			},
			cancel: stop,
		});
		// A hint heard while the watch starts follows `listening`, which is first.
		let early: unknown[] | null = [];
		const watched = await store.watch((changed) => {
			if (early === null) send({ changed });
			else early.push({ changed });
		});
		if (watched.error !== null) return unavailable(watched.error);
		stopWatch = watched.data;
		watches.add(stop);
		signal.addEventListener('abort', stop);
		timer = setInterval(() => {
			if (stopped) return;
			try {
				controller.enqueue(encoder.encode('\n'));
			} catch {
				stop();
			}
		}, KEEP_ALIVE_MS);
		send({ listening: true });
		for (const message of early) send(message);
		early = null;
		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson',
				'cache-control': 'no-store',
			},
		});
	}

	return {
		async fetch(request) {
			const verb = new URL(request.url).pathname.split('/').pop() as Verb;
			if (!VERBS.includes(verb)) return new Response(null, { status: 404 });
			if (request.method !== 'POST') return new Response(null, { status: 405 });
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return unreadable('the request is not JSON');
			}
			if (!isRecord(body)) return unreadable('the request is not an object');
			const store = await storeNow();
			if (store.error !== null) return unavailable(store.error);
			switch (verb) {
				case 'list':
					if (!isStrings(body.under)) return unreadable('under must be paths');
					return answer(await store.data.list(body.under), (files) => ({
						files,
					}));
				case 'read':
					if (!isStrings(body.paths)) return unreadable('paths must be paths');
					return answer(await store.data.read(body.paths), (files) => ({
						files: files.map((file) =>
							'gone' in file
								? file
								: {
										path: file.path,
										bytes: toBase64(file.bytes),
										version: file.version,
									},
						),
					}));
				case 'write': {
					const { path, bytes, over } = body;
					if (typeof path !== 'string')
						return unreadable('path must be a path');
					if (bytes !== null && typeof bytes !== 'string')
						return unreadable('bytes must be base64 or null');
					if (typeof over !== 'string')
						return unreadable("over must be a version or 'absent'");
					let decoded: Uint8Array | null;
					try {
						decoded = bytes === null ? null : fromBase64(bytes);
					} catch {
						return unreadable('bytes must be base64 or null');
					}
					return answer(
						await store.data.write(path, decoded, over as Version | 'absent'),
						(landed) => ({ landed }),
					);
				}
				case 'watch':
					return watch(store.data, request.signal);
			}
		},
		close() {
			closed = true;
			for (const stop of [...watches]) stop();
			opened?.close();
		},
	};
}
