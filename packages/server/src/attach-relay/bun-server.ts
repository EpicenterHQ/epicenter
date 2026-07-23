/**
 * A Bun WebSocket transport for the {@link createAttachRelay} coordinator, the
 * runtime a self-hosted instance runs (ADR-0115: the relay is a WebSocket
 * channel on the per-user rendezvous each device dials out to; a Durable Object
 * backend for Cloud is not built). It returns the
 * `websocket` handler `Bun.serve` needs, `bindServer` to hand back the `Server`
 * once serving, and `handleUpgrade` to accept one authenticated attach.
 *
 * ## One authenticated upgrade path
 *
 * {@link handleUpgrade} is the only way in: the authenticated mount
 * (`mountAttachRelayApp`) resolves the operator bearer to the one principal this
 * deployment admits (the instance principal on self-host) and stamps
 * `principalId` SERVER-SIDE, so a query `principalId` is never trusted. It
 * requires a bound `Server` (`bindServer`), the same impedance the document runtime
 * has, because Bun upgrades by calling `server.upgrade` rather than returning a
 * 101 from `fetch`. There is deliberately no unauthenticated path: every attach
 * carries a bearer, so the relay has one principal-resolution model, not two.
 *
 * Wave 3 replaces the bearer-to-instance-principal step with a per-device grant;
 * the coordinator and the socket-data shape do not change, only the layer above.
 *
 * The socket the coordinator drives is the Bun `ServerWebSocket` itself: it
 * satisfies {@link RelaySocket} structurally (`send`, `close`, `readyState`),
 * so no wrapper is needed, the same move the room backend makes.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { sanitizeUpgradeSubprotocols } from '../sanitize-upgrade-subprotocols.js';
import {
	type AttachEndpoint,
	type AttachUpgrade,
	parseAttachEndpoint,
} from './contracts.js';
import {
	type ClientConnection,
	createAttachRelay,
	type HostConnection,
} from './core.js';
import {
	type AttachHostDirectoryEntry,
	createHostDirectory,
	type HostDirectoryReader,
} from './host-directory.js';

/**
 * Per-connection identity Bun carries on `ws.data`, set at `server.upgrade` and
 * read back in the `websocket` handler. Discriminated by `role`: a host
 * registers under `(principalId, hostId)`; a client attaches under the full
 * endpoint quadruple. The `surface` tag lets {@link mergeBunWebSocketHandlers}
 * route this socket to the attach relay when it shares one `Bun.serve` with the
 * document runtime; it is a server-side dispatch discriminant, never a wire field.
 */
export type AttachRelaySocketData = { surface: 'attach' } & AttachEndpoint;

export type AttachRelayBunServer = {
	/**
	 * Accept one authenticated attach: the mount stamps `principalId` from the
	 * resolved bearer. Requires the `Server` bound via {@link bindServer}.
	 */
	handleUpgrade(upgrade: AttachUpgrade): Response;
	/** Hand back the `Server` once `Bun.serve` returns, so `handleUpgrade` can upgrade. */
	bindServer(server: Server<AttachRelaySocketData>): void;
	websocket: WebSocketHandler<AttachRelaySocketData>;
	/**
	 * This process's host directory (ADR-0115 clause 3): the retained
	 * membership+label of every host that has connected, joined at read time with
	 * the coordinator's live host set. A self-host deployment hands this to
	 * `mountHostDirectoryApp` so a signed-in client can `GET /attach/hosts`.
	 */
	hostDirectory: HostDirectoryReader;
};

/**
 * Build the Bun transport around one relay coordinator. Bind the `Server` once
 * `Bun.serve` returns (Bun's `server.upgrade` needs the live instance), pass
 * `websocket` to `Bun.serve` (or merge it with the rooms handler), and accept
 * one authenticated `/attach` upgrade through `handleUpgrade`.
 */
export function createAttachRelayBunServer(): AttachRelayBunServer {
	const relay = createAttachRelay();
	// The retained membership+label half of the directory; the live half is
	// `relay.liveHostIds`. The exposed `hostDirectory` joins the two at read time.
	const directory = createHostDirectory();
	const connections = new WeakMap<
		ServerWebSocket<AttachRelaySocketData>,
		HostConnection | ClientConnection
	>();
	let server: Server<AttachRelaySocketData> | null = null;

	return {
		handleUpgrade({
			request,
			principalId,
			role,
			hostId,
			deviceId,
			attachId,
			label,
		}) {
			if (!server) {
				return new Response('attach relay server not bound', { status: 500 });
			}
			const data = buildSocketData({
				principalId,
				role,
				hostId,
				deviceId,
				attachId,
				label,
			});
			if (!data) {
				return new Response('Bad attach request', { status: 400 });
			}
			// Echo only the main subprotocol on the 101, so a `bearer.<token>` a
			// browser client offered is never round-tripped (the uWS auto-echo leak).
			sanitizeUpgradeSubprotocols(request);
			if (server.upgrade(request, { data })) {
				// Bun hijacked the socket and sent the 101; this placeholder Response is
				// discarded. Hono requires a Response.
				return new Response(null);
			}
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		},

		bindServer(boundServer) {
			server = boundServer;
		},

		hostDirectory: {
			list(principalId): AttachHostDirectoryEntry[] {
				const live = new Set(relay.liveHostIds(principalId));
				return directory.entries(principalId).map(({ hostId, label }) => ({
					hostId,
					label,
					status: live.has(hostId) ? 'online' : 'offline',
				}));
			},
		},

		websocket: {
			open(ws) {
				if (ws.data.role === 'host') {
					// Publish membership by the act of connecting as a host; a client
					// never reaches this branch, so it is structurally absent from the
					// directory. Liveness is not stored here: it is read from the
					// coordinator at `hostDirectory.list` time.
					directory.record(ws.data.principalId, ws.data.hostId, ws.data.label);
				}
				const connection =
					ws.data.role === 'host'
						? relay.registerHost({ ...ws.data, socket: ws })
						: relay.attachClient({ ...ws.data, socket: ws });
				connections.set(ws, connection);
			},
			message(ws, message) {
				connections.get(ws)?.receive(String(message));
			},
			close(ws) {
				connections.get(ws)?.close();
				connections.delete(ws);
			},
		},
	};
}

/**
 * Shape a validated {@link AttachRelaySocketData} from the server-stamped
 * `principalId` plus the connect query's endpoint ids, or `undefined` if the
 * shape is incomplete for the `role`. Delegates to the shared
 * {@link parseAttachEndpoint} (the one addressing-shape gate both backends run)
 * and tags the result with the Bun-only `surface` discriminant the merged
 * `Bun.serve` handler routes by. A Cloudflare DO needs no `surface` tag: it is
 * a dedicated actor, not a multiplexed handler.
 */
function buildSocketData(params: {
	principalId: string | undefined;
	role: string | undefined;
	hostId: string | undefined;
	deviceId: string | undefined;
	attachId: string | undefined;
	label: string | undefined;
}): AttachRelaySocketData | undefined {
	const endpoint = parseAttachEndpoint(params);
	return endpoint && { surface: 'attach', ...endpoint };
}
