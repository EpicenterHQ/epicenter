/**
 * The device's side of the wire. `socket` opens the device's WebSocket,
 * which carries its pushes and catch-ups up and their answers and every
 * change event down, in order. `send` carries one replica request as HTTP
 * (a push is one `POST /commits`, a catch-up page one `GET /catch-up`, a
 * read by hash one `GET /blobs/<hash>` per text, so each is cached for
 * good): reads by hash always go this way, and a one-shot client can send
 * everything this way. `connectReplica` binds a replica in real time; the
 * property test drives the same client on virtual time instead.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { Replica, Reply, Request as ReplicaRequest } from '../b/replica.js';
import type { CatchUp, PushAnswer } from '../server/server.js';
import { PING, PONG, type SocketMessage, type SocketRequest } from './wire.js';

export const WireClientError = defineErrors({
	Unreachable: ({ cause }: { cause: unknown }) => ({ message: 'The repository server could not be reached', cause }),
	Unexpected: ({ status, body }: { status: number; body: string }) => ({ message: `The repository server answered ${status}: ${body.slice(0, 200)}`, status }),
});
export type WireClientError = InferErrors<typeof WireClientError>;

const ANSWERS = new Set<string>(['applied', 'merged', 'flushed', 'refused', 'outcome-unknown'] satisfies PushAnswer['kind'][]);
const isAnswer = (body: unknown): body is PushAnswer =>
	typeof body === 'object' && body !== null && 'kind' in body && typeof body.kind === 'string' && ANSWERS.has(body.kind);

export function createWireClient({
	url,
	headers = {},
	openSocket = (feed) => new WebSocket(feed),
}: {
	/** The repository's base URL, such as `http://127.0.0.1:8787/`. */
	url: string;
	/** Sent with every HTTP request, such as `authorization`. */
	headers?: Record<string, string>;
	/** Open the feed socket; a host that authenticates sockets by header passes its own (Bun's `new WebSocket(url, { headers })`). */
	openSocket?: (url: string) => WebSocket;
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

	async function read(rid: number, hashes: string[]): Promise<Result<Reply, WireClientError>> {
		const texts: Record<string, string> = {};
		const results = await Promise.all(
			hashes.map(async (hash): Promise<Result<null, WireClientError>> => {
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
		return Ok({ type: 'fetched', rid, texts });
	}

	return {
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
			const socket = openSocket(socketUrl.href);
			const pongs: (() => void)[] = [];
			socket.onmessage = (event) => {
				if (event.data === PONG) return pongs.shift()?.();
				message(JSON.parse(String(event.data)) as SocketMessage);
			};
			socket.onclose = (event) => {
				for (const resolve of pongs.splice(0)) resolve();
				closed(event.code);
			};
			return {
				/** Send a push or a catch-up; its reply comes down as a message naming its `rid`. Dropped unless the socket is open. */
				send(request: SocketRequest) {
					if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(request));
				},
				/** Resolves once everything the server sent before this ping has arrived, or the socket closed. */
				ping(): Promise<void> {
					if (socket.readyState !== WebSocket.OPEN) return Promise.resolve();
					socket.send(PING);
					return new Promise((resolve) => pongs.push(resolve));
				},
				close: () => socket.close(),
			};
		},
	};
}
export type WireClient = ReturnType<typeof createWireClient>;
export type SocketConnection = ReturnType<WireClient['socket']>;

/**
 * Bind a replica to a repository server over the wire, in real time. Its
 * pushes and catch-ups go on the socket, whose answers and events come back
 * in one ordered sequence; texts by hash are HTTP reads. While the socket is
 * down the replica is offline, and the socket reopens after `retry` ms. On
 * each open the server names `main`; the replica catches up only if that is
 * not where it stands.
 */
export function connectReplica(replica: Replica, client: WireClient, { retry = 1_000, log }: { retry?: number; log?: Logger } = {}) {
	let stopped = false;
	let socket: SocketConnection | null = null;
	function open() {
		const current = client.socket({
			message(message) {
				switch (message.type) {
					case 'head':
						replica.attach((request) => {
							if (request.type !== 'fetch') return current.send(request);
							void client.send(request).then(({ data: reply, error }) => {
								if (stopped) return;
								// No reply: the replica's own timeout sends the request again.
								if (error !== null) return log?.warn(error);
								replica.reply(reply);
							});
						});
						if (message.main !== replica.position()) replica.streamOpened();
						return;
					case 'commit': {
						const { type: _, ...event } = message;
						return replica.notify(event);
					}
					case 'answer':
						return replica.reply({ type: 'answer', rid: message.rid, answer: message.answer });
					case 'caught-up':
						return replica.reply(message);
					case 'error':
						return log?.warn(WireClientError.Unexpected({ status: message.status, body: message.error }));
					default:
						return message satisfies never;
				}
			},
			closed() {
				replica.attach(null);
				if (!stopped) setTimeout(open, retry);
			},
		});
		socket = current;
	}
	open();
	return {
		/** Stop: close the socket and take the replica offline. */
		close() {
			stopped = true;
			socket?.close();
			replica.attach(null);
		},
	};
}
