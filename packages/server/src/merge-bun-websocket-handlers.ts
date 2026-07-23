/**
 * Merge the Bun `WebSocketHandler`s a self-hosted instance serves into the one
 * handler `Bun.serve` accepts,
 * dispatching each socket to its owner by the `surface` tag on `ws.data`.
 *
 * `Bun.serve` accepts exactly ONE `websocket` handler, but a Bun host that
 * serves rooms, record documents, and AttachRelay needs them on one port and
 * one server. Each backend
 * owns a DISJOINT `ws.data` shape (`createBunRooms` tags `surface: 'rooms'`,
 * `createAttachRelayBunServer` tags `surface: 'attach'`) and its own coordinator
 * state, so this merge never blends the two: it reads the tag stamped at
 * `server.upgrade` time and forwards every lifecycle callback to the one handler
 * that owns that socket. The `surface` tag is a server-side dispatch discriminant
 * on `ws.data`, never a wire or addressing field: it never reaches a relay frame,
 * so it is not the "channel router" ADR-0115 forbids.
 *
 * This is a closed merge, not a generic N-way router. Each backend binds the
 * same `Server` so its upgrade handler reaches the one Bun server this merged
 * handler drives.
 */

import type { ServerWebSocket, WebSocketHandler } from 'bun';
import type { AttachRelaySocketData } from './attach-relay/bun-server.js';
import type { BunDataDocumentV1SocketData } from './epicenter-sync/document-realtime-v1-bun.js';
import type { BunRoomSocketData } from './room/backends/bun/registry.js';

/** The disjoint `ws.data` shapes this merged handler dispatches between. */
export type MergedSocketData =
	| BunRoomSocketData
	| AttachRelaySocketData
	| BunDataDocumentV1SocketData;

/**
 * Build the one `WebSocketHandler` that routes each socket to its owning backend
 * by the `surface` tag `server.upgrade` stamped onto `ws.data`. Each backend
 * handler expects its own concrete `ws.data`, not the union, so `pick` reads the
 * tag and hands the socket to that backend's handler as its own type: this
 * function owns that one narrowing so each caller passes typed handlers
 * directly.
 */
export function mergeBunWebSocketHandlers(handlers: {
	rooms: WebSocketHandler<BunRoomSocketData>;
	dataDocuments?: WebSocketHandler<BunDataDocumentV1SocketData>;
	attach?: WebSocketHandler<AttachRelaySocketData>;
}): WebSocketHandler<MergedSocketData> {
	const pick = (
		ws: ServerWebSocket<MergedSocketData>,
	): WebSocketHandler<MergedSocketData> => {
		if (ws.data.surface === 'rooms') {
			return handlers.rooms as WebSocketHandler<MergedSocketData>;
		}
		if (ws.data.surface === 'epicenter-data-document') {
			if (handlers.dataDocuments === undefined) {
				throw new Error('Record document WebSocket handler is not installed');
			}
			return handlers.dataDocuments as WebSocketHandler<MergedSocketData>;
		}
		if (handlers.attach === undefined) {
			throw new Error('Attach WebSocket handler is not installed');
		}
		return handlers.attach as WebSocketHandler<MergedSocketData>;
	};

	return {
		open(ws) {
			pick(ws).open?.(ws);
		},
		message(ws, message) {
			pick(ws).message?.(ws, message);
		},
		close(ws, code, reason) {
			pick(ws).close?.(ws, code, reason);
		},
		drain(ws) {
			pick(ws).drain?.(ws);
		},
		ping(ws, data) {
			pick(ws).ping?.(ws, data);
		},
		pong(ws, data) {
			pick(ws).pong?.(ws, data);
		},
	};
}
