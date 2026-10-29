/**
 * The Bun host of design B's wire: one repository's server over HTTP and the
 * change feed, on a port of this machine. The feed is Bun's pub/sub: every
 * socket subscribes to one topic when it opens, so the host keeps nothing
 * per socket either. For development and tests; the hosted server is a
 * Durable Object (phase 10).
 */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Server as BunServer } from 'bun';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { openServer, type Server } from '../server/server.js';
import { type Authenticate, createWire, PING, PONG, type WireLimits } from '../wire/wire.js';
import { openBunGitStore } from './git.js';
import { openBunSqlite } from './sqlite.js';

const FEED = 'feed';

const ServeError = defineErrors({
	RequestFailed: ({ cause }: { cause: unknown }) => ({ message: 'A request failed on the repository server', cause }),
});

/** Serve `server` over the wire on `hostname:port` (0 picks a free port). */
export function serveRepository({
	server,
	authenticate,
	hostname = '127.0.0.1',
	port = 0,
	limits,
	log = createLogger('repository/serve'),
}: {
	server: Server;
	authenticate: Authenticate;
	hostname?: string;
	port?: number;
	limits?: Partial<WireLimits>;
	log?: Logger;
}) {
	let bun: BunServer<undefined> | undefined;
	const wire = createWire({
		server,
		authenticate,
		...(limits === undefined ? {} : { limits }),
		feed: {
			upgrade: (request) => (bun?.upgrade(request, { data: undefined }) ? undefined : new Response('Expected a WebSocket upgrade', { status: 426 })),
			publish: (message) => {
				bun?.publish(FEED, message);
			},
		},
	});
	bun = Bun.serve<undefined>({
		hostname,
		port,
		fetch: (request) => wire.handle(request),
		error(cause) {
			log.error(ServeError.RequestFailed({ cause }));
			return new Response('The repository server failed', { status: 500 });
		},
		websocket: {
			open(socket) {
				// Subscribed and told `main` in one step, so no commit falls between the two.
				socket.subscribe(FEED);
				socket.send(wire.hello());
			},
			message(socket, message) {
				if (message === PING) socket.send(PONG);
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
