/**
 * Vocabulary for the runtime-agnostic room system.
 *
 * Hand-declared types that multiple backends implement and
 * {@link createRoomCore} consumes. The factory-per-backend pattern uses
 * `satisfies` to prove each backend's concrete return shape matches these
 * types while keeping that concrete shape navigable in editors.
 *
 * ## What lives here
 *
 * - {@link RoomUpdateLog}: per-room persistent update log. Backends supply
 *   the storage; the contract is synchronous because the Yjs `updateV2`
 *   callback that calls `append` cannot await.
 * - {@link RoomSocket}: the minimal per-connection WebSocket surface.
 *   Structural by design so both Cloudflare's hibernation `WebSocket` and
 *   Bun's `ServerWebSocket` satisfy it natively, no wrapper required.
 * - {@link ResolvedRoom} / {@link Rooms}: name-to-room routing
 *   consumed by route middleware in `app.ts`.
 * - {@link RoomError}: error variants surfaced across the room's
 *   untrusted-input boundary (the binary WebSocket frame).
 *
 * @see `room/core.ts` for the consumer (`createRoomCore`).
 * @see `room/backends/cloudflare/` for the Cloudflare backend.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

// ============================================================================
// RoomUpdateLog
// ============================================================================

/**
 * Persistent update log for one room's Yjs document.
 *
 * Backends pick their own storage; the Cloudflare backend wraps
 * `ctx.storage.sql`, a Bun backend would wrap a `bun:sqlite` file.
 * {@link createRoomCore} consumes this type and never knows which.
 *
 * Invariants:
 * - `loadAll()` returns entries in insertion order.
 * - `append(u)` is durable before the next call returns.
 * - `replaceAll(c)` is atomic with respect to readers.
 *
 * The contract is synchronous because the Yjs `updateV2` listener that
 * calls {@link RoomUpdateLog.append} cannot `await`. Both backends choose a
 * synchronous engine (`ctx.storage.sql` on Cloudflare, `bun:sqlite` on Bun),
 * which keeps the room logic identical across them.
 */
export type RoomUpdateLog = {
	/** All update entries in insertion order. Called once at room load. */
	loadAll(): Uint8Array[];
	/** Append one Yjs update. Sync because the Yjs listener cannot await. */
	append(update: Uint8Array): void;
	/** Replace the entire log with one compacted blob. Atomic. */
	replaceAll(compacted: Uint8Array): void;
	/** Number of entries currently in the log; used to skip no-op compactions. */
	entryCount(): number;
};

// ============================================================================
// RoomSocket
// ============================================================================

/**
 * Minimal per-connection WebSocket surface used by {@link createRoomCore}.
 *
 * Structural by design: both Cloudflare's hibernation `WebSocket` and Bun's
 * `ServerWebSocket` satisfy this shape natively (TypeScript structural
 * typing), so no per-backend wrapper is needed. Backends pass the raw
 * socket to {@link RoomCore.addConnection}.
 *
 * Per-connection state that must survive runtime quirks (the
 * `RoomSocketAuth`) is tracked inside `RoomCore`'s own map. This contract
 * carries no attachment slot, because attachment persistence is
 * backend-specific (`serializeAttachment` on Cloudflare's hibernation API,
 * `ws.data` on Bun) and the adapter owns it.
 */
export type RoomSocket = {
	/** Send a text or binary frame. Backends may return a status; the contract is void. */
	send(data: string | Uint8Array): void;
	/** Close the socket with a code and reason. */
	close(code: number, reason: string): void;
	/** WebSocket-spec readyState (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3). */
	readonly readyState: number;
	/**
	 * Persist per-connection state across the runtime's hibernate cycle.
	 * Cloudflare's hibernation API provides this; Bun and other backends
	 * with in-memory connection sets leave it undefined. The core calls it
	 * (if present) whenever the in-memory room connection state changes, so
	 * state survives a DO eviction.
	 */
	serializeAttachment?(value: unknown): void;
};

/** State retained only to bound one authenticated room socket's lifetime. */
export type RoomSocketAuth = { authenticatedAt: number };

// ============================================================================
// ResolvedRoom / Rooms
// ============================================================================

