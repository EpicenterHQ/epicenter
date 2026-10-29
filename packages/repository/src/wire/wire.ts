/**
 * Design B's wire. A device keeps one WebSocket: it sends its commits and
 * catch-ups there and gets their answers and every change event on it, in
 * one ordered sequence. HTTP serves one-shot clients (agents, the CLI,
 * scripts) and content by hash. Both transports call the same composed
 * functions, `takeCommit` and `takeCatchUp`; only the endpoints differ.
 *
 * It is host-agnostic: `createWire` turns a `Request` into a `Response`
 * and a socket message into replies; the host supplies who is asking (an
 * `Authenticate`) and the sockets (a `SocketHub`: Bun's pub/sub in the dev
 * server, a Durable Object's hibernating WebSockets later).
 *
 * One repository, at the root:
 *
 *   GET    /socket           the device's WebSocket (below)
 *   POST   /commits          a live commit, as JSON; answered with its PushAnswer
 *   GET    /files/<path>     main's text, its hash as the ETag
 *   PUT    /files/<path>     If-Match: "<hash>", or If-None-Match: * to create: one fast-forward commit on main
 *   DELETE /files/<path>     If-Match: "<hash>": the same, deleting
 *   GET    /catch-up         ?from=<commit>&to=&after=&path=...: one catch-up page
 *   GET    /blobs/<hash>     a text by its Git blob hash: immutable, so cached for good, but never by a shared cache
 *
 * Every request, reads included, is authenticated first (401 without a
 * session, or with one that has expired) and must come from a member (403
 * otherwise, `server.mayRead`). A write's answer is JSON whatever its
 * status: 200 applied, merged or flushed; 409 outcome-unknown; and for a
 * refusal, 428 with no parent (or no precondition), 412 when a fast-forward
 * found main moved (or a file is not at the hash named), with main's texts
 * for the paths it touched, 429 rate, 403 a reader or another author, 413
 * too large, and 422 anything the door refuses. A request body is capped
 * before it is parsed, and a request not read within `timeout` gets 408.
 *
 * The socket is authenticated when it connects, and the host closes it
 * (4401) when the session expires. Up, a device sends `push` and `catch-up`
 * requests with its own request id; down, it gets `head` first (main, so a
 * device that reconnects resumes from its last head by catching up when the
 * two differ, and the repository's id and the session's user, so a replica
 * bound to another repository or account refuses the socket), `commit` events (id, parents, changed paths with hashes,
 * never texts), and `answer`, `caught-up` or `error` replies naming the
 * request id. A commit's answer goes to its device before the commit's
 * event goes to anyone, and everything is in the server's order. The only
 * state a socket holds is its verified session, which a hibernating host
 * keeps as the socket's attachment. `ping` is answered `pong` after
 * everything sent before it (a Durable Object can answer it while
 * hibernating, with an auto-response).
 */
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { type CatchUp, type Event, LIMITS, type PushAnswer, type Server, type Session } from '../server/server.js';

// ============================================================================
// Ports and protocol
// ============================================================================

/** A session as the host verified it, with when it expires (ms since the epoch), if it does. */
export type Verified = Session & { expires?: number };

/** Who is asking, as the host verifies it; null when the request carries no valid credential. */
export type Authenticate = (request: Request) => Verified | null | Promise<Verified | null>;

/** Where the devices' sockets are: the host's side of the socket. */
export type SocketHub = {
	/**
	 * Accept a WebSocket upgrade from a verified member, keeping `verified`
	 * as the socket's only state: Bun's `server.upgrade` with it as data, or
	 * a Durable Object's `acceptWebSocket` with it as the attachment.
	 * Undefined when the host took the request over. Once the socket is
	 * open, the host sends it `wire.hello(verified)` first, hands every message to
	 * `wire.receive`, and closes it (4401) when the session expires.
	 */
	upgrade(request: Request, verified: Verified): Response | undefined;
	/** Send one message to every open socket. */
	publish(message: string): void;
};

