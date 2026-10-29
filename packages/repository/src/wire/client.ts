/**
 * The device's side of the wire. `socket` opens the device's WebSocket,
 * which carries its pushes and catch-ups up and their answers and every
 * change event down, in order. A browser cannot set a WebSocket's headers,
 * so with `tickets` the socket first asks `POST /tickets` (with `headers`)
 * for a one-use ticket and connects with it. `send` carries one replica request as HTTP
 * (a push is one `POST /commits`, a catch-up page one `GET /catch-up`, a
 * read by hash one `GET /blobs/<hash>` per text, a few at a time, so each
 * is cached for good): reads by hash always go this way, and a one-shot client can send
 * everything this way. A replica's socket transport (client/socket.ts)
 * drives it in real time; the property test drives the same client on
 * virtual time instead.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Reply, Request as ReplicaRequest } from '../client/replica.js';
import type { CatchUp, PushAnswer } from '../server/server.js';
import { PING, PONG, SESSION_EXPIRED, type SocketMessage, type SocketRequest, type Ticket } from './wire.js';

/** The close code a socket reports when it never opened: the WebSocket API's abnormal closure. */
const NEVER_OPENED = 1006;

export const WireClientError = defineErrors({
	Unreachable: ({ cause }: { cause: unknown }) => ({ message: 'The repository server could not be reached', cause }),
	Unexpected: ({ status, body }: { status: number; body: string }) => ({ message: `The repository server answered ${status}: ${body.slice(0, 200)}`, status }),
});
export type WireClientError = InferErrors<typeof WireClientError>;

/** Texts by hash requested at once: a replica's read (up to 256 texts) goes in waves, not all at once. */
const READS_AT_ONCE = 16;

const ANSWERS = new Set<string>(['applied', 'merged', 'flushed', 'refused', 'rejected', 'outcome-unknown'] satisfies PushAnswer['kind'][]);
const isAnswer = (body: unknown): body is PushAnswer =>
	typeof body === 'object' && body !== null && 'kind' in body && typeof body.kind === 'string' && ANSWERS.has(body.kind);

