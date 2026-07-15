/**
 * In-process {@link Rooms} for a single Bun host, the Road-2 backend a
 * self-host or Tauri shell binds instead of the Cloudflare Durable Object
 * (ADR-0066). One `RoomCore` per room lives in a `Map`; a `bun:sqlite` file
 * per room persists its update log. A single process is always the one writer
 * for every room it holds, so it needs neither the DO's single-writer
 * guarantee nor its hibernation restore (the connection set never gets wiped).
 *
 * ## The WebSocket-upgrade impedance
 *
 * Cloudflare returns a 101 `Response` from `fetch`; Bun cannot. Bun upgrades
 * by calling `server.upgrade(request, { data })` (which returns a boolean and
 * emits the 101 itself) and then delivers the live socket to the top-level
 * `websocket` handler. So this backend splits {@link ResolvedRoom.handleUpgrade}
 * across two points that share one `Map`:
 *
 *   - `rooms.get(name).handleUpgrade(...)` calls `server.upgrade`, passing the
 *     resolved identity as `ws.data` and ensuring the room exists so the
 *     accept handler can find it.
 *   - {@link createBunRooms.websocket}'s `open`/`message`/`close` drive the
 *     matching `RoomCore` resolved from `ws.data.roomName`.
 *
 * The `server` instance only exists after `Bun.serve(...)` returns, so the
 * entry calls {@link createBunRooms.bindServer} once before serving traffic.
 *
 * ## Eviction
 *
 * When a room's last socket closes, a grace timer compacts the log and closes
 * the sqlite handle, evicting the room from the `Map` (any access, i.e. a
 * connecting socket, cancels it first via `getOrCreate`). A truncate-checkpoint runs
 * before close so the WAL sidecars do not persist (the macOS persistent-WAL
 * caveat); keep `dir` on a local disk, never a networked filesystem.
 *
 * ## Connection lifetime
 *
 * The 30-minute connection-lifetime bound is a `RoomCore` invariant, not a
 * backend detail: `handleMessage` re-checks every active socket, and a
 * process-wide timer drives `core.sweepExpiredConnections` for silent ones, so
 * a socket cannot outlive its bearer here any more than it can behind the
 * Durable Object.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { sanitizeUpgradeSubprotocols } from '../../../sanitize-upgrade-subprotocols.js';
import type {
	ResolvedRoom,
	RoomSocketAuth,
	Rooms,
	RoomUpgrade,
} from '../../contracts.js';
import { createRoomCore, type RoomCore } from '../../core.js';
import { createBunSqliteUpdateLog } from './update-log.js';

/**
 * Grace window between a room's last socket closing and its eviction
 * (compact + close + drop from the `Map`). Mirrors the Cloudflare backend's
 * 30 s post-empty compaction delay.
 */
const EVICTION_GRACE_MS = 30_000;

/**
 * Cadence of the idle-socket lifetime sweep (5 minutes). The per-message check
 * in {@link RoomCore.handleMessage} bounds an active socket; this sweep drives
 * {@link RoomCore.sweepExpiredConnections} to also bound a silent one held open
 * past token expiry.
 */
const CONNECTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * The unreachable wiring-bug branch: a WebSocket op arrived before `bindServer`
 * ran, so there is no `Server` to `upgrade` on. `bindServer` runs synchronously
 * after `Bun.serve` returns, before any request, so this never fires in a
 * correctly-wired entry; it exists only to keep `server` honestly nullable.
 */
function serverNotBound(): Promise<Response> {
	return Promise.resolve(
		new Response('room server not bound', { status: 500 }),
	);
}

/**
 * Per-connection data Bun carries on `ws.data`, set at `server.upgrade` and
 * read back in the `websocket` handler.
 *
 * Discriminated by `kind`: a `room` socket carries the `roomName` the handler
 * resolves a `RoomCore` from, plus the resolved identity its {@link Connection}
 * attachment is built from; a `reject` socket carries only the app close
 * code/reason its `open` handler fires immediately (the auth layer rejecting a
 * WebSocket upgrade through {@link Rooms.rejectUpgrade}). The `surface` tag lets
 * {@link mergeBunWebSocketHandlers} route this socket to the rooms backend when
 * it shares one `Bun.serve` with the attach relay; it is a server-side dispatch
 * discriminant, never a wire field.
 */
export type BunRoomSocketData = { surface: 'rooms' } & (
	| { kind: 'room'; roomName: string }
	| { kind: 'reject'; code: number; reason: string }
);