/** A socket's own end, for one message's replies. */
export type SocketEnd = { send(message: string): void; close(code: number, reason: string): void };

/** The query of one catch-up page, from either transport. */
export type CatchUpQuery = Parameters<Server['catchUp']>[0];

/** What a device sends on its socket; `rid` is its own request id, named in the reply. */
export type SocketRequest = { type: 'push'; rid: number; commit: LiveCommit } | ({ type: 'catch-up'; rid: number } & CatchUpQuery);

/** What a socket carries down: main when it opens, each commit on main (never texts), and the replies to its own requests. */
export type SocketMessage =
	/** The repository this socket reaches and the account it is signed in as, so a replica bound elsewhere refuses it. */
	| { type: 'head'; main: string; repository: string; user: string }
	| ({ type: 'commit' } & Event)
	| { type: 'answer'; rid: number; status: number; answer: PushAnswer }
	| { type: 'caught-up'; rid: number; catchUp: CatchUp }
	/** A request that was not one: `rid` when it could be read. */
	| { type: 'error'; rid: number | null; status: number; error: string };

/** The close code of a socket whose session expired. */
export const SESSION_EXPIRED = 4401;

/** A socket's keep-alive, answered after everything sent before it. */
export const PING = 'ping';
export const PONG = 'pong';

export type WireLimits = {
	/** Bytes of one request body, checked before it is parsed. */
	body: number;
	/** Milliseconds to authenticate a request and read its body. */
	timeout: number;
};

export const WIRE_LIMITS: WireLimits = { body: LIMITS.request, timeout: 10_000 };

/** The header a plain HTTP writer names its device in; `http` without it. */
export const DEVICE_HEADER = 'epicenter-device';

