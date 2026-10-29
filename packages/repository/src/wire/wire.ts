/**
 * Design B's wire: HTTP for every write and read, and a notification-only
 * WebSocket for the change feed. It is host-agnostic: `createWire` turns a
 * `Request` into a `Response`; the host supplies who is asking (an
 * `Authenticate`) and where feed messages go (a `FeedHub`: Bun's pub/sub in
 * the dev server, a Durable Object's hibernating WebSockets later).
 *
 * One repository, at the root:
 *
 *   POST   /commits          a live commit, as JSON; answered with its PushAnswer
 *   GET    /files/<path>     main's text, its hash as the ETag
 *   PUT    /files/<path>     If-Match: "<hash>", or If-None-Match: * to create: one fast-forward commit on main
 *   DELETE /files/<path>     If-Match: "<hash>": the same, deleting
 *   GET    /catch-up         ?from=<commit>&to=&after=&path=...: one catch-up page
 *   GET    /blobs/<hash>     a text by its Git blob hash: immutable, so cached for good, but never by a shared cache
 *   GET    /feed             a WebSocket: `head` when it opens, then one `commit` per commit on main
 *
 * Every request, reads included, is authenticated first (401 without a
 * session) and must come from a member (403 otherwise, `server.mayRead`).
 * A write's answer is JSON whatever its status: 200 applied, merged or
 * flushed; 409 outcome-unknown; and for a refusal, 428 with no parent (or no
 * precondition), 412 when a fast-forward found main moved (or a file is not
 * at the hash named), with main's texts for the paths it touched, 429 rate,
 * 403 a reader or another author, 413 too large, and 422 anything the door
 * refuses. A request body is capped before it is parsed, and a request not
 * read within `timeout` gets 408.
 *
 * The feed holds no per-socket state: every socket gets every message, and a
 * socket that opens is first told `main`, so a device that reconnects
 * resumes from its last head by catching up over HTTP when the two differ.
 * A socket's `ping` is answered `pong` after everything sent before it (a
 * Durable Object can answer it while hibernating, with an auto-response).
 */
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { type Event, LIMITS, type PushAnswer, type Server, type Session } from '../server/server.js';

// ============================================================================
// Ports and protocol
// ============================================================================

/** Who is asking, as the host verifies it; null when the request carries no valid credential. */
export type Authenticate = (request: Request) => Session | null | Promise<Session | null>;

/** Where the feed's sockets are: the host's side of the change feed. */
export type FeedHub = {
	/**
	 * Accept a WebSocket upgrade from a verified member: Bun's
	 * `server.upgrade`, or a Durable Object's `WebSocketPair` and
	 * `acceptWebSocket`. Undefined when the host took the request over.
	 * Once the socket is open, the host sends it `wire.hello()` first.
	 */
	upgrade(request: Request, session: Session): Response | undefined;
	/** Send one message to every open feed socket. */
	publish(message: string): void;
};

/** A feed message: `main` when a socket opens, then each commit on main with its changed paths and hashes. Never texts. */
export type FeedMessage = { type: 'head'; main: string } | ({ type: 'commit' } & Event);

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
	server,
	authenticate,
	feed,
	limits: given = {},
	clock = () => Date.now(),
}: {
	server: Server;
	authenticate: Authenticate;
	feed: FeedHub;
	limits?: Partial<WireLimits>;
	/** The time a PUT or DELETE commit carries. */
	clock?: () => number;
}) {
	const limits = { ...WIRE_LIMITS, ...given };
	const unsubscribe = server.subscribe((event) => feed.publish(JSON.stringify({ type: 'commit', ...event } satisfies FeedMessage)));

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
		if (parsed.error !== null || !Check(CommitSchema, parsed.data)) return failure(400, 'The body is not a live commit');
		// The schema allows a missing parent only so the door can refuse it in its order (428); nothing else differs from LiveCommit.
		return answer(server.push(parsed.data as LiveCommit, session));
	}

	/** PUT and DELETE: one file, conditional on its hash, as one fast-forward commit on main. */
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
		const pushed = server.push({ id: commitId(commit), ...commit }, session);
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
		const page = server.catchUp({
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
		if (pathname === '/feed') {
			if (method !== 'GET') return notAllowed('GET');
			if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return failure(426, 'The feed is a WebSocket', { upgrade: 'websocket' });
			return feed.upgrade(request, session);
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
				if (session === null) return failure(401, 'Sign in to use this repository', { 'www-authenticate': 'Bearer' });
				if (!server.mayRead(session)) return failure(403, 'Not a member of this repository');
				return await route(request, session, expired);
			} finally {
				clearTimeout(timer);
			}
		},
		/** The first message a feed socket gets once open: `main` now, so a reconnecting device knows whether it missed anything. */
		hello: () => JSON.stringify({ type: 'head', main: server.main() } satisfies FeedMessage),
		/** Stop publishing the server's commits to the feed. */
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
