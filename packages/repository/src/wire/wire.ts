/**
 * The repository's wire. A device keeps one WebSocket: it sends its commits and
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
 *   POST   /tickets          a one-use ticket for the socket, for a client that cannot set its headers
 *   POST   /commits          a live commit, as JSON; answered with its PushAnswer
 *   GET    /files/<path>     main's text, its hash as the ETag, and the commit it was read at as Epicenter-Commit
 *   PUT    /files/<path>     If-Match: "<hash>", or If-None-Match: * to create: one conditional commit on main
 *   DELETE /files/<path>     If-Match: "<hash>": the same, deleting
 *   GET    /catch-up         ?from=<commit>&to=&after=&path=...: one catch-up page
 *   GET    /blobs/<hash>     a text by its Git blob hash: immutable, so cached for good, but never by a shared cache
 *   POST   /info/lfs/objects/batch   Git LFS basic-transfer actions and per-object errors
 *   PUT    /lfs/objects/<oid>        stream, verify, and record server-side object bytes
 *   GET    /lfs/objects/<oid>        stream immutable object bytes to a member
 *
 * Every request, reads included, is authenticated first (401 without a
 * session, or with one that has expired) and must come from a member (403
 * otherwise, `server.mayRead`). Reads (catch-up pages, files, texts by
 * hash, at a small part of a read each) come out of the member's read
 * bucket (`server.admitRead`): past it, 429 with `retry-after`. A write's answer is JSON whatever its
 * status: 200 applied, merged or flushed; 409 outcome-unknown; 422 a text
 * the door refuses (`refused`, naming its path); and for a request
 * rejection (`rejected`, by its code), 428 with no parent (or no
 * precondition), 412 when a file is not at the hash named, with main's text
 * for it, 429 rate,
 * 403 a reader or another author, 413 too large, and 422 a malformed one.
 * A one-shot client that wants its write merged, not refused because the
 * file moved, reads the file, then posts a commit whose parent is the
 * `Epicenter-Commit` the read named. A request body is capped
 * before it is parsed, and a request body has `timeout` plus its declared
 * length divided by `minRate` to finish or gets 408.
 *
 * The socket is authenticated when it connects, and the host closes it
 * (4401) when the session expires. A browser cannot set a WebSocket's
 * headers, so it asks for a ticket first: `POST /tickets`, authenticated
 * like any request, answers `{ ticket, expires }`, and the socket connects
 * as `/socket?ticket=<ticket>`. A ticket opens one socket, within
 * `limits.ticket` ms, as the session that asked for it: it is gone once
 * presented, whatever the outcome, and a request that also carries another
 * account's credential is refused (401). Up, a device sends `push` and `catch-up`
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
import type { Sizing } from '../client/replica.js';
import { commitId, type LiveCommit } from '../core/commit.js';
import { gitBlobHash } from '../core/hash.js';
import { LFS_OID, type LfsStore } from '../server/lfs-store.js';
import {
	type CatchUp,
	type Event,
	type Expect,
	LIMITS,
	type PushAnswer,
	type RequestCode,
	rejection,
	type Server,
	type Session,
} from '../server/server.js';

// ============================================================================
// Ports and protocol
// ============================================================================

/** A session as the host verified it, with when it expires (ms since the epoch), if it does. Its user is the account it is signed in as. */
export type Verified = Session & { expires?: number };

/** Who is asking, as the host verifies it; null when the request carries no valid credential. */
export type Authenticate = (
	request: Request,
) => Verified | null | Promise<Verified | null>;

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
export type SocketEnd = {
	send(message: string): void;
	close(code: number, reason: string): void;
};

/** The query of one catch-up page, from either transport. */
export type CatchUpQuery = Parameters<Server['catchUp']>[0];

/** What a device sends on its socket; `rid` is its own request id, named in the reply. */
export type SocketRequest =
	| { type: 'push'; rid: number; commit: LiveCommit }
	| ({ type: 'catch-up'; rid: number } & CatchUpQuery);

