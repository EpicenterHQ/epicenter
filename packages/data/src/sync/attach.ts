/**
 * The one WebSocket dial every browser replica makes.
 *
 * ADR-0222 left a host exactly one thing to write: how to make a socket. This
 * is that one thing, written once, because it turned out to be the same
 * everywhere: build the store route's address, hand the socket's events to the
 * driver, and say whether a rejection was a credential refusal or a transport
 * failure. Reconnecting, backoff, cursor placement, and the
 * unacknowledged-submission watchdog all stay in `createSyncConnection`, where
 * they always were.
 *
 * It lives beside the driver rather than in the app that first wrote it,
 * because the classification decides what a person is shown: a refusal is a
 * status line naming what auth needs, and anything else is a background error
 * for the log. What an application actually varies is the data id it opens.
 *
 * The credential model arrives as a `SocketTransport`, the contract
 * `@epicenter/sync` declares beside the address it is dialled with. An
 * `AuthClient` implements it, so nothing here knows what a credential is: the
 * route builds the address, and auth appends the bearer to it.
 */

import { STORE_SYNC_ROUTE } from '@epicenter/sync/store-route';
import {
	isOpenWebSocketDenial,
	type SocketTransport,
} from '@epicenter/sync/transport';
import { type DataDocument, registerSyncConnection } from '../store/store.js';
import { createSyncConnection, type SyncConnection } from './connection.js';

/**
 * `WebSocket.OPEN`, as the number the standard fixes it to, because this file
 * only ever holds a socket a transport made and never touches the global
 * constructor.
 */
const SOCKET_OPEN = 1;

export type AttachStoreSyncOptions = {
	/** The hydrated document this connection carries. */
	store: DataDocument;
	/** The replication address resolved when its backing was acquired. */
	address: { baseURL: string; dataId: string; generation: number };
	/**
	 * How this replica opens its socket. `AuthClient` implements it: it takes
	 * the address the route built and appends the bearer subprotocol, because a
	 * browser upgrade cannot set `Authorization`.
	 */
	transport: SocketTransport;
	/**
	 * A dial failed for a reason time might repair: verification unreachable,
	 * plain network trouble. Reported rather than raised, because the driver's
	 * own backoff owns the retry and nobody is holding a promise for it.
	 */
	onTransportError: (cause: unknown) => void;
};

/**
 * Attach sync to an open account replica, for as long as the store is open,
 * and start it.
 *
 * Only account-backed documents attach a connection. Local documents have no
 * replication address or transport.
 *
 * Whether sync can work is decided by each dial rather than by inspecting auth
 * here, and a refusal is not a failure: the store opened from local state
 * before this was called and works offline without it (ADR-0292). A credential
 * arriving later needs no signal, because the driver is still dialling and the
 * next dial simply succeeds.
 */
export function attachStoreSync({
	store,
	address,
	transport,
	onTransportError,
}: AttachStoreSyncOptions): SyncConnection {
	const connection = createSyncConnection({
		store,
		dial: ({ cursor, opened, received, closed }) => {
			let socket: WebSocket | undefined;
			let abandoned = false;
			void transport
				.openWebSocket(
					STORE_SYNC_ROUTE.address(address.baseURL, {
						dataId: address.dataId,
						generation: address.generation,
						cursor,
					}),
				)
				.then(
					(opening) => {
						if (abandoned) {
							opening.close();
							return;
						}
						socket = opening;
						opening.binaryType = 'arraybuffer';
						opening.addEventListener('message', (event) => {
							if (typeof event.data === 'string') return;
							received(new Uint8Array(event.data as ArrayBuffer));
						});
						opening.addEventListener('close', () => closed());
						opening.addEventListener('error', () => opening.close());
						// A transport may hand back a socket that is already open, and an
						// open socket never fires `open`: waiting for one would leave the
						// driver with a live socket it never sends on, and nothing would
						// time out, because the connection is perfectly healthy. A
						// browser's `new WebSocket` is always CONNECTING here, so this
						// reads `false` for every dial a page makes.
						if (opening.readyState === SOCKET_OPEN) {
							opened({ send: (bytes) => opening.send(bytes) });
							return;
						}
						opening.addEventListener('open', () =>
							opened({ send: (bytes) => opening.send(bytes) }),
						);
					},
					(cause) => {
						if (abandoned) return;
						// A refusal is a lifecycle fact, not a background error: the
						// credential model said no, which is expected the whole time a
						// person is signed out or needs to reauth. It travels as data
						// on the one close callback and is readable from
						// `store.sync.status().refusal` for as long as this connection
						// is attached, which is what the status line renders (ADR-0340).
						if (isOpenWebSocketDenial(cause)) {
							closed(cause.code);
							return;
						}
						onTransportError(cause);
						closed();
					},
				);
			return () => {
				abandoned = true;
				socket?.close();
			};
		},
	});
	// The store answers `sync.status()` from here for as long as this connection
	// is the one driving it (ADR-0340). A consumer polls that rather than
	// holding this object, which is why disposal takes the registration back.
	const forget = registerSyncConnection(store.sync, () => connection.status());
	// Contained, because between the registration and the first dial there is
	// nothing for a caller to hold: a throw out of `start` would leave the store
	// answering `status()` for a driver nobody can stop.
	try {
		connection.start();
	} catch (cause) {
		forget();
		connection[Symbol.dispose]();
		throw cause;
	}
	return {
		...connection,
		[Symbol.dispose]() {
			forget();
			connection[Symbol.dispose]();
		},
	};
}
