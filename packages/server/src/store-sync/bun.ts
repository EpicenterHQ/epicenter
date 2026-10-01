import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	encodeFrame,
	type HubConnection,
	openCurrentAuthority,
	type SyncHub,
} from '@epicenter/app/sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';

type SocketData = {
	name: string;
	generation: number;
	cursor: number;
	authorizedUntil: number;
};
type LiveSocket = {
	close(code?: number, reason?: string): void;
	send(bytes: Uint8Array): void;
	data: SocketData;
};
type Partition = {
	database: Database;
	authority: ReturnType<typeof openCurrentAuthority>;
};

/** One process owns all open Personal partitions below this directory. */
export function openBunStoreSync(root: string) {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const partitions = new Map<string, Partition>();
	const sockets = new Map<
		LiveSocket,
		{ hub: SyncHub; connection: HubConnection }
	>();
	function partition(name: string): Partition {
		const existing = partitions.get(name);
		if (existing) return existing;
		const filename =
			createHash('sha256').update(name).digest('hex') + '.sqlite';
		const database = new Database(join(root, filename), { create: true });
		database.exec('PRAGMA journal_mode = WAL');
		database.exec('PRAGMA busy_timeout = 5000');
		const opened = {
			database,
			authority: openCurrentAuthority({
				sqlite: createBunSqliteAdapter(database),
			}),
		};
		partitions.set(name, opened);
		return opened;
	}
	async function current(name: string, request: Request): Promise<Response> {
		const reader = request.body?.getReader();
		if (!reader) return new Response('A baseline is required', { status: 400 });
		const chunks: Uint8Array[] = [];
		let length = 0;
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 16 * 1024 * 1024) {
				await reader.cancel();
				return new Response('Baseline too large', { status: 413 });
			}
			chunks.push(part.value);
		}
		if (!length) return new Response('A baseline is required', { status: 400 });
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return createCurrentDownloadResponse(
			partition(name).authority.ensureCurrent(bytes),
		);
	}
	function leave(socket: LiveSocket): void {
		const live = sockets.get(socket);
		if (live) live.hub.leave(live.connection);
		sockets.delete(socket);
	}
	const expiration = setInterval(() => {
		for (const socket of sockets.keys())
			if (Date.now() >= socket.data.authorizedUntil) {
				leave(socket);
				socket.close(1008, 'socket authorization expired');
			}
	}, 1000);
	return {
		resolveStore: () => ({
			authority: (name: string) => ({
				fetch: (request: Request) => current(name, request),
			}),
			ledger: () => ({ list: () => [] }),
		}),
		upgrade(name: string, request: Request) {
			const query = new URL(request.url).searchParams;
			const cursor = Number(query.get('cursor') ?? '0');
			if (!Number.isSafeInteger(cursor) || cursor < 0)
				return new Response('Invalid sync address', { status: 400 });
			return new Response(null, {
				headers: { 'x-epicenter-bun-upgrade': name },
			});
		},
		connect(socket: LiveSocket): void {
			const { name, generation, cursor } = socket.data;
			const result = partition(name).authority.createHub(generation);
			if (result.error) {
				if (result.error.name === 'GenerationUnavailable')
					socket.send(encodeFrame({ kind: 'retired' }));
				socket.close(1000, 'generation unavailable');
				return;
			}
			const hub = result.data;
			const connection: HubConnection = {
				cursor,
				send: (bytes) => {
					if (Date.now() < socket.data.authorizedUntil) socket.send(bytes);
				},
			};
			if (hub.join(connection) !== 'admitted') {
				socket.close(1000, 'authority unavailable');
				return;
			}
			sockets.set(socket, { hub, connection });
		},
		receive(socket: LiveSocket, message: string | Buffer | Uint8Array): void {
			if (Date.now() >= socket.data.authorizedUntil) {
				leave(socket);
				socket.close(1008, 'socket authorization expired');
				return;
			}
			if (typeof message === 'string') return;
			const live = sockets.get(socket);
			if (live) live.hub.receive(live.connection, new Uint8Array(message));
		},
		leave,
		close() {
			clearInterval(expiration);
			for (const socket of sockets.keys()) {
				leave(socket);
				socket.close(1001, 'server stopping');
			}
			for (const { database } of partitions.values()) database.close();
			partitions.clear();
		},
	};
}
