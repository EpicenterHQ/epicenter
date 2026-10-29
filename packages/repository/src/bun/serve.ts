/**
 * The Bun host of the repository's wire: one repository's server over HTTP and the
 * devices' sockets, on a port of this machine. Events go out by Bun's
 * pub/sub: every socket subscribes to one topic when it opens, and keeps
 * only its verified session (and the timer that closes it when the session
 * expires). For development and tests; the hosted server is a Durable
 * Object (phase 10).
 *
 * A page served from another origin (an app's dev server, a test site) may
 * call it when its origin is listed in `origins`: requests from it get the
 * CORS headers a browser needs, and its preflights are answered. Sockets
 * need none, and authenticate with a ticket.
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Server as BunServer } from 'bun';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { type Alarm, openServer, type Server } from '../server/server.js';
import type { LfsStore } from '../server/lfs-store.js';
import { createMemoryLfsStore } from '../server/memory-lfs-store.js';
import { type Authenticate, createWire, SESSION_EXPIRED, type Verified, type WireLimits, WIRE_LIMITS } from '../wire/wire.js';
import { openBunGitStore } from './git.js';
import { openBunSqlite } from './sqlite.js';
import { createFileLfsStore } from './lfs-store.js';

const EVENTS = 'events';

/** What a listed origin may send and read across origins. */
const CORS = {
	'access-control-allow-methods': 'GET, POST, PUT, DELETE',
	'access-control-allow-headers': 'authorization, accept, content-type, content-length, if-match, if-none-match, epicenter-device',
	'access-control-expose-headers': 'etag, retry-after, content-length',
	'access-control-max-age': '600',
};

/** `response` with the CORS headers for `origin`. */
function allowOrigin(response: Response, origin: string) {
	const headers = new Headers(response.headers);
	headers.set('access-control-allow-origin', origin);
	headers.append('vary', 'origin');
	for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type SocketData = { verified: Verified; expiry?: ReturnType<typeof setTimeout> };

const ServeError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({ message: 'A request failed on the repository server', cause }),
});

/** Serve `server` over the wire on `hostname:port` (0 picks a free port). */
export function serveRepository({
	repository,
	serverId,
	server,
	lfs,
	dir,
	authenticate,
	hostname = '127.0.0.1',
	port = 0,
	limits,
	origins = [],
	log = createLogger('repository/serve'),
}: {
	/** The repository's id, which every socket's hello names. */
	repository: string;
	/** This server's stable id, which every socket's hello names and a replica binds to. */
	serverId: string;
	server: Server;
	/** Server-side object bytes; defaults to the file store when `dir` is given. */
	lfs?: LfsStore;
	/** The bare repository directory for the default file store. */
	dir?: string;
	authenticate: Authenticate;
	hostname?: string;
	port?: number;
	limits?: Partial<WireLimits>;
	/** Origins whose pages may call the server across origins, such as `http://127.0.0.1:5173`. */
	origins?: string[];
	log?: Logger;
}) {
	let bun: BunServer<SocketData> | undefined;
	const wire = createWire({
		repository,
		serverId,
		server,
		lfs: lfs ?? (dir === undefined ? createMemoryLfsStore() : createFileLfsStore(join(dir, 'epicenter', 'blobs'))),
		authenticate,
		...(limits === undefined ? {} : { limits }),
		sockets: {
			upgrade: (request, verified) => (bun?.upgrade(request, { data: { verified } }) ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 })),
			publish: (message) => {
				bun?.publish(EVENTS, message);
			},
		},
	});
	bun = Bun.serve<SocketData>({
		hostname,
		port,
		maxRequestBodySize: Math.max(server.sizing().blob, limits?.body ?? WIRE_LIMITS.body),
		idleTimeout: 255,
		async fetch(request) {
			const origin = request.headers.get('origin');
			const allowed = origin !== null && origins.includes(origin);
			if (allowed && request.method === 'OPTIONS') return allowOrigin(new Response(null, { status: 204 }), origin);
			const response = await wire.handle(request);
			return response === undefined || !allowed ? response : allowOrigin(response, origin);
		},
		error(cause) {
			log.error(ServeError.RequestFailed({ cause }));
			return new Response('The repository server failed', { status: 500 });
		},
		websocket: {
			open(socket) {
				const { expires } = socket.data.verified;
				if (expires !== undefined) socket.data.expiry = setTimeout(() => socket.close(SESSION_EXPIRED, 'The session expired'), Math.max(0, expires - Date.now()));
				// Subscribed and told `main` in one step, so no commit falls between the two.
				socket.subscribe(EVENTS);
				socket.send(wire.hello(socket.data.verified));
			},
			message(socket, message) {
				wire.receive(typeof message === 'string' ? message : new TextDecoder().decode(message), socket.data.verified, {
					send: (reply) => {
						socket.send(reply);
					},
					close: (code, reason) => socket.close(code, reason),
				});
			},
			close(socket) {
				clearTimeout(socket.data.expiry);
			},
		},
	});
	const served = bun;
	return {
		/** Where the repository is served, such as `http://127.0.0.1:8787/`. */
		url: served.url.href,
		/** Stop serving: close every socket and stop listening. */
		async stop() {
			wire.close();
			await served.stop(true);
		},
	};
}
export type ServedRepository = ReturnType<typeof serveRepository>;

/** The server's alarm on this process's timers: one timeout, replaced on every schedule. */
export const timeoutAlarm = (due: () => void): Alarm => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule(at) {
			clearTimeout(timeout);
			timeout = setTimeout(due, Math.max(0, at - Date.now()));
		},
		cancel() {
			clearTimeout(timeout);
		},
	};
};

/**
 * Open a repository on disk for the dev server: `dir` is a bare Git
 * repository (created when missing) that live history flushes into, and its
 * live history is SQLite in `dir/epicenter/live.sqlite`. Flushes run on the
 * server's schedule with the process's timers.
 */
export async function openDiskRepository(dir: string, { log = createLogger('repository/serve') }: { log?: Logger } = {}) {
	const git = await openBunGitStore(dir);
	await mkdir(join(dir, 'epicenter'), { recursive: true });
	return openServer({
		store: openBunSqlite(join(dir, 'epicenter', 'live.sqlite')),
		git,
		alarm: timeoutAlarm,
		log,
	});
}

/**
 * Bun's WebSocket constructor, which takes headers (a browser's does not).
 * The DOM's declaration hides Bun's overload under this package's
 * tsconfig, so it is named here once.
 */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

/** Open feed sockets that carry `headers`, such as `authorization`: a wire client's `openSocket` in Bun. */
export const socketWithHeaders =
	(headers: Record<string, string>) =>
	(url: string): WebSocket =>
		new BunWebSocket(url, { headers });