/** A live room: its core, its open sqlite handle, and any pending eviction. */
type RoomEntry = {
	name: string;
	core: RoomCore;
	db: Database;
	evictionTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Build an in-process room registry rooted at `dir` (one sqlite file per
 * room). Returns the {@link Rooms} the deployment passes to `resolveRooms`,
 * the `websocket` handler it passes to `Bun.serve`, and `bindServer` to hand
 * back the `Server` once `Bun.serve` returns.
 */
export function createBunRooms({ dir }: { dir: string }): {
	rooms: Rooms;
	websocket: WebSocketHandler<BunRoomSocketData>;
	bindServer: (server: Server<BunRoomSocketData>) => void;
} {
	const entries = new Map<string, RoomEntry>();
	let server: Server<BunRoomSocketData> | null = null;

	/** Flat, filesystem-safe filename: sha256 of the opaque room name. */
	function roomFilePath(name: string): string {
		const hash = createHash('sha256').update(name).digest('hex');
		return join(dir, `${hash}.sqlite`);
	}

	/**
	 * Resolve a room's entry, lazily opening its sqlite file and core. Any
	 * access (a connecting socket) cancels a pending eviction, so a room stays
	 * live as long as something is using it.
	 */
	function getOrCreate(name: string): RoomEntry {
		const existing = entries.get(name);
		if (existing) {
			cancelEviction(existing);
			return existing;
		}

		const db = new Database(roomFilePath(name), { create: true });
		// Self-identifying: the file knows which opaque room name it holds, so a
		// directory of hashed files stays debuggable.
		db.run(
			'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
		);
		db.query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
			'roomName',
			name,
		);

		const updateLog = createBunSqliteUpdateLog(db);
		const core = createRoomCore({ updateLog });
		const entry: RoomEntry = { name, core, db, evictionTimer: null };
		entries.set(name, entry);
		return entry;
	}

	function cancelEviction(entry: RoomEntry): void {
		if (!entry.evictionTimer) return;
		clearTimeout(entry.evictionTimer);
		entry.evictionTimer = null;
	}

	function scheduleEviction(entry: RoomEntry): void {
		if (entry.evictionTimer) return;
		entry.evictionTimer = setTimeout(() => {
			entry.evictionTimer = null;
			if (entry.core.connectionCount > 0) return;
			entry.core.compact();
			// Truncate-checkpoint before close so the -wal/-shm sidecars do not
			// survive on macOS (persistent WAL by default there).
			try {
				entry.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
			} catch {
				/* best-effort; close still proceeds */
			}
			entry.db.close();
			entries.delete(entry.name);
		}, EVICTION_GRACE_MS);
	}

	const rooms: Rooms = {
		get(name: string): ResolvedRoom {
			return {
				handleUpgrade: ({ request }: RoomUpgrade) => {
					if (!server) return serverNotBound();
					// Resolve the room now (creating it if needed); `getOrCreate`
					// cancels any pending eviction, so the entry survives the gap
					// until the `open` handler attaches the socket.
					getOrCreate(name);

					const data: BunRoomSocketData = {
						surface: 'rooms',
						kind: 'room',
						roomName: name,
					};
					sanitizeUpgradeSubprotocols(request);
					const upgraded = server.upgrade(request, { data });
					if (!upgraded) {
						return Promise.resolve(
							new Response('expected a WebSocket upgrade', { status: 426 }),
						);
					}
					// Bun has hijacked the socket and already sent the 101; this
					// placeholder Response is discarded. Hono requires a Response.
					return Promise.resolve(new Response(null));
				},
			} satisfies ResolvedRoom;
		},
		rejectUpgrade: ({ request, code, reason }) => {
			if (!server) return serverNotBound();
			// Accept the upgrade, then let the `open` handler close it immediately
			// with the app code, so the browser reads a close code (a failed
			// handshake carries none). Same `server.upgrade` path as a real
			// connection, discriminated by `ws.data.kind`.
			const data: BunRoomSocketData = {
				surface: 'rooms',
				kind: 'reject',
				code,
				reason,
			};
			sanitizeUpgradeSubprotocols(request);
			const upgraded = server.upgrade(request, { data });
			if (!upgraded) {
				// Not an upgrade request after all; answer the plain HTTP status
				// the app close code encodes (4401 -> 401, 4503 -> 503).
				return Promise.resolve(new Response(reason, { status: code - 4000 }));
			}
			return Promise.resolve(new Response(null));
		},
	};

	const websocket: WebSocketHandler<BunRoomSocketData> = {
		// Binary Yjs frames arrive as Bun's default `Buffer`, a `Uint8Array`
		// subclass RoomCore's decode path accepts directly (no `binaryType`
		// override and no conversion needed).
		open(ws: ServerWebSocket<BunRoomSocketData>) {
			if (ws.data.kind === 'reject') {
				ws.close(ws.data.code, ws.data.reason);
				return;
			}
			const { roomName } = ws.data;
			// `getOrCreate` cancels any pending eviction, so a socket landing in
			// the grace window keeps its room alive.
			const entry = getOrCreate(roomName);
			const socketAuth: RoomSocketAuth = { authenticatedAt: Date.now() };
			entry.core.addConnection(ws, socketAuth);
		},
		message(ws: ServerWebSocket<BunRoomSocketData>, message) {
			if (ws.data.kind === 'reject') return;
			const entry = entries.get(ws.data.roomName);
			if (!entry) return;
			entry.core.handleMessage(ws, message);
		},
		close(ws: ServerWebSocket<BunRoomSocketData>, code) {
			if (ws.data.kind === 'reject') return;
			const entry = entries.get(ws.data.roomName);
			if (!entry) return;
			entry.core.removeConnection(ws, code);
			if (entry.core.connectionCount === 0) scheduleEviction(entry);
		},
	};

	// Idle-socket lifetime sweep: the per-message check in `RoomCore` bounds an
	// active socket; this bounds a silent one held open past token expiry. One
	// process-wide timer over every room; unref'd so it never keeps the process
	// alive (e.g. a short-lived test).
	const sweepTimer = setInterval(() => {
		const now = Date.now();
		for (const entry of entries.values()) {
			entry.core.sweepExpiredConnections(now);
		}
	}, CONNECTION_SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();

	return {
		rooms,
		websocket,
		bindServer(s: Server<BunRoomSocketData>): void {
			server = s;
		},
	};
}
