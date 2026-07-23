/**
 * Cloudflare Durable Object backend for the {@link createAttachRelay}
 * coordinator (ADR-0115): the hosted Cloud transport that holds the live
 * rendezvous sockets between a signed-in desktop Super Chat host and a signed-in
 * phone/client of the same principal. It is the Cloud twin of the Bun transport
 * (`attach-relay/bun-server`); both drive the one runtime-agnostic coordinator.
 *
 * ## One DO per `(principalId, hostId)` pair
 *
 * The coordinator pairs a host with its clients in memory, so a host and every
 * client attaching to it MUST land on the same actor. {@link createDurableObjectAttachRelay}
 * derives the DO name from `(principalId, hostId)` ({@link attachHostDoName}), so
 * every socket of one pair routes to one DO. Each DO therefore holds exactly one
 * host entry; the coordinator is reused verbatim, not cloned. The `principalId`
 * is the partition: a client whose bearer resolves to another principal, even one
 * guessing a `hostId`, is stamped with its OWN principal and routes to its own
 * (empty) DO, so it pairs with no host, HOST_NOT_FOUND. That is the same
 * account-isolation invariant `cloud-attach.test.ts` proves through the mount.
 *
 * ## Standard accept, not the hibernation API
 *
 * This backend accepts sockets with `server.accept()` rather than the WebSocket
 * Hibernation API. A live attach keeps both ends online (the
 * relay stores no frames and needs both peers, ADR-0115 clause 5), so pinning the
 * DO in memory for the connection's life is honest: the in-memory coordinator
 * stays coherent with its open sockets with no attachment serialization and no
 * rebuild-on-wake. Hibernation would also have to replay the coordinator's
 * per-client `attach` lifecycle event on every wake, re-pushing snapshots the
 * host already sent; standard accept sidesteps that entirely. This DO owns no
 * `ctx.storage` and arms no alarm: it is a pure socket router. Hibernating a
 * connected-but-idle attach is a deferred optimization behind this same seam, not
 * a correctness need for a live session.
 *
 * ## RelaySocket compatibility
 *
 * Cloudflare's `WebSocket` exposes `send`, `close(code, reason)`, and
 * `readyState`, so it structurally satisfies {@link RelaySocket} and the raw
 * socket is handed straight to the coordinator with no wrapper.
 */

import { DurableObject } from 'cloudflare:workers';
import { asPrincipalId } from '@epicenter/identity';
import {
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from '@epicenter/sync/auth-subprotocol';
import { attachHostDoName } from '../principal.js';
import {
	type AttachRelayUpgradeHandler,
	parseAttachEndpoint,
} from './contracts.js';
import { createAttachRelay } from './core.js';

/**
 * The AttachRelay pair actor: one {@link createAttachRelay} coordinator behind a
 * Cloudflare Durable Object. Cloudflare instantiates it per DO name (one per
 * `(principalId, hostId)` pair), and `fetch` is its only surface, a 101-returning
 * WebSocket upgrade. It touches no `ctx.storage` and arms no alarm.
 */
export class AttachRelay extends DurableObject {
	/**
	 * The runtime-agnostic relay coordinator for this pair's sockets. A plain
	 * field initializer suffices: standard-accept sockets pin the DO in memory, so
	 * there is no hibernation restore to run in the constructor.
	 */
	private readonly relay = createAttachRelay();

	/**
	 * Accept one authenticated attach upgrade. The Worker's attach route has
	 * already resolved the bearer, stamped `principalId` server-side, and routed
	 * this request to the DO for its `(principalId, hostId)` pair; the DO reads the
	 * endpoint quadruple back off the forwarded URL and validates its shape.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Method not allowed', { status: 405 });
		}

		const url = new URL(request.url);
		const endpoint = parseAttachEndpoint({
			principalId: url.searchParams.get('principalId') ?? undefined,
			role: url.searchParams.get('role') ?? undefined,
			hostId: url.searchParams.get('hostId') ?? undefined,
			deviceId: url.searchParams.get('deviceId') ?? undefined,
			attachId: url.searchParams.get('attachId') ?? undefined,
		});
		if (!endpoint) {
			return new Response('Bad attach request', { status: 400 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();

		// Register or attach on the coordinator. It may synchronously close `server`
		// here (HOST_CONFLICT for a second host, HOST_NOT_FOUND for a client with no
		// live host); the 101 still completes and the client reads the app close
		// code.
		const connection =
			endpoint.role === 'host'
				? this.relay.registerHost({
						principalId: endpoint.principalId,
						hostId: endpoint.hostId,
						socket: server,
					})
				: this.relay.attachClient({
						principalId: endpoint.principalId,
						hostId: endpoint.hostId,
						deviceId: endpoint.deviceId,
						attachId: endpoint.attachId,
						socket: server,
					});

		server.addEventListener('message', (event) => {
			// The relay wire is opaque JSON text; a binary frame is not part of the
			// contract, so ignore it rather than coerce it to `[object ArrayBuffer]`.
			if (typeof event.data === 'string') connection.receive(event.data);
		});
		const disconnect = () => connection.close();
		server.addEventListener('close', disconnect);
		server.addEventListener('error', disconnect);

		// Echo only the main subprotocol on the 101, so a `bearer.<token>` a browser
		// offered is never round-tripped back to it.
		const headers = new Headers();
		const offered = parseSubprotocols(
			request.headers.get('sec-websocket-protocol'),
		);
		if (offered.includes(MAIN_SUBPROTOCOL)) {
			headers.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
		}
		return new Response(null, { status: 101, webSocket: client, headers });
	}
}

/**
 * Build the Cloud relay backend over a `DurableObjectNamespace`, the seam
 * {@link mountAttachRelayApp}'s `resolveRelay` returns on Cloudflare. Resolves
 * each upgrade to the DO for its `(principalId, hostId)` pair and forwards the
 * request (a 101-returning `fetch`), stamping the server-resolved principal over
 * any client-supplied value first. The
 * `idFromName` derivation and the `fetch`-as-upgrade convention live here, in the
 * Cloudflare backend, never in the backend-blind mount.
 */
export function createDurableObjectAttachRelay(
	namespace: DurableObjectNamespace<AttachRelay>,
): AttachRelayUpgradeHandler {
	return {
		handleUpgrade({ request, principalId, hostId }) {
			if (!hostId) {
				// Cannot pick the pair's DO without a host id. Refuse before any DO is
				// instantiated, the same 400 the DO returns for an incomplete endpoint.
				return new Response('Bad attach request', { status: 400 });
			}
			const name = attachHostDoName(asPrincipalId(principalId), hostId);
			const stub = namespace.get(namespace.idFromName(name));
			// Stamp the server-resolved principal over any client-supplied value, then
			// forward. Reconstructing the request is fine on Cloudflare: it matches the
			// socket by the DO it routes to, not by request-object identity the way
			// Bun's `server.upgrade` does.
			const url = new URL(request.url);
			url.searchParams.set('principalId', principalId);
			return stub.fetch(new Request(url.toString(), request));
		},
	};
}