/**
 * One room resolved by name, exposing the per-room operations route
 * middleware calls.
 *
 * All methods are async because some backends (Cloudflare Durable Object
 * stubs) cross an isolate boundary. Bun's backend returns
 * `Promise.resolve` of synchronous results, satisfying the same contract.
 */
export type ResolvedRoom = {
	/**
	 * Accept a WebSocket upgrade for this already-partitioned room. The backend
	 * performs its runtime-specific accept,
	 * returning the HTTP response the route returns verbatim.
	 *
	 * Identity reaches the backend as data, not re-derived from auth, but each
	 * runtime then accepts the socket differently: the Cloudflare backend
	 * forwards the request to its Durable Object (which returns a 101); the Bun
	 * backend hands the ORIGINAL request to `server.upgrade(request, { data })`
	 * (a reconstructed request cannot be upgraded) and carries the identity on
	 * the socket's `ws.data`. Both land the same state on
	 * `RoomCore.addConnection`.
	 */
	handleUpgrade(upgrade: RoomUpgrade): Promise<Response>;
};

/**
 * The identity and request a backend needs to accept one WebSocket upgrade.
 * `request` is the untouched inbound request with its runtime identity intact:
 * nothing upstream rewrites `c.req.raw`, because Bun's `server.upgrade` only
 * accepts the exact object its `fetch` handler received (the Cloudflare
 * backend forwards the request to its selected DO, which is fine
 * there: Cloudflare matches the socket by the DO it routes to, not by
 * request-object identity). The route also guarantees the
 * request offered either the main subprotocol or no subprotocols at all, so a
 * backend echoing only the main subprotocol never breaks a handshake and never
 * echoes a `bearer.<token>` entry.
 */
export type RoomUpgrade = {
	request: Request;
};

/**
 * What a backend needs to reject one WebSocket upgrade with an application
 * close code. `request` is the untouched inbound request (same identity
 * guarantee as {@link RoomUpgrade}); `code`/`reason` are the app close
 * (4000-4999) and its serialized payload. The auth layer only takes this path
 * for upgrades that offered the main subprotocol, so the backend's 101 always
 * echoes it: a compliant browser fails the handshake (and never surfaces the
 * close code) when a 101 selects no protocol it offered.
 */
export type RoomUpgradeRejection = {
	request: Request;
	code: number;
	reason: string;
};

/**
 * The runtime's room + WebSocket surface. The Cloudflare backend wraps
 * `DurableObjectNamespace`; a Bun backend wraps an in-process
 * `Map<string, RoomCore>` with lazy synchronous creation.
 *
 * The host-owned room name is built upstream by `doName(principalId, roomId)`
 * in `principal.ts`, producing `principals/<principalId>/rooms/<roomId>`.
 * This contract treats the name as opaque.
 */
export type Rooms = {
	/** Resolve a room by its opaque host-owned name. */
	get(name: string): ResolvedRoom;
	/**
	 * Reject a WebSocket upgrade with an application close code, on this runtime.
	 *
	 * The auth layer calls this when a room upgrade fails auth, before any room
	 * name is resolved (hence it is not behind {@link Rooms.get}). The socket is
	 * accepted and then immediately closed with `code`/`reason`, so the browser
	 * receives a readable close code: a plain HTTP error on an upgrade surfaces
	 * to a `WebSocket` only as an opaque failure, and the client's sync
	 * supervisor parks permanently only on a close code (4401), not a failed
	 * handshake. Runtime-specific, like {@link ResolvedRoom.handleUpgrade}: the
	 * Cloudflare backend uses a `WebSocketPair`, the Bun backend uses
	 * `server.upgrade` then `ws.close`.
	 */
	rejectUpgrade(rejection: RoomUpgradeRejection): Promise<Response>;
};

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors surfaced across the room's untrusted-input boundary: the binary
 * WebSocket frame path. Wraps lib0 buffer underflow (truncated input) and any
 * other decode-time exception thrown on untrusted bytes.
 */
export const RoomError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

/** Union of every room error variant. */
export type RoomError = InferErrors<typeof RoomError>;
