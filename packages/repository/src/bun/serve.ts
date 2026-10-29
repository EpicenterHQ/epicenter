/**
 * The Bun host of design B's wire: one repository's server over HTTP and the
 * devices' sockets, on a port of this machine. Events go out by Bun's
 * pub/sub: every socket subscribes to one topic when it opens, and keeps
 * only its verified session (and the timer that closes it when the session
 * expires). For development and tests; the hosted server is a Durable
 * Object (phase 10).
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Server as BunServer } from 'bun';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { openServer, type Server } from '../server/server.js';
import { type Authenticate, createWire, SESSION_EXPIRED, type Verified, type WireLimits } from '../wire/wire.js';
import { openBunGitStore } from './git.js';
import { openBunSqlite } from './sqlite.js';

const EVENTS = 'events';

type SocketData = { verified: Verified; expiry?: ReturnType<typeof setTimeout> };

const ServeError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({ message: 'A request failed on the repository server', cause }),
});

/** Serve `server` over the wire on `hostname:port` (0 picks a free port). */
export function serveRepository({
	repository,
	server,
	authenticate,
	hostname = '127.0.0.1',
	port = 0,
	limits,
	log = createLogger('repository/serve'),
}: {
	/** The repository's id, which every socket's hello names. */
	repository: string;
	server: Server;
	authenticate: Authenticate;
	hostname?: string;
	port?: number;
	limits?: Partial<WireLimits>;
	log?: Logger;
}) {
	let bun: BunServer<SocketData> | undefined;
	const wire = createWire({
		repository,
		server,
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
		fetch: (request) => wire.handle(request),
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
		timer: (ms, run) => {
			setTimeout(run, ms);
		},
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
