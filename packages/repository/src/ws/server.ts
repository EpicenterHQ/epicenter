/**
 * The Bun side of the WebSocket transport: one `RepositoryServer` over a
 * local bare Git repository, served on a port, so devices on this machine
 * sync through it. For development and tests; the hosted server is a later
 * slice. Who a connection is comes from its `user` parameter, unchecked.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { openBunGitStore } from '../bun/git.js';
import { openBunSqlite } from '../bun/sqlite.js';
import type { OnOverlap } from '../policy.js';
import { createRepositoryServer, type RepositoryServer } from '../server/server.js';
import type { ClientFrame, ServerFrame } from './messages.js';

const WsServerError = defineErrors({
	CallFailed: ({ cause }: { cause: unknown }) => ({ message: 'A device call failed on the server; its connection was closed', cause }),
});

type Connection = ReturnType<RepositoryServer['connect']>;
type Socket = ServerWebSocket<{ user: string; device: string; onOverlap: OnOverlap; connection?: Connection }>;

export type ServeOptions = {
	/** The bare Git repository; created when missing. The overlay's SQLite file lives inside it, under `epicenter/`. */
	dir: string;
	hostname?: string;
	/** 0 picks a free port. */
	port?: number;
	/** How often to commit overlay changes that are due. */
	tickMs?: number;
	/** How old an overlay change is before it is committed. */
	commitAfterMs?: number;
	log?: Logger;
};

export async function serveRepository({
	dir,
	hostname = '127.0.0.1',
	port = 0,
	tickMs = 5_000,
	commitAfterMs,
	log = createLogger('repository/ws-server'),
}: ServeOptions) {
	const git = await openBunGitStore(dir);
	await mkdir(join(dir, 'epicenter'), { recursive: true });
	const repository = createRepositoryServer({ driver: openBunSqlite(join(dir, 'epicenter', 'overlay.sqlite')), git, commitAfterMs, log });
	const sockets = new Set<Socket>();
	const send = (socket: Socket, frame: ServerFrame) => socket.send(JSON.stringify(frame));

	const http = Bun.serve<Socket['data']>({
		hostname,
		port,
		fetch(request, server) {
			const params = new URL(request.url).searchParams;
			const device = params.get('device');
			if (device === null) return new Response('A device connects with ?device=<id>&user=<name>', { status: 400 });
			const data = {
				device,
				user: params.get('user') ?? 'anonymous',
				onOverlap: params.get('onOverlap') === 'refuse' ? ('refuse' as const) : ('mark' as const),
			};
			if (server.upgrade(request, { data })) return undefined;
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				const { device, user, onOverlap } = socket.data;
				socket.data.connection = repository.connect({
					device,
					user,
					onOverlap,
					onBroadcast: (broadcast) => send(socket, { type: 'broadcast', broadcast }),
				});
			},
			async message(socket, raw) {
				const connection = socket.data.connection;
				if (connection === undefined) return;
				const frame = JSON.parse(String(raw)) as ClientFrame;
				try {
					const value = frame.type === 'hello' ? await connection.hello(frame.seq) : await connection.push(frame.batch);
					send(socket, { type: 'reply', id: frame.id, value });
				} catch (cause) {
					// A server fault: drop the connection so the device retries from its outbox.
					log.error(WsServerError.CallFailed({ cause }));
					socket.close(1011);
				}
			},
			close(socket) {
				sockets.delete(socket);
				socket.data.connection?.close();
			},
		},
	});

	const timer = setInterval(() => {
		void repository.tick().then((result) => {
			if (result.error !== null) log.warn(result.error);
		});
	}, tickMs);

	return {
		/** `ws://host:port/`; devices add `?user=<name>`. */
		url: `ws://${http.hostname}:${http.port}/`,
		repository,
		/** Stop serving; connected devices see the server go away and retry. */
		async stop() {
			clearInterval(timer);
			for (const socket of sockets) socket.close();
			await http.stop(true);
		},
	};
}