export function createWireClient({
	url,
	headers = {},
	openSocket = (feed) => new WebSocket(feed),
	tickets = false,
}: {
	/** The repository's base URL, such as `http://127.0.0.1:8787/`. */
	url: string;
	/** Sent with every HTTP request, such as `authorization`. */
	headers?: Record<string, string>;
	/** Open the feed socket; a host that authenticates sockets by header passes its own (Bun's `new WebSocket(url, { headers })`). */
	openSocket?: (url: string) => WebSocket;
	/** Authenticate each socket with a one-use ticket from `POST /tickets`, as a browser must. */
	tickets?: boolean;
}) {
	const base = new URL(url.endsWith('/') ? url : `${url}/`);
	const at = (path: string) => new URL(path, base);

	/** One HTTP request; a body is always JSON. */
	async function call(path: URL, init: { method?: string; body?: string } = {}): Promise<Result<Response, WireClientError>> {
		const sent = init.body === undefined ? headers : { ...headers, 'content-type': 'application/json' };
		return tryAsync({
			try: () => fetch(path, { ...init, headers: sent }),
			catch: (cause) => WireClientError.Unreachable({ cause }),
		});
	}
	const unexpected = async (response: Response) => WireClientError.Unexpected({ status: response.status, body: await response.text() });

	async function push(rid: number, commit: Extract<ReplicaRequest, { type: 'push' }>['commit']): Promise<Result<Reply, WireClientError>> {
		const { data: response, error } = await call(at('commits'), { method: 'POST', body: JSON.stringify(commit) });
		if (error !== null) return Err(error);
		// A write's answer is JSON whatever its status; anything else (401, 403, 400) is not an answer to this commit.
		const text = await response.text();
		const body: unknown = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null;
		if (!isAnswer(body)) return WireClientError.Unexpected({ status: response.status, body: text });
		return Ok({ type: 'answer', rid, answer: body });
	}

	async function catchUp(request: Extract<ReplicaRequest, { type: 'catch-up' }>): Promise<Result<Reply, WireClientError>> {
		const path = at('catch-up');
		path.searchParams.set('from', request.from ?? '');
		if (request.to !== undefined) path.searchParams.set('to', request.to);
		if (request.after !== undefined) path.searchParams.set('after', request.after);
		for (const named of request.paths) path.searchParams.append('path', named);
		const { data: response, error } = await call(path);
		if (error !== null) return Err(error);
		if (response.status !== 200) return unexpected(response);
		return Ok({ type: 'caught-up', rid: request.rid, catchUp: (await response.json()) as CatchUp });
	}

	/** One replica read: its texts by hash, `READS_AT_ONCE` requests at a time. */
	async function read(rid: number, hashes: string[]): Promise<Result<Reply, WireClientError>> {
		const texts: Record<string, string> = {};
		for (let start = 0; start < hashes.length; start += READS_AT_ONCE) {
			const results = await Promise.all(
				hashes.slice(start, start + READS_AT_ONCE).map(async (hash): Promise<Result<null, WireClientError>> => {
					const { data: response, error } = await call(at(`blobs/${hash}`));
					if (error !== null) return Err(error);
					// A text the server does not have is left out, as the server's own `fetch` leaves it out.
					if (response.status === 404) return Ok(null);
					if (response.status !== 200) return unexpected(response);
					texts[hash] = await response.text();
					return Ok(null);
				}),
			);
			const failed = results.find((result) => result.error !== null);
			if (failed !== undefined) return failed;
		}
		return Ok({ type: 'fetched', rid, texts });
	}

	/** A one-use ticket for the next socket. */
	async function ticket(): Promise<Result<string, WireClientError>> {
		const { data: response, error } = await call(at('tickets'), { method: 'POST' });
		if (error !== null) return Err(error);
		if (response.status !== 200) return unexpected(response);
		return Ok(((await response.json()) as Ticket).ticket);
	}

	return {
		/** The repository's base URL: the server a replica binds to. */
		url: base.href,
		/** Carry one replica request; its reply, or why there is none (the replica's timeout then asks again). */
		send(request: ReplicaRequest): Promise<Result<Reply, WireClientError>> {
			switch (request.type) {
				case 'push':
					return push(request.rid, request.commit);
				case 'catch-up':
					return catchUp(request);
				case 'fetch':
					return read(request.rid, request.hashes);
				default:
					return request satisfies never;
			}
		},
		/**
		 * Open the device's socket. `message` gets every message down in the
		 * server's order; `closed` is called once, when the socket closes for
		 * any reason (4401: the session expired).
		 */
		socket({ message, closed }: { message: (message: SocketMessage) => void; closed: (code: number) => void }) {
			const socketUrl = at('socket');
			socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
			let socket: WebSocket | null = null;
			let closing = false;
			const pongs: (() => void)[] = [];
			const attach = (opened: WebSocket) => {
				socket = opened;
				opened.onmessage = (event) => {
					if (event.data === PONG) return pongs.shift()?.();
					message(JSON.parse(String(event.data)) as SocketMessage);
				};
				opened.onclose = (event) => {
					for (const resolve of pongs.splice(0)) resolve();
					closed(event.code);
				};
			};
			if (!tickets) attach(openSocket(socketUrl.href));
			else
				void ticket().then(({ data, error }) => {
					// No ticket, no socket: the caller hears it closed, as it would a refused one, and may try again.
					if (error !== null) return closed(error.name === 'Unexpected' && error.status === 401 ? SESSION_EXPIRED : NEVER_OPENED);
					if (closing) return closed(NEVER_OPENED);
					socketUrl.searchParams.set('ticket', data);
					attach(openSocket(socketUrl.href));
				});
			return {
				/** Send a push or a catch-up; its reply comes down as a message naming its `rid`. Dropped unless the socket is open. */
				send(request: SocketRequest) {
					if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
				},
				/** Resolves once everything the server sent before this ping has arrived, or the socket closed. */
				ping(): Promise<void> {
					if (socket?.readyState !== WebSocket.OPEN) return Promise.resolve();
					socket.send(PING);
					return new Promise((resolve) => pongs.push(resolve));
				},
				close() {
					closing = true;
					socket?.close();
				},
			};
		},
	};
}
export type WireClient = ReturnType<typeof createWireClient>;
export type SocketConnection = ReturnType<WireClient['socket']>;

