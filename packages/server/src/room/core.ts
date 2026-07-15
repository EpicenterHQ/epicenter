/**
 * Runtime-agnostic Yjs sync room.
 *
 * Owns the Yjs document and its open socket set.
 * Does NOT own the WebSocket lifecycle (fetch/upgrade/`webSocketMessage`
 * callbacks), the alarm scheduling, or the update-log storage; those are
 * backend-specific and live in the adapter.
 *
 * Imports no `cloudflare:workers` symbols. Both Cloudflare's Durable
 * Object and the Bun backend (`room/backends/bun/`) drive the same
 * {@link createRoomCore} instance through the methods listed on its return
 * object. Connection-lifetime enforcement and liveness ping/pong are
 * room-core invariants here, so neither backend can forget them.
 *
 * ## Adapter contract
 *
 * Backends drive `RoomCore` through these entry points:
 *
 *   - `addConnection(socket, connection)`     on accept
 *   - `removeConnection(socket, code)`         on close
 *   - `handleMessage(socket, message)`         on inbound frame
 *   - `compact()`                              after idle
 *
 * `connectionCount` is exposed as a query so the backend can schedule
 * deferred compaction when the room empties.
 */

import {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import { createLogger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from '../constants.js';
import {
	RoomError,
	type RoomSocket,
	type RoomSocketAuth,
	type RoomUpdateLog,
} from './contracts.js';

const log = createLogger('server/room/core');

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted update size.
 *
 * Sized for the Cloudflare DO SQLite per-row BLOB limit (2 MB). Other
 * backends may technically exceed this, but the conservative cap keeps
 * cross-backend behavior identical and avoids surprises if a room
 * migrates between backends.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Maximum lifetime of a single WebSocket connection before the room forces a
 * reconnect (30 minutes).
 *
 * Auth is verified once, at the HTTP upgrade. Without a bound, a socket opened
 * with a valid bearer would keep operating indefinitely after the access token
 * expires (10min TTL) or the session is revoked. Closing the socket past this
 * age forces the client to reconnect and re-authenticate at a fresh upgrade: a
 * signed-out or revoked client then fails closed, while a healthy client
 * refreshes its token transparently. Coarser than the access-token TTL to limit
 * reconnect churn.
 *
 * This is a room-core invariant, not an adapter detail: every backend inherits
 * it through {@link RoomCore.handleMessage} (active sockets) and
 * {@link RoomCore.sweepExpiredConnections} (idle sockets), so no backend can
 * silently let a socket outlive its credentials.
 */
const MAX_CONNECTION_LIFETIME_MS = 30 * 60_000;

/**
 * Close code emitted when a connection exceeds {@link MAX_CONNECTION_LIFETIME_MS}.
 *
 * App-defined (4000-4999) and deliberately NOT the permanent-auth code
 * (4401): the client's sync supervisor reconnects on every other close, so
 * this code recycles the socket through a fresh
 * authenticated upgrade instead of making the client give up.
 */
const CLOSE_CODE_CONNECTION_LIFETIME = 4408;

// ============================================================================
// createRoomCore
// ============================================================================

/**
 * Build one runtime-agnostic room over a {@link RoomUpdateLog}.
 *
 * The factory eagerly:
 * 1. Creates a `Y.Doc({ gc: true })`.
 * 2. Replays every persisted update from `updateLog.loadAll()` into it.
 * 3. Opportunistically compacts the log on cold start.
 * 4. Subscribes to `updateV2` so every live update is persisted and
 *    fanned out to peer sockets (excluding the origin).
 *
 * Connections are added by the backend via {@link RoomCore.addConnection}.
 * The adapter remains responsible for the runtime-specific accept (the
 * Cloudflare hibernation API call or `Bun.serve` upgrade); this factory
 * handles every in-room consequence.
 *
 * @param deps - Injected dependencies.
 * @param deps.updateLog - Persistent update log for this room's doc.
 */
export function createRoomCore({ updateLog }: { updateLog: RoomUpdateLog }) {
	// ==========================================================================
	// State
	// ==========================================================================

	/** The shared Yjs document for this room. Always `gc: true`. */
	const doc = new Y.Doc({ gc: true });

	/** Open sockets and the timestamp used by the auth-lifetime bound. */
	const connections = new Map<RoomSocket, RoomSocketAuth>();

	// ==========================================================================
	// Init
	// ==========================================================================

	// Replay every persisted update, then opportunistically compact.
	for (const update of updateLog.loadAll()) {
		Y.applyUpdateV2(doc, update);
	}
	compactUpdateLog(doc, updateLog);

	// Persist every live update. Synchronous: the Yjs listener cannot await.
	doc.on('updateV2', (update: Uint8Array) => {
		updateLog.append(update);
	});

	// Fan every doc update out to all connected sockets except origin.
	// The frame is encoded once and `connections` is read at fire time,
	// so the broadcast always reflects the live socket set.
	doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
		const frame = encodeSyncUpdate({ update });
		for (const ws of connections.keys()) {
			if (ws === origin) continue;
			try {
				ws.send(frame);
			} catch {
				/* dead socket; its close event runs cleanup */
			}
		}
	});

	/** Reply to the sync supervisor's liveness frame and reject other text. */
	function handleTextFrame(ws: RoomSocket, message: string): void {
		// Liveness ping/pong. The client sends a literal `ping` text frame on an
		// interval (and on tab focus); reply `pong` so a document-idle socket
		// stays alive. The Cloudflare backend short-circuits this with
		// `setWebSocketAutoResponse`, so the ping never reaches the core there;
		// handling it here makes the reply a room-core invariant every other
		// backend inherits, instead of an adapter detail a new runtime can forget.
		if (message === 'ping') {
			ws.send('pong');
			return;
		}
		ws.close(4400, 'protocol-error');
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	return {
		/** Register a socket and start its Yjs handshake. */
		addConnection(socket: RoomSocket, connection: RoomSocketAuth): void {
			connections.set(socket, connection);
			socket.send(encodeSyncStep1({ doc }));
		},

		/** Drop a closed socket. */
		removeConnection(socket: RoomSocket, _code: number): void {
			connections.delete(socket);
		},

		/**
		 * Handle one inbound WebSocket message.
		 *
		 * Binary frames carry y-protocols sync. Text is reserved for ping/pong.
		 *
		 * Oversized messages close the socket with `1009 Message too
		 * large`. A `MessageDecode` failure is logged and dropped without
		 * closing the socket.
		 *
		 * Binary frames arrive as an `ArrayBuffer` on the Cloudflare backend and
		 * as a `Buffer` (a `Uint8Array` subclass) on the Bun backend; both
		 * satisfy this `Uint8Array` decode path, so neither backend converts.
		 */
		handleMessage(
			socket: RoomSocket,
			message: ArrayBuffer | Uint8Array | string,
		): void {
			const data = connections.get(socket);
			if (!data) return;

			// Connection-lifetime bound, enforced on every inbound frame (the
			// client's liveness ping counts, so an active socket is re-checked at
			// least once per ping interval). A socket past its max age is closed
			// instead of served, forcing a reconnect that re-authenticates; the
			// transient close code recycles it rather than parking the client.
			// Idle sockets are covered by `sweepExpiredConnections`.
			if (Date.now() - data.authenticatedAt >= MAX_CONNECTION_LIFETIME_MS) {
				socket.close(
					CLOSE_CODE_CONNECTION_LIFETIME,
					'connection lifetime exceeded',
				);
				return;
			}

			const byteLength =
				typeof message === 'string' ? message.length : message.byteLength;
			if (byteLength > MAX_PAYLOAD_BYTES) {
				socket.close(1009, 'Message too large');
				return;
			}

			if (typeof message === 'string') {
				handleTextFrame(socket, message);
				return;
			}

			const { data: reply, error } = trySync({
				try: () => {
					const decoder = decoding.createDecoder(new Uint8Array(message));
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc,
						origin: socket,
					});
					return response ?? null;
				},
				catch: (cause) => RoomError.MessageDecode({ cause }),
			});
			if (error) {
				log.warn(error);
				return;
			}
			if (reply) socket.send(reply);
		},

		/**
		 * Compact the update log into a single row.
		 *
		 * Backends call this when the room has been idle long enough
		 * (typically 30 s after the last connection closes). The compact
		 * itself is opportunistic: no-ops if the log has <= 1 entry or
		 * the encoded state exceeds the per-row blob cap.
		 */
		compact(): void {
			compactUpdateLog(doc, updateLog);
		},

		/**
		 * Close every connection past {@link MAX_CONNECTION_LIFETIME_MS}.
		 *
		 * The per-message check in {@link RoomCore.handleMessage} already bounds
		 * an active socket; a backend drives this on a timer to also bound a
		 * silent one whose only traffic is an auto-responded `ping` the core
		 * never sees (the Cloudflare DO) or which sends nothing at all. The close
		 * fires the backend's normal close path (`webSocketClose` / the Bun
		 * `close` handler), which runs `removeConnection`.
		 *
		 * `now` is supplied by the caller so a sweep over many rooms shares one
		 * clock read.
		 */
		sweepExpiredConnections(now: number): void {
			for (const [socket, connection] of connections) {
				if (now - connection.authenticatedAt >= MAX_CONNECTION_LIFETIME_MS) {
					socket.close(
						CLOSE_CODE_CONNECTION_LIFETIME,
						'connection lifetime exceeded',
					);
				}
			}
		},

		/**
		 * Open-connection count. Backends use this to decide whether to
		 * schedule deferred compaction after a `removeConnection` call.
		 */
		get connectionCount(): number {
			return connections.size;
		},
	};
}

/** Public shape of {@link createRoomCore}. Derived; do not hand-declare. */
export type RoomCore = ReturnType<typeof createRoomCore>;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compact the update log into a single row.
 *
 * `Y.encodeStateAsUpdateV2` produces smaller output than
 * `Y.mergeUpdatesV2` because deleted items become lightweight GC structs
 * (with `gc: true`) and struct merging is more thorough. It also avoids
 * the exponential performance edge case documented in yjs#710.
 *
 * No-ops if the log already has <= 1 entry or the compacted blob exceeds
 * {@link MAX_COMPACTED_BYTES}. The cap is a Cloudflare DO SQLite
 * constraint kept as a shared invariant so cross-backend behavior is
 * identical.
 *
 * @see {@link https://github.com/yjs/yjs/issues/710 | yjs#710}
 */
function compactUpdateLog(doc: Y.Doc, updateLog: RoomUpdateLog): void {
	const count = updateLog.entryCount();
	if (count <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(doc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	updateLog.replaceAll(compacted);

	log.info('update log compacted', {
		entries: count,
		compactedBytes: compacted.byteLength,
	});
}