/** A live commit as it may arrive; a missing parent is the door's to refuse (428). */
const CommitSchema = Type.Object(
	{
		id: Type.String(),
		parent: Type.Optional(Type.String()),
		mode: Type.Union([Type.Literal('fast-forward'), Type.Literal('merge')]),
		author: Type.Object({ user: Type.String(), device: Type.String() }, { additionalProperties: false }),
		time: Type.String(),
		files: Type.Array(Type.Object({ path: Type.String(), text: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);

const SocketRequestSchema = Type.Union([
	Type.Object({ type: Type.Literal('push'), rid: Type.Number(), commit: Type.Unknown() }, { additionalProperties: false }),
	Type.Object(
		{
			type: Type.Literal('catch-up'),
			rid: Type.Number(),
			from: Type.Union([Type.String(), Type.Null()]),
			paths: Type.Optional(Type.Array(Type.String())),
			to: Type.Optional(Type.String()),
			after: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);

const BodyError = defineErrors({
	TooLarge: () => ({ message: 'The request body is larger than the limit' }),
	TimedOut: () => ({ message: 'The request body was not read in time' }),
	NotText: () => ({ message: 'The request body is not UTF-8' }),
});
type BodyError = InferErrors<typeof BodyError>;

/** The status of a refusal, by reason; any other reason is the door's (422). */
const REFUSED: Record<string, number> = {
	'no session': 401,
	'not a member': 403,
	'a reader may not write': 403,
	'the author is not the session': 403,
	'no parent': 428,
	'no precondition': 428,
	'main moved': 412,
	'the file moved': 412,
	rate: 429,
	'request too large': 413,
	'too many files': 413,
};

/** The HTTP status of a write's answer. */
export function statusOf(answer: PushAnswer): number {
	switch (answer.kind) {
		case 'applied':
		case 'merged':
		case 'flushed':
			return 200;
		case 'outcome-unknown':
			return 409;
		case 'refused':
			return REFUSED[answer.reason] ?? 422;
		default:
			return answer satisfies never;
	}
}

/** Any of the strong entity tags in an `If-Match` or `If-None-Match` header is this hash, or the header is `*`. */
function matches(header: string, hash: string | null) {
	if (header.trim() === '*') return hash !== null;
	return hash !== null && header.split(',').some((tag) => tag.trim() === `"${hash}"`);
}

const EXPIRED = Symbol('expired');
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Read a body of at most `cap` bytes, as UTF-8, before `expired` settles. */
async function readBody(request: Request, cap: number, expired: Promise<typeof EXPIRED>): Promise<Result<string, BodyError>> {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > cap) return BodyError.TooLarge();
	if (request.body === null) return Ok('');
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const read = await Promise.race([reader.read(), expired]);
		if (read === EXPIRED) {
			void reader.cancel().catch(() => {});
			return BodyError.TimedOut();
		}
		if (read.done) break;
		total += read.value.byteLength;
		if (total > cap) {
			void reader.cancel().catch(() => {});
			return BodyError.TooLarge();
		}
		chunks.push(read.value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	const { data, error } = trySync({ try: () => decoder.decode(bytes), catch: () => BodyError.NotText() });
	if (error !== null) return Err(error);
	return Ok(data);
}

const NO_STORE = { 'cache-control': 'no-store' };
/** A text named by its hash never changes: a browser keeps it for good; a shared cache never does, because every read is authorized. */
const IMMUTABLE = { 'cache-control': 'private, max-age=31536000, immutable' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const failure = (status: number, error: string, headers: Record<string, string> = {}) => json(status, { error }, headers);

// ============================================================================
// The wire
// ============================================================================

export function createWire({
	repository,
	server,
	authenticate,
	sockets,
	limits: given = {},
	clock = () => Date.now(),
}: {
	/** The repository's id, as the host names it: a replica records it and refuses a socket that names another. */
	repository: string;
	server: Server;
	authenticate: Authenticate;
	sockets: SocketHub;
	limits?: Partial<WireLimits>;
	/** The time a PUT or DELETE commit carries, and against which a session expires. */
	clock?: () => number;
}) {
	const limits = { ...WIRE_LIMITS, ...given };
	/** Events of a commit taken from a socket wait here until its answer is sent, so the device hears its answer first. */
	let holding: string[] | null = null;
	const unsubscribe = server.subscribe((event) => {
		const message = JSON.stringify({ type: 'commit', ...event } satisfies SocketMessage);
		if (holding === null) sockets.publish(message);
		else holding.push(message);
	});
	const lapsed = (verified: Verified) => verified.expires !== undefined && verified.expires <= clock();

	/**
	 * Take one commit, from either transport: its answer and that answer's
	 * status, or why the value is not a live commit.
	 */
	function takeCommit(value: unknown, session: Session): { status: number; answer: PushAnswer } | { status: 400; error: string } {
		if (!Check(CommitSchema, value)) return { status: 400, error: 'Not a live commit' };
		// The schema allows a missing parent only so the door can refuse it in its order (428); nothing else differs from LiveCommit.
		const answer = server.push(value as LiveCommit, session);
		return { status: statusOf(answer), answer };
	}

	/** One catch-up page, from either transport. */
	const takeCatchUp = (query: CatchUpQuery) => server.catchUp(query);

	const answer = (pushed: PushAnswer, headers: Record<string, string> = {}) =>
		json(statusOf(pushed), pushed, statusOf(pushed) === 429 ? { 'retry-after': '1', ...headers } : headers);
	const refused = (reason: string, extra: Partial<Extract<PushAnswer, { kind: 'refused' }>> = {}) => answer({ kind: 'refused', reason, main: server.main(), ...extra });

	/** A body that could not be read: too large is the commit's refusal, so its writer holds it; the rest are the request's. */
	function unread(error: BodyError) {
		switch (error.name) {
			case 'TooLarge':
				return refused('request too large');
			case 'TimedOut':
				return failure(408, error.message);
			case 'NotText':
				return failure(400, error.message);
			default:
				return error satisfies never;
		}
	}

	async function postCommit(request: Request, session: Session, expired: Promise<typeof EXPIRED>) {
		const { data: body, error } = await readBody(request, limits.body, expired);
		if (error !== null) return unread(error);
		const parsed = trySync({ try: (): unknown => JSON.parse(body), catch: () => BodyError.NotText() });
		if (parsed.error !== null) return failure(400, 'The body is not JSON');
		const taken = takeCommit(parsed.data, session);
		return 'error' in taken ? failure(400, taken.error) : answer(taken.answer);
	}

	/** PUT and DELETE: one file, conditional on its hash, as one fast-forward commit on main, taken like any other. */
	async function writeFile(request: Request, session: Session, path: string, expired: Promise<typeof EXPIRED>) {
		const ifMatch = request.headers.get('if-match');
		const create = request.method === 'PUT' && request.headers.get('if-none-match')?.trim() === '*';
		if (ifMatch === null && !create) return refused('no precondition');
		let text: string | null = null;
		if (request.method === 'PUT') {
			const { data, error } = await readBody(request, limits.body, expired);
			if (error !== null) return unread(error);
			text = data;
		}
		// From here to the push nothing awaits, so main cannot move between the check and the commit.
		const current = server.read(path);
		const hash = current === null ? null : gitBlobHash(current);
		const holds = ifMatch !== null ? matches(ifMatch, hash) : hash === null;
		if (!holds) return refused('the file moved', { files: [{ path, text: current, hash }] });
		const commit = {
			parent: server.main(),
			mode: 'fast-forward' as const,
			author: { user: session.user, device: request.headers.get(DEVICE_HEADER) ?? 'http' },
			time: new Date(clock()).toISOString(),
			files: [{ path, text }],
		};
		const taken = takeCommit({ id: commitId(commit), ...commit }, session);
		if ('error' in taken) return failure(400, taken.error);
		const pushed = taken.answer;
		return answer(pushed, pushed.kind === 'applied' && text !== null ? { etag: `"${gitBlobHash(text)}"` } : {});
	}

	function readFile(request: Request, path: string) {
		const text = server.read(path);
		if (text === null) return failure(404, 'No such file on main');
		const etag = `"${gitBlobHash(text)}"`;
		const headers = { etag, 'cache-control': 'private, no-cache' };
		if (matches(request.headers.get('if-none-match') ?? '', gitBlobHash(text))) return new Response(null, { status: 304, headers });
		return new Response(text, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
	}

	function catchUp(url: URL) {
		const params = url.searchParams;
		const to = params.get('to');
		const after = params.get('after');
		const page = takeCatchUp({
			from: params.get('from') || null,
			paths: params.getAll('path'),
			...(to === null ? {} : { to }),
			...(after === null ? {} : { after }),
		});
		return json(200, page);
	}

	function readBlob(request: Request, hash: string) {
		const text = /^[0-9a-f]{40}$/.test(hash) ? server.fetch([hash])[hash] : undefined;
		if (text === undefined) return failure(404, 'No text has this hash');
		const headers = { ...IMMUTABLE, etag: `"${hash}"` };
		if (matches(request.headers.get('if-none-match') ?? '', hash)) return new Response(null, { status: 304, headers });
		return new Response(text, { headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
	}

	const notAllowed = (allow: string) => failure(405, 'Method not allowed', { allow });

	async function route(request: Request, session: Session, expired: Promise<typeof EXPIRED>): Promise<Response | undefined> {
		const url = new URL(request.url);
		const { pathname } = url;
		const { method } = request;
		if (pathname === '/commits') return method === 'POST' ? postCommit(request, session, expired) : notAllowed('POST');
		if (pathname === '/catch-up') return method === 'GET' ? catchUp(url) : notAllowed('GET');
		if (pathname === '/socket') {
			if (method !== 'GET') return notAllowed('GET');
			if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return failure(426, 'The socket is a WebSocket', { upgrade: 'websocket' });
			return sockets.upgrade(request, session);
		}
		if (pathname.startsWith('/blobs/')) return method === 'GET' ? readBlob(request, pathname.slice('/blobs/'.length)) : notAllowed('GET');
		if (pathname.startsWith('/files/')) {
			const path = trySync({ try: () => decodeURIComponent(pathname.slice('/files/'.length)), catch: () => BodyError.NotText() });
			if (path.error !== null || path.data === '') return failure(400, 'Not a file path');
			switch (method) {
				case 'GET':
					return readFile(request, path.data);
				case 'PUT':
				case 'DELETE':
					return writeFile(request, session, path.data, expired);
				default:
					return notAllowed('GET, PUT, DELETE');
			}
		}
		return failure(404, 'No such route');
	}

	return {
		/** Answer one request; undefined when the host took it over (a WebSocket upgrade). */
		async handle(request: Request): Promise<Response | undefined> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expired = new Promise<typeof EXPIRED>((resolve) => {
				timer = setTimeout(() => resolve(EXPIRED), limits.timeout);
			});
			try {
				const session = await Promise.race([authenticate(request), expired]);
				if (session === EXPIRED) return failure(408, 'The request was not authenticated in time');
				if (session === null || lapsed(session)) return failure(401, 'Sign in to use this repository', { 'www-authenticate': 'Bearer' });
				if (!server.mayRead(session)) return failure(403, 'Not a member of this repository');
				return await route(request, session, expired);
			} finally {
				clearTimeout(timer);
			}
		},
		/**
		 * The first message a socket whose session is `verified` gets once
		 * open: `main` now, so a reconnecting device knows whether it missed
		 * anything, and which repository and account the socket is, so a
		 * replica bound elsewhere refuses it.
		 */
		hello: (verified: Verified) => JSON.stringify({ type: 'head', main: server.main(), repository, user: verified.user } satisfies SocketMessage),
		/**
		 * Take one message from a socket whose session is `verified`, replying
		 * on `end`. A message past the body limit is refused unread: a push
		 * is told `request too large` if its request id leads the message, as
		 * the wire client writes it.
		 */
		receive(message: string, verified: Verified, end: SocketEnd) {
			if (message === PING) return end.send(PONG);
			if (lapsed(verified)) return end.close(SESSION_EXPIRED, 'The session expired');
			const reply = (sent: SocketMessage) => end.send(JSON.stringify(sent));
			if (encoder.encode(message).length > limits.body) {
				const rid = /^\{"type":"push","rid":(\d+),/.exec(message)?.[1];
				const answer: PushAnswer = { kind: 'refused', reason: 'request too large', main: server.main() };
				if (rid !== undefined) return reply({ type: 'answer', rid: Number(rid), status: statusOf(answer), answer });
				return reply({ type: 'error', rid: null, status: 413, error: 'The message is larger than the limit' });
			}
			const parsed = trySync({ try: (): unknown => JSON.parse(message), catch: () => BodyError.NotText() });
			if (parsed.error !== null || !Check(SocketRequestSchema, parsed.data)) return reply({ type: 'error', rid: null, status: 400, error: 'Not a socket request' });
			const request = parsed.data;
			switch (request.type) {
				case 'push': {
					holding = [];
					let taken: ReturnType<typeof takeCommit>;
					let held: string[];
					try {
						taken = takeCommit(request.commit, verified);
					} finally {
						held = holding;
						holding = null;
					}
					if ('error' in taken) reply({ type: 'error', rid: request.rid, status: taken.status, error: taken.error });
					else reply({ type: 'answer', rid: request.rid, status: taken.status, answer: taken.answer });
					for (const event of held) sockets.publish(event);
					return;
				}
				case 'catch-up': {
					const { type: _, rid, ...query } = request;
					return reply({ type: 'caught-up', rid, catchUp: takeCatchUp(query) });
				}
				default:
					return request satisfies never;
			}
		},
		/** Stop publishing the server's commits to the sockets. */
		close: unsubscribe,
	};
}
export type Wire = ReturnType<typeof createWire>;

/** An authenticator for development and tests: `Authorization: Bearer <token>`, looked up. */
export function authenticateBearer(lookup: (token: string) => Session | null): Authenticate {
	return (request) => {
		const header = request.headers.get('authorization');
		const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
		return token === '' ? null : lookup(token);
	};
}