export type LfsAction = { href: string; header?: Record<string, string>; expires_at?: string; expires_in?: number };
export type LfsObjectAnswer = {
	oid: string;
	size: number;
	actions?: { upload?: LfsAction; download?: LfsAction; verify?: LfsAction };
	error?: { code: number; message: string };
};

export const LfsClientError = defineErrors({
	Network: ({ cause }: { cause: unknown }) => ({ message: 'The LFS server could not be reached', cause }),
	Retryable: ({ status }: { status: number }) => ({ message: `The LFS server answered ${status}; retry later`, status }),
	Refused: ({ status, message }: { status: number; message: string }) => ({ message, status }),
	Unexpected: ({ status, message }: { status: number; message: string }) => ({ message, status }),
});
export type LfsClientError = InferErrors<typeof LfsClientError>;

/** A basic-transfer client; action URLs and headers come from the batch response. */
export function createLfsClient({ url, headers = {} }: { url: string; headers?: Record<string, string> }) {
	const endpoint = new URL('info/lfs/objects/batch', url.endsWith('/') ? url : `${url}/`);
	const media = 'application/vnd.git-lfs+json';
	async function sent(target: string | URL, init: RequestInit): Promise<Result<Response, LfsClientError>> {
		const response = await tryAsync({ try: () => fetch(target, init), catch: (cause) => LfsClientError.Network({ cause }) });
		if (response.error !== null) return response;
		if (response.data.status === 429 || response.data.status >= 500) return LfsClientError.Retryable({ status: response.data.status });
		if (response.data.status >= 400 && response.data.status < 500) return LfsClientError.Refused({ status: response.data.status, message: (await response.data.text()).slice(0, 200) });
		return response;
	}
	return {
		async batch(operation: 'upload' | 'download', objects: { oid: string; size: number }[]): Promise<Result<LfsObjectAnswer[], LfsClientError>> {
			const result = await sent(endpoint, { method: 'POST', headers: { ...headers, accept: media, 'content-type': media }, body: JSON.stringify({ operation, transfers: ['basic'], hash_algo: 'sha256', objects }) });
			if (result.error !== null) return Err(result.error);
			try {
				const answer: unknown = await result.data.json();
				if (typeof answer !== 'object' || answer === null || !('objects' in answer) || !Array.isArray(answer.objects)) throw new Error('No objects in batch answer');
				return Ok(answer.objects as LfsObjectAnswer[]);
			} catch (cause) { return LfsClientError.Unexpected({ status: result.data.status, message: String(cause) }); }
		},
		/** PUT the bytes to an upload action's `href`, with its headers: a `Blob`, whose length is known and whose bytes are read as they go, never copied. */
		async put(action: LfsAction, body: Blob): Promise<Result<void, LfsClientError>> {
			const result = await sent(action.href, { method: 'PUT', headers: { ...action.header }, body });
			return result.error !== null ? Err(result.error) : Ok(undefined);
		},
		async verify(action: LfsAction, object: { oid: string; size: number }): Promise<Result<void, LfsClientError>> {
			const result = await sent(action.href, { method: 'POST', headers: { ...action.header, 'content-type': media }, body: JSON.stringify(object) });
			return result.error !== null ? Err(result.error) : Ok(undefined);
		},
		async get(action: LfsAction): Promise<Result<ReadableStream<Uint8Array>, LfsClientError>> {
			const result = await sent(action.href, { headers: action.header });
			if (result.error !== null) return Err(result.error);
			return result.data.body === null ? LfsClientError.Unexpected({ status: result.data.status, message: 'The object response has no body' }) : Ok(result.data.body);
		},
	};
}
export type LfsClient = ReturnType<typeof createLfsClient>;
