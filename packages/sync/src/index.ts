/**
 * `@epicenter/sync`: the store dial, shared by the client and server halves.
 *
 * A browser `WebSocket` cannot set request headers, so a bearer credential
 * rides the subprotocol list instead: the client offers `epicenter` plus
 * `bearer.<token>`, and the server extracts the token and echoes back only the
 * main subprotocol. This package owns that vocabulary and the value it travels
 * in: `STORE_SYNC_ROUTE.address` builds a `WebSocketAddress`, a
 * `SocketTransport` completes it with the bearer entry and opens the socket,
 * and the server parses the same header back apart.
 */

export {
	BEARER_SUBPROTOCOL_PREFIX,
	bearerSubprotocol,
	formatSubprotocols,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from './auth-subprotocol.js';
export {
	CURRENT_GENERATION_HEADER,
	CURRENT_ROUTE,
	GENERATIONS_ROUTE,
	LOG_POSITION_HEADER,
} from './generations-route.js';
export { DATA_ID, STORE_SYNC_ROUTE } from './store-route.js';
export {
	isOpenWebSocketDenial,
	type OpenWebSocketDenial,
	type SocketTransport,
	type SyncRefusal,
	type WebSocketAddress,
} from './transport.js';
