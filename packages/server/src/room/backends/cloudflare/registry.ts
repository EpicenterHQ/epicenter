/**
 * `Rooms` over a Cloudflare `DurableObjectNamespace`.
 *
 * Wraps Cloudflare's namespace + stub primitives so consumers see only
 * the runtime-agnostic {@link ResolvedRoom} surface. The Cloudflare
 * `idFromName` derivation and the `fetch`-as-upgrade convention live
 * here; route middleware in `app.ts` calls `rooms.get(name)` and never
 * touches `c.env.ROOM` directly.
 */

import { MAIN_SUBPROTOCOL } from '@epicenter/sync';
import type { ResolvedRoom, Rooms } from '../../contracts';
import type { Room } from './durable-object';

/**
 * Build a {@link Rooms} that resolves opaque room names to Durable
 * Object stubs.
 *
 * The returned `get(name)` is cheap (one `idFromName` + one `get`);
 * the stub itself is lazy until `fetch` is invoked on it.
 *
 * @param namespace - The `ROOM` binding from `wrangler.jsonc`, typed via
 *   the generated `worker-configuration.d.ts`.
 */
export function createDurableObjectRooms(
	namespace: DurableObjectNamespace<Room>,
) {
	return {
		/**
		 * Resolve a room by its host-owned opaque name (built by
		 * `doName(principalId, roomId)`, producing
		 * `principals/<principalId>/rooms/<roomId>`.
		 *
		 * Returns a {@link ResolvedRoom} whose `handleUpgrade` forwards to the
		 * DO stub's `fetch` (a 101-returning upgrade).
		 */
		get(name: string): ResolvedRoom {
			const stub = namespace.get(namespace.idFromName(name));
			return {
				// The room name already selected the principal partition. Forward the
				// upgrade without adding connection identity.
				handleUpgrade: ({ request }) => stub.fetch(request),
			} satisfies ResolvedRoom;
		},
		/**
		 * Reject a WebSocket upgrade with an application close code. Mints a
		 * detached socket pair, accepts the server half, and closes it with
		 * `code`/`reason` so the browser receives a readable close code. This is
		 * a Worker-level reject: no Durable Object is instantiated for an
		 * unauthenticated upgrade. `WebSocketPair` is the Cloudflare-only global
		 * that makes a detached pair; it lives here, in the Cloudflare backend,
		 * never in shared auth code (ADR-0066).
		 *
		 * The 101 must echo the main subprotocol: a compliant browser that
		 * offered subprotocols fails the connection when the 101 selects none,
		 * which would swallow the close code and make a 4401 park signal look
		 * like a network blip. The auth layer only takes this socket-close path
		 * for clients that offered the main subprotocol, so echoing it
		 * unconditionally is always a valid selection.
		 */
		rejectUpgrade: ({ code, reason }) => {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			server.accept();
			server.close(code, reason);
			return Promise.resolve(
				new Response(null, {
					status: 101,
					webSocket: client,
					headers: { 'sec-websocket-protocol': MAIN_SUBPROTOCOL },
				}),
			);
		},
	} satisfies Rooms;
}