/** What a socket carries down: main when it opens, each commit on main (never texts), and the replies to its own requests. */
export type SocketMessage =
	/**
	 * The repository this socket reaches, the server's stable id and the
	 * session's user (the account it is signed in as, whom its commits
	 * name), so a replica bound elsewhere refuses it; and the bounds on one
	 * push.
	 */
	| {
			type: 'head';
			main: string;
			repository: string;
			server: string;
			user: string;
			limits: Sizing;
	  }
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
	/** The slowest a request body may arrive, in bytes a second: its deadline is `timeout` plus its declared length at this rate. */
	minRate: number;
	/** Milliseconds a socket ticket can be presented after it is issued. */
	ticket: number;
};

/** The Git LFS batch API's media type. */
const LFS_MEDIA = 'application/vnd.git-lfs+json';

export const WIRE_LIMITS: WireLimits = {
	body: LIMITS.request,
	timeout: 10_000,
	minRate: 1024 * 1024,
	ticket: 30_000,
};

/** What `POST /tickets` answers: the ticket, and when it lapses (ms since the epoch). */
export type Ticket = { ticket: string; expires: number };

/** The header a plain HTTP writer names its device in; `http` without it. */
export const DEVICE_HEADER = 'epicenter-device';

/** The header a file read names the commit it read in: the parent for a merging `POST /commits`. */
export const COMMIT_HEADER = 'epicenter-commit';

/** A live commit as it may arrive; a missing parent is the door's to refuse (428). */
const CommitSchema = Type.Object(
	{
		id: Type.String(),
		parent: Type.Optional(Type.String()),
		author: Type.Object(
			{ user: Type.String(), device: Type.String() },
			{ additionalProperties: false },
		),
		time: Type.String(),
		files: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					text: Type.Union([Type.String(), Type.Null()]),
					over: Type.Optional(Type.Union([Type.String(), Type.Null()])),
					rename: Type.Optional(Type.Literal(true)),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const SocketRequestSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal('push'), rid: Type.Number(), commit: Type.Unknown() },
		{ additionalProperties: false },
	),
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

/** The status of a request rejection, by code; a text refusal is the door's (422). */
const REJECTED: Record<RequestCode, number> = {
	'no-session': 401,
	'not-member': 403,
	reader: 403,
	'not-author': 403,
	'no-parent': 428,
	'no-precondition': 428,
	'file-moved': 412,
	rate: 429,
	'too-large': 413,
	'too-many-files': 413,
	'bad-id': 422,
	'bad-time': 422,
	'path-twice': 422,
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
			return 422;
		case 'rejected':
			return REJECTED[answer.code];
		default:
			return answer satisfies never;
	}
}

/** Any of the strong entity tags in an `If-Match` or `If-None-Match` header is this hash, or the header is `*`. */
function matches(header: string, hash: string | null) {
	if (header.trim() === '*') return hash !== null;
	return (
		hash !== null && header.split(',').some((tag) => tag.trim() === `"${hash}"`)
	);
}

const EXPIRED = Symbol('expired');
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Read a body of at most `cap` bytes, as UTF-8, before `expired` settles. */
async function readBody(
	request: Request,
	cap: number,
	expired: Promise<typeof EXPIRED>,
): Promise<Result<string, BodyError>> {
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
	const { data, error } = trySync({
		try: () => decoder.decode(bytes),
		catch: () => BodyError.NotText(),
	});
	if (error !== null) return Err(error);
	return Ok(data);
}

const NO_STORE = { 'cache-control': 'no-store' };
/** A text named by its hash never changes: a browser keeps it for good; a shared cache never does, because every read is authorized. */
const IMMUTABLE = { 'cache-control': 'private, max-age=31536000, immutable' };

const json = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const failure = (
	status: number,
	error: string,
	headers: Record<string, string> = {},
) => json(status, { error }, headers);

// ============================================================================
// The wire
// ============================================================================

