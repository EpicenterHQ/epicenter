/**
 * @epicenter/sync: Yjs Sync Protocol Primitives
 *
 * Encode/decode functions for the sync wire protocol.
 *
 * The binary WebSocket channel carries a single message family: Yjs
 * document sync. A binary frame is a sync frame, with no top-level
 * message-type discriminator. Presence frames ride text frames.
 */

// WebSocket subprotocol auth (shared client/server constants + helpers)
export {
	BEARER_SUBPROTOCOL_PREFIX,
	isOpenWebSocketDenial,
	MAIN_SUBPROTOCOL,
	type OpenWebSocketDenial,
	parseSubprotocols,
} from './auth-subprotocol';
// Transport origin sentinels (shared across all sync layers)
export {
	BC_ORIGIN,
	isTransportOrigin,
	SYNC_ORIGIN,
} from './origins';
export {
	checkPresenceFrame,
	checkPresencePublishFrame,
	type PresenceFrame,
	type PresencePeer,
	type PresencePublishFrame,
} from './presence';
// Protocol (encode/decode for WS sync messages)
export {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
} from './protocol';
export { ROOM_ROUTE } from './room-route';
