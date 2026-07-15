/**
 * Cloudflare Durable Object adapter for {@link createRoomCore}.
 *
 * The `DurableObject` base class is the one place a class is unavoidable:
 * Cloudflare's runtime instantiates it per room and routes the
 * Hibernation API callbacks (`webSocketMessage`, `webSocketClose`,
 * `webSocketError`, `alarm`) to method overrides. This class is a thin
 * shell: every callback forwards to a single {@link RoomCore} instance
 * built in the constructor.
 *
 * ## Lifecycle
 *
 * 1. **Constructor**: `blockConcurrencyWhile` runs a synchronous init
 *    that builds the {@link RoomUpdateLog} over `ctx.storage`, creates
 *    the `RoomCore`, and re-registers any sockets that survived
 *    hibernation via `ctx.getWebSockets()`.
 * 2. **`fetch`**: handles WebSocket upgrades, the room's only surface.
 * 3. **Hibernation callbacks**: forward to `core` directly.
 * 4. **`alarm`**: one multiplexed timer. While clients are connected it sweeps
 *    and closes over-age sockets ({@link CONNECTION_SWEEP_INTERVAL_MS}); once
 *    the room empties it compacts 30 s later.
 *
 * ## RoomSocket compatibility
 *
 * Cloudflare's hibernation `WebSocket` exposes `send`, `close`, and
 * `readyState`. TypeScript's structural typing treats it as a
 * {@link RoomSocket}, so the raw socket is passed straight to
 * `core.addConnection` / `core.handleMessage` / `core.removeConnection`
 * with no wrapper.
 */

import { DurableObject } from 'cloudflare:workers';
import { MAIN_SUBPROTOCOL, parseSubprotocols } from '@epicenter/sync';
import type { RoomSocketAuth } from '../../contracts.js';
import { createRoomCore, type RoomCore } from '../../core.js';
import { createDurableObjectUpdateLog } from './update-log.js';

/** Delay before alarm-based compaction fires (30 seconds). */
const COMPACTION_DELAY_MS = 30_000;

/**
 * Cadence of the alarm-driven lifetime sweep while the room has connections (5
 * minutes).
 *
 * The connection-lifetime bound itself lives in {@link RoomCore} (the
 * per-message check in `handleMessage` plus `sweepExpiredConnections`). The
 * per-message check only fires on inbound frames, and on this backend the
 * client's liveness `ping` is auto-responded by the runtime without ever
 * reaching the core, so a document-idle socket would never be re-checked. This
 * sweep drives `core.sweepExpiredConnections` on a timer to close over-age
 * sockets regardless of activity.
 */
const CONNECTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Yjs sync room backed by a Cloudflare Durable Object.
 *
 * Owns the Hibernation API integration (`acceptWebSocket`,
 * `serializeAttachment`, `setAlarm`) and forwards every meaningful event
 * to the {@link RoomCore} instance built in the constructor.
 *
 * ## Worker to DO interface
 *
 * - **fetch** (`stub.fetch(request)`): WebSocket upgrades, the only entry;
 *   the 101 Switching Protocols handshake requires HTTP semantics.
 *
 * ## Auth & data isolation
 *
 * Handled upstream by Hono routes in `@epicenter/server`. The Worker
 * validates the caller, checks any route-owned policy, and builds the
 * internal DO name before forwarding `fetch`. The
 * DO itself does not re-validate. DO names are host-owned opaque strings
 * built by `doName(principalId, roomId)`, producing
 * `principals/<principalId>/rooms/<roomId>`.
 */
export class Room extends DurableObject {
	/**
	 * The runtime-agnostic room logic. Initialized synchronously inside
	 * `ctx.blockConcurrencyWhile()` in the constructor. The definite
	 * assignment assertion is safe because of two guarantees working
	 * together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile`
	 *    prevents the DO from receiving any incoming requests until the
	 *    initialization promise resolves.
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile`
	 * callback, guarantee (2) breaks.
	 *
	 * @see https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
	 */
	private core!: RoomCore;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			const updateLog = createDurableObjectUpdateLog(ctx.storage);
			this.core = createRoomCore({ updateLog });