export function createWire({
	repository,
	serverId,
	server,
	authenticate,
	sockets,
	lfs,
	limits: given = {},
	clock = () => Date.now(),
}: {
	/** The repository's id, as the host names it: a replica records it and refuses a socket that names another. */
	repository: string;
	/** The server's stable id, as the host names it (the hosted service, or a self-hosted install): a replica binds to it. */
	serverId: string;
	server: Server;
	lfs: LfsStore;
	authenticate: Authenticate;
	sockets: SocketHub;
	limits?: Partial<WireLimits>;
	/** The time against which a session expires. */
	clock?: () => number;
}) {
	const limits = { ...WIRE_LIMITS, ...given };
	const lfsJson = (status: number, value: unknown) =>
		json(status, value, { 'content-type': LFS_MEDIA });
	/** Events of a commit taken from a socket wait here until its answer is sent, so the device hears its answer first. */
	let holding: string[] | null = null;
	const unsubscribe = server.subscribe((event) => {
		const message = JSON.stringify({
			type: 'commit',
			...event,
		} satisfies SocketMessage);
		if (holding === null) sockets.publish(message);
		else holding.push(message);
	});
	const lapsed = (verified: Verified) =>
		verified.expires !== undefined && verified.expires <= clock();

	/** Socket tickets not yet presented, by ticket. One repository's tickets live with its wire, as its sockets do. */
	const tickets = new Map<string, { verified: Verified; expires: number }>();

	function issueTicket(verified: Verified) {
		for (const [ticket, issued] of tickets)
			if (issued.expires <= clock()) tickets.delete(ticket);
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const ticket = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, '0'),
		).join('');
		const expires = clock() + limits.ticket;
		tickets.set(ticket, { verified, expires });
		return json(200, { ticket, expires } satisfies Ticket);
	}

	/**
	 * The session a socket ticket stands for, or why it stands for none. A
	 * ticket is spent once presented, so a replayed one finds nothing.
	 */
	async function redeemTicket(
		request: Request,
		ticket: string,
	): Promise<Verified | string> {
		const issued = tickets.get(ticket);
		tickets.delete(ticket);
		if (issued === undefined) return 'This ticket is unknown or already used';
		if (issued.expires <= clock()) return 'This ticket has expired';
		if (lapsed(issued.verified))
			return 'The session behind this ticket has expired';
		// A request that names an account of its own must name the ticket's.
		const other = await authenticate(request);
		if (other !== null && other.user !== issued.verified.user)
			return "This ticket belongs to another account's session";
		return issued.verified;
	}

	/**
	 * Take one commit, from either transport: its answer and that answer's
	 * status, or why the value is not a live commit.
	 */
	function takeCommit(
		value: unknown,
		session: Session,
		expect?: Expect,
	): { status: number; answer: PushAnswer } | { status: 400; error: string } {
		if (!Check(CommitSchema, value))
			return { status: 400, error: 'Not a live commit' };
		// The schema allows a missing parent only so the door can refuse it in its order (428); nothing else differs from LiveCommit.
		const answer = server.push(
			value as LiveCommit,
			session,
			expect === undefined ? {} : { expect },
		);
		return { status: statusOf(answer), answer };
	}

	/** One catch-up page, from either transport. */
	const takeCatchUp = (query: CatchUpQuery) => server.catchUp(query);

	const answer = (pushed: PushAnswer, headers: Record<string, string> = {}) =>
		json(
			statusOf(pushed),
			pushed,
			statusOf(pushed) === 429 ? { 'retry-after': '1', ...headers } : headers,
		);
	const rejected = (code: RequestCode) =>
		answer(rejection(code, server.main()));

	/** A body that could not be read: too large is the commit's refusal, so its writer holds it; the rest are the request's. */
	function unread(error: BodyError) {
		switch (error.name) {
			case 'TooLarge':
				return rejected('too-large');
			case 'TimedOut':
				return failure(408, error.message);
			case 'NotText':
				return failure(400, error.message);
			default:
				return error satisfies never;
		}
	}

	async function postCommit(
		request: Request,
		session: Session,
		expired: Promise<typeof EXPIRED>,
	) {
		const { data: body, error } = await readBody(request, limits.body, expired);
		if (error !== null) return unread(error);
		const parsed = trySync({
			try: (): unknown => JSON.parse(body),
			catch: () => BodyError.NotText(),
		});
		if (parsed.error !== null) return failure(400, 'The body is not JSON');
		const taken = takeCommit(parsed.data, session);
		return 'error' in taken ? failure(400, taken.error) : answer(taken.answer);
	}

	/**
	 * PUT and DELETE: one file, conditional on its hash, as one commit on
	 * `main`, taken like any other. The condition is HTTP's conditional
	 * write: checked inside the push, against the file in `main`'s spelling
	 * of the path, it is the one text write refused because of someone
	 * else's write. A one-shot client that wants merging posts a commit
	 * instead (`POST /commits`), on the commit a read named.
	 */
	async function writeFile(
		request: Request,
		session: Session,
		path: string,
		expired: Promise<typeof EXPIRED>,
	) {
		const ifMatch = request.headers.get('if-match');
		const create =
			request.method === 'PUT' &&
			request.headers.get('if-none-match')?.trim() === '*';
		if (ifMatch === null && !create) return rejected('no-precondition');
		let text: string | null = null;
		if (request.method === 'PUT') {
			const { data, error } = await readBody(request, limits.body, expired);
			if (error !== null) return unread(error);
			text = data;
		}
		// The server checks the condition inside the push, against the file in main's spelling of the path.
		const tags = ifMatch?.split(',').map((tag) => tag.trim());
		const is: Expect['is'] =
			ifMatch === null
				? 'absent'
				: ifMatch.trim() === '*'
					? 'present'
					: (tags ?? [])
							.filter((tag) => /^"[0-9a-f]{40}"$/.test(tag))
							.map((tag) => tag.slice(1, -1));
		const commit = {
			parent: server.main(),
			author: {
				user: session.user,
				device: request.headers.get(DEVICE_HEADER) ?? 'http',
			},
			time: server.time(),
			files: [{ path, text }],
		};
		const taken = takeCommit({ id: commitId(commit), ...commit }, session, {
			path,
			is,
		});
		if ('error' in taken) return failure(400, taken.error);
		const pushed = taken.answer;
		return answer(
			pushed,
			pushed.kind === 'applied' && text !== null
				? { etag: `"${gitBlobHash(text)}"` }
				: {},
		);
	}

	/** A file's text on `main`, and the commit it was read at, from one synchronous read. */
	function readFile(request: Request, path: string) {
		const text = server.read(path);
		if (text === null) return failure(404, 'No such file on main');
		const etag = `"${gitBlobHash(text)}"`;
		const headers = {
			etag,
			[COMMIT_HEADER]: server.main(),
			'cache-control': 'private, no-cache',
		};
		if (matches(request.headers.get('if-none-match') ?? '', gitBlobHash(text)))
			return new Response(null, { status: 304, headers });
		return new Response(text, {
			headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
		});
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
		const text = /^[0-9a-f]{40}$/.test(hash)
			? server.fetch([hash])[hash]
			: undefined;
		if (text === undefined) return failure(404, 'No text has this hash');
		const headers = { ...IMMUTABLE, etag: `"${hash}"` };
		if (matches(request.headers.get('if-none-match') ?? '', hash))
			return new Response(null, { status: 304, headers });
		return new Response(text, {
			headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' },
		});
	}

	// ------------------------------------------------------------------------
	// Git LFS: the batch API (basic transfer, SHA-256), and the bytes themselves
	// ------------------------------------------------------------------------

	type LfsAction = { href: string; header?: Record<string, string> };
	type LfsObject = {
		oid: string;
		size: number;
		actions?: Record<string, LfsAction>;
		error?: { code: number; message: string };
	};
	const isLfsObject = (
		value: unknown,
	): value is { oid: string; size: number } =>
		typeof value === 'object' &&
		value !== null &&
		'oid' in value &&
		typeof value.oid === 'string' &&
		LFS_OID.test(value.oid) &&
		'size' in value &&
		typeof value.size === 'number' &&
		Number.isSafeInteger(value.size) &&
		value.size >= 0;
	/** An action on this server's copy of `oid`, carrying the asker's credential so a Git client can follow it. */
	const actionOn = (request: Request, oid: string): LfsAction => {
		const authorization = request.headers.get('authorization');
		return {
			href: new URL(`/lfs/objects/${oid}`, request.url).href,
			header: authorization === null ? {} : { authorization },
		};
	};
	const SIZE_DISAGREES = {
		code: 422,
		message: 'Object size disagrees with stored bytes',
	};

	/**
	 * Whether the server holds `oid` at `size`: by its presence record, or by
	 * bytes already on its byte store (a crash between storing and recording),
	 * which it then records. A size that disagrees with what is held is an error.
	 */
	async function held(
		oid: string,
		size: number,
	): Promise<boolean | typeof SIZE_DISAGREES> {
		const recorded = server.uploaded(oid);
		if (recorded !== null) return recorded === size || SIZE_DISAGREES;
		const stored = await lfs.get(oid);
		if (stored === null) return false;
		await stored.body.cancel().catch(() => {});
		if (stored.size !== size) return SIZE_DISAGREES;
		server.upload(oid, size);
		return true;
	}

	/**
	 * `POST /info/lfs/objects/batch` (git-lfs docs/api/batch.md). Upload:
	 * bytes held get no actions; bytes refused get a per-object error (422
	 * past the blob limit; 507, the spec's code for insufficient storage,
	 * past the quota, per object so one batch can mix answers); the rest get
	 * an `upload` action here. Download: a `download` action, or 404.
	 */
	async function lfsBatch(
		request: Request,
		session: Session,
		expired: Promise<typeof EXPIRED>,
	) {
		if (
			!request.headers.get('content-type')?.toLowerCase().startsWith(LFS_MEDIA)
		)
			return lfsJson(415, { message: 'Expected Git LFS JSON' });
		const { data: text, error } = await readBody(request, limits.body, expired);
		if (error !== null) return unread(error);
		const parsed = trySync({
			try: (): unknown => JSON.parse(text),
			catch: () => BodyError.NotText(),
		});
		if (parsed.error !== null)
			return lfsJson(400, { message: 'The body is not JSON' });
		const input = parsed.data as {
			operation?: unknown;
			objects?: unknown;
			transfers?: unknown;
			hash_algo?: unknown;
		} | null;
		if (
			typeof input !== 'object' ||
			input === null ||
			(input.operation !== 'upload' && input.operation !== 'download') ||
			!Array.isArray(input.objects) ||
			!input.objects.every(isLfsObject)
		)
			return lfsJson(422, { message: 'Invalid batch request' });
		if (
			input.transfers !== undefined &&
			(!Array.isArray(input.transfers) || !input.transfers.includes('basic'))
		)
			return lfsJson(422, { message: 'Only basic transfer is supported' });
		const asked = input.objects as { oid: string; size: number }[];
		if (input.hash_algo !== undefined && input.hash_algo !== 'sha256')
			return lfsJson(200, {
				transfer: 'basic',
				hash_algo: 'sha256',
				objects: asked.map(({ oid, size }) => ({
					oid,
					size,
					error: { code: 409, message: 'Only SHA-256 is supported' },
				})),
			});
		if (input.operation === 'upload' && session.role === 'reader')
			return lfsJson(403, { message: 'A reader may not upload' });
		const objects: LfsObject[] = [];
		for (const { oid, size } of asked) {
			if (input.operation === 'download') {
				objects.push(
					server.uploaded(oid) === size
						? { oid, size, actions: { download: actionOn(request, oid) } }
						: {
								oid,
								size,
								error: { code: 404, message: 'Object does not exist' },
							},
				);
				continue;
			}
			const here = await held(oid, size);
			if (here === true) objects.push({ oid, size });
			else if (here !== false) objects.push({ oid, size, error: here });
			else {
				const refusal = server.uploadRefusal(oid, size);
				if (refusal === null)
					objects.push({
						oid,
						size,
						actions: { upload: actionOn(request, oid) },
					});
				else
					objects.push({
						oid,
						size,
						error:
							refusal === 'too-large'
								? { code: 422, message: 'Object is too large' }
								: { code: 507, message: 'Insufficient storage capacity' },
					});
			}
		}
		return lfsJson(200, { transfer: 'basic', hash_algo: 'sha256', objects });
	}

	/**
	 * `PUT /lfs/objects/<oid>` with its `Content-Length`: the body streams
	 * into the byte store, which keeps only bytes that are `oid` at that
	 * length, and presence is recorded only once they are durable there.
	 */
	async function lfsPut(
		request: Request,
		session: Session,
		oid: string,
		signal: AbortSignal,
	) {
		if (session.role === 'reader')
			return failure(403, 'A reader may not upload');
		if (!LFS_OID.test(oid)) return failure(404, 'No such object');
		const declared = request.headers.get('content-length');
		if (declared === null) return failure(411, 'Content-Length is required');
		const size = Number(declared);
		if (!Number.isSafeInteger(size) || size < 0)
			return failure(400, 'Invalid Content-Length');
		const here = await held(oid, size);
		if (here !== true && here !== false)
			return failure(here.code, here.message);
		const refusal = here ? null : server.uploadRefusal(oid, size);
		if (refusal !== null)
			return failure(
				refusal === 'too-large' ? 413 : 507,
				refusal === 'too-large'
					? 'Object is too large'
					: 'Insufficient storage capacity',
			);
		const source =
			request.body ??
			new ReadableStream<Uint8Array>({
				start: (controller) => controller.close(),
			});
		// The request's deadline cuts the stream, so a stalled upload stores nothing.
		const result = await lfs.put(
			oid,
			size,
			source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
				signal,
			}),
		);
		if (result.error !== null)
			return failure(
				signal.aborted ? 408 : result.error.name === 'Mismatch' ? 422 : 500,
				result.error.message,
			);
		server.upload(oid, size);
		return new Response(null, { status: 200, headers: NO_STORE });
	}

	/** `GET /lfs/objects/<oid>`: bytes the server holds, immutable. */
	async function lfsGet(oid: string) {
		if (!LFS_OID.test(oid)) return failure(404, 'No such object');
		const item = await lfs.get(oid);
		if (item === null) return failure(404, 'No such object');
		if (server.uploaded(oid) !== item.size) {
			await item.body.cancel().catch(() => {});
			return failure(404, 'No such object');
		}
		return new Response(item.body, {
			headers: {
				...IMMUTABLE,
				'content-length': String(item.size),
				'content-type': 'application/octet-stream',
			},
		});
	}

	const notAllowed = (allow: string) =>
		failure(405, 'Method not allowed', { allow });
	const SLOW_DOWN = 'Too many reads; slow down';
	/** A read out of the member's read bucket: undefined when admitted, otherwise the 429. */
	const throttled = (session: Session, kind: 'read' | 'text' = 'read') =>
		server.admitRead(session, kind)
			? undefined
			: failure(429, SLOW_DOWN, { 'retry-after': '1' });

	function upgrade(request: Request, session: Verified) {
		if (request.method !== 'GET') return notAllowed('GET');
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
			return failure(426, 'The socket is a WebSocket', {
				upgrade: 'websocket',
			});
		return sockets.upgrade(request, session);
	}

	/** Who is asking: the ticket's session for a socket that presents one, otherwise the host's credential. */
	async function sessionOf(request: Request): Promise<Verified | string> {
		const url = new URL(request.url);
		const ticket =
			url.pathname === '/socket' ? url.searchParams.get('ticket') : null;
		if (ticket !== null) return redeemTicket(request, ticket);
		const session = await authenticate(request);
		return session === null || lapsed(session)
			? 'Sign in to use this repository'
			: session;
	}

	async function route(
		request: Request,
		session: Verified,
		expired: Promise<typeof EXPIRED>,
		signal: AbortSignal,
	): Promise<Response | undefined> {
		const url = new URL(request.url);
		const { pathname } = url;
		const { method } = request;
		if (pathname === '/info/lfs/objects/batch')
			return method === 'POST'
				? lfsBatch(request, session, expired)
				: notAllowed('POST');
		if (pathname.startsWith('/lfs/objects/')) {
			const oid = pathname.slice('/lfs/objects/'.length);
			if (method === 'PUT') return lfsPut(request, session, oid, signal);
			if (method === 'GET') return throttled(session) ?? lfsGet(oid);
			return notAllowed('GET, PUT');
		}
		if (pathname === '/commits')
			return method === 'POST'
				? postCommit(request, session, expired)
				: notAllowed('POST');
		if (pathname === '/tickets')
			return method === 'POST' ? issueTicket(session) : notAllowed('POST');
		if (pathname === '/catch-up')
			return method === 'GET'
				? (throttled(session) ?? catchUp(url))
				: notAllowed('GET');
		if (pathname === '/socket') return upgrade(request, session);
		if (pathname.startsWith('/blobs/'))
			return method === 'GET'
				? (throttled(session, 'text') ??
						readBlob(request, pathname.slice('/blobs/'.length)))
				: notAllowed('GET');
		if (pathname.startsWith('/files/')) {
			const path = trySync({
				try: () => decodeURIComponent(pathname.slice('/files/'.length)),
				catch: () => BodyError.NotText(),
			});
			if (path.error !== null || path.data === '')
				return failure(400, 'Not a file path');
			switch (method) {
				case 'GET':
					return throttled(session) ?? readFile(request, path.data);
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
			const deadline = new AbortController();
			const length = Number(request.headers.get('content-length') ?? 0);
			const duration =
				limits.timeout +
				Math.ceil(
					(Math.max(0, Number.isFinite(length) ? length : 0) / limits.minRate) *
						1000,
				);
			const expired = new Promise<typeof EXPIRED>((resolve) => {
				timer = setTimeout(() => {
					deadline.abort();
					resolve(EXPIRED);
				}, duration);
			});
			try {
				const session = await Promise.race([sessionOf(request), expired]);
				if (session === EXPIRED)
					return failure(408, 'The request was not authenticated in time');
				if (typeof session === 'string')
					return failure(401, session, { 'www-authenticate': 'Bearer' });
				if (!server.mayRead(session))
					return failure(403, 'Not a member of this repository');
				return await route(request, session, expired, deadline.signal);
			} finally {
				clearTimeout(timer);
			}
		},
		/**
		 * The first message a socket whose session is `verified` gets once
		 * open: `main` now, so a reconnecting device knows whether it missed
		 * anything, and which repository, server and account the socket is,
		 * so a replica bound elsewhere refuses it.
		 */
		hello: (verified: Verified) =>
			JSON.stringify({
				type: 'head',
				main: server.main(),
				repository,
				server: serverId,
				user: verified.user,
				limits: server.sizing(),
			} satisfies SocketMessage),
		/**
		 * Take one message from a socket whose session is `verified`, replying
		 * on `end`. A message past the body limit is refused unread: a push
		 * is told `request too large` if its request id leads the message, as
		 * the wire client writes it.
		 */
		receive(message: string, verified: Verified, end: SocketEnd) {
			if (message === PING) return end.send(PONG);
			if (lapsed(verified))
				return end.close(SESSION_EXPIRED, 'The session expired');
			const reply = (sent: SocketMessage) => end.send(JSON.stringify(sent));
			if (encoder.encode(message).length > limits.body) {
				const rid = /^\{"type":"push","rid":(\d+),/.exec(message)?.[1];
				const answer = rejection('too-large', server.main());
				if (rid !== undefined)
					return reply({
						type: 'answer',
						rid: Number(rid),
						status: statusOf(answer),
						answer,
					});
				return reply({
					type: 'error',
					rid: null,
					status: 413,
					error: 'The message is larger than the limit',
				});
			}
			const parsed = trySync({
				try: (): unknown => JSON.parse(message),
				catch: () => BodyError.NotText(),
			});
			if (parsed.error !== null || !Check(SocketRequestSchema, parsed.data))
				return reply({
					type: 'error',
					rid: null,
					status: 400,
					error: 'Not a socket request',
				});
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
					if ('error' in taken)
						reply({
							type: 'error',
							rid: request.rid,
							status: taken.status,
							error: taken.error,
						});
					else
						reply({
							type: 'answer',
							rid: request.rid,
							status: taken.status,
							answer: taken.answer,
						});
					for (const event of held) sockets.publish(event);
					return;
				}
				case 'catch-up': {
					const { type: _, rid, ...query } = request;
					if (!server.admitRead(verified))
						return reply({ type: 'error', rid, status: 429, error: SLOW_DOWN });
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
export function authenticateBearer(
	lookup: (token: string) => Verified | null,
): Authenticate {
	return (request) => {
		const header = request.headers.get('authorization');
		const token = header?.startsWith('Bearer ')
			? header.slice('Bearer '.length).trim()
			: '';
		return token === '' ? null : lookup(token);
	};
}