			// Restore connections that survived hibernation. The hibernation
			// WebSocket structurally satisfies RoomSocket (send/close/
			// readyState), so we pass the raw ws directly.
			//
			// Re-register hibernated sockets with their connection timestamps.
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as RoomSocketAuth | null;
				if (!attachment) continue;
				this.core.addConnection(ws, attachment);
			}
		});
	}

	/**
	 * Handles WebSocket upgrades, the room's only surface.
	 *
	 * The room partition has already been selected by the authenticated route.
	 * The socket attachment stores only its connection timestamp.
	 *
	 * Cancels any pending compaction alarm: a new client just connected,
	 * so compacting now would be wasteful.
	 *
	 * The client offers
	 * `sec-websocket-protocol: <MAIN_SUBPROTOCOL>, bearer.<token>`; we
	 * echo only the main subprotocol to complete the handshake.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Method not allowed', { status: 405 });
		}

		// Ensure the lifetime sweep is running. This also supersedes any pending
		// compaction alarm: if one fires while a client is connected, `alarm()`
		// sees connections and sweeps instead of compacting.
		void this.ensureSweepAlarm();

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		// Stash the connection timestamp so the lifetime bound survives hibernation.
		const attachment: RoomSocketAuth = { authenticatedAt: Date.now() };
		server.serializeAttachment(attachment);

		// Register with the core. addConnection sends the initial SyncStep1.
		this.core.addConnection(server, attachment);

		const responseHeaders = new Headers();
		const offered = parseSubprotocols(
			request.headers.get('sec-websocket-protocol'),
		);
		if (offered.includes(MAIN_SUBPROTOCOL)) {
			responseHeaders.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: responseHeaders,
		});
	}

	/**
	 * Forward inbound messages to the core.
	 *
	 * The core enforces the connection-lifetime bound on every frame (see
	 * {@link RoomCore.handleMessage}): a socket past its max age is closed
	 * instead of served, the runtime's `webSocketClose` then runs the normal
	 * cleanup and compaction path.
	 */
	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		this.core.handleMessage(ws, message);
	}

	/**
	 * Arm the lifetime sweep alarm if no alarm is already pending. Idempotent, so
	 * repeated upgrades on a busy room do not keep pushing the sweep out, and a
	 * pending compaction alarm is left in place (it sweeps harmlessly while
	 * clients are connected).
	 */
	private async ensureSweepAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(
				Date.now() + CONNECTION_SWEEP_INTERVAL_MS,
			);
		}
	}

	/**
	 * Forward close events to the core and schedule deferred compaction
	 * if the room emptied.
	 *
	 * The defensive `ws.close(code, reason)` after the core call covers
	 * a hibernation edge case where the server side outlives the client
	 * side; calling close on an already-closed socket throws and is
	 * swallowed.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		this.core.removeConnection(ws, code);

		try {
			ws.close(code, reason);
		} catch {
			/* already closed by the remote end */
		}

		if (this.core.connectionCount === 0) {
			void this.ctx.storage.setAlarm(Date.now() + COMPACTION_DELAY_MS);
		}
	}

	/**
	 * Handle a WebSocket error by closing with status 1011 (Internal
	 * Error). Delegates to {@link Room.webSocketClose} so the same
	 * cleanup path runs regardless of whether the socket closed cleanly
	 * or errored.
	 */
	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	/**
	 * The room's single maintenance alarm, multiplexed two ways:
	 *
	 * - While clients are connected it is the periodic lifetime sweep: it asks
	 *   the core to close every over-age socket (including idle ones the
	 *   per-message check never sees), then re-arms for the next
	 *   {@link CONNECTION_SWEEP_INTERVAL_MS}. The swept closes fire
	 *   `webSocketClose`, which sets the compaction alarm once the room empties
	 *   (overriding this re-arm).
	 * - When the room is empty it compacts the update log (scheduled
	 *   {@link COMPACTION_DELAY_MS} after the last close).
	 *
	 * @see https://developers.cloudflare.com/durable-objects/api/alarms/
	 */
	override async alarm(): Promise<void> {
		const now = Date.now();
		this.core.sweepExpiredConnections(now);
		if (this.core.connectionCount > 0) {
			void this.ctx.storage.setAlarm(now + CONNECTION_SWEEP_INTERVAL_MS);
			return;
		}
		this.core.compact();
	}
}
