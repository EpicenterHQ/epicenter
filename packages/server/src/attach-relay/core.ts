/**
 * The AttachRelay coordinator (ADR-0115): pair many client endpoints to one
 * host endpoint under a principal, and forward opaque bytes between them. This
 * is the byte-forwarding primitive of clause 4, generic only in the narrow
 * sense of clause 1: it forwards opaque bytes between two endpoints, addressed
 * by `principalId`, `hostId`, `deviceId`, `attachId`, and never by a route
 * name. It is not a routing product; it has one consumer (Super Chat attach).
 *
 * ## Transport-agnostic by design
 *
 * The coordinator holds no transport. It takes structural
 * {@link RelaySocket}s and returns connection handles a transport drives on its
 * socket's message and close: a Bun WebSocket server (`attach-relay/bun-server`),
 * a Cloudflare Durable Object (`attach-relay/cloudflare-do`), or a test double.
 * The coordinator never binds a port and never parses a `payload`.
 *
 * ## What it forwards, and how it addresses
 *
 * - A host registers under `(principalId, hostId)` (one host per pair).
 * - A client attaches under `(principalId, hostId, deviceId, attachId)`.
 * - Client to host: the client's opaque bytes reach the host stamped with the
 *   source endpoint `(deviceId, attachId)`, so the host knows which endpoint to
 *   answer. Attach and detach reach the host as lifecycle events on the same
 *   wire, so the host can push a fresh client its first snapshot and drop a
 *   gone one.
 * - Host to client: the host addresses one client endpoint per frame; the
 *   relay delivers it to that socket. There is no broadcast primitive: N
 *   clients is N host frames. Per-endpoint addressing is only how the host
 *   answers the right client; the relay is trusted transport, not an encryption
 *   boundary (ADR-0115 clause 2, the sealing layer was removed by amendment).
 *
 * The relay reads the envelope (`deviceId`, `attachId`) and nothing else: the
 * `payload` is opaque bytes it never decodes.
 */

import {
	type ClientEndpoint,
	type HostToRelayFrame,
	RELAY_CLOSE,
	type RelaySocket,
	type RelayToHostFrame,
} from './contracts.js';

/** A live host endpoint: its wire and the client endpoints attached to it. */
type HostEntry = {
	socket: RelaySocket;
	clients: Map<string, RelaySocket>;
};

/** The handle a transport drives for a registered host wire. */
export type HostConnection = {
	/** One inbound text frame from the host wire (a {@link HostToRelayFrame}). */
	receive(frame: string): void;
	/** The host socket closed; drop the host and evict its clients. */
	close(): void;
};

/** The handle a transport drives for an attached client wire. */
export type ClientConnection = {
	/** One inbound opaque frame from the client, forwarded to its host verbatim. */
	receive(payload: string): void;
	/** The client socket closed; detach it and tell the host. */
	close(): void;
};

const SEPARATOR = '\0';
const hostKey = (principalId: string, hostId: string): string =>
	`${principalId}${SEPARATOR}${hostId}`;
const attachKey = ({ deviceId, attachId }: ClientEndpoint): string =>
	`${deviceId}${SEPARATOR}${attachId}`;

/** Send onto a socket only if it is open, so a racing close is a no-op. */
function safeSend(socket: RelaySocket, data: string): void {
	if (socket.readyState !== 1 /* OPEN */) return;
	socket.send(data);
}

function sendToHost(socket: RelaySocket, frame: RelayToHostFrame): void {
	safeSend(socket, JSON.stringify(frame));
}

/**
 * Build one AttachRelay coordinator. Holds every live host endpoint and the
 * clients attached to each; a process runs one of these behind its transport.
 */
export function createAttachRelay(): {
	registerHost(params: {
		principalId: string;
		hostId: string;
		socket: RelaySocket;
	}): HostConnection;
	attachClient(params: {
		principalId: string;
		hostId: string;
		deviceId: string;
		attachId: string;
		socket: RelaySocket;
	}): ClientConnection;
	liveHostIds(principalId: string): string[];
} {
	const hosts = new Map<string, HostEntry>();

	return {
		/**
		 * The `hostId`s currently registered under `principalId`, the single source
		 * of truth for a host's `online` liveness (the host directory joins this
		 * with its retained membership+label). This reads the coordinator's own
		 * host set, so it is conflict-correct: a refused second registration
		 * (HOST_CONFLICT) never owned the entry, so it never appears here, and the
		 * incumbent stays listed. It exposes only host ids the coordinator already
		 * tracks; it reads no `payload` and no `label`, so the coordinator stays
		 * frame- and directory-blind (ADR-0115 clause 1).
		 */
		liveHostIds(principalId) {
			const prefix = `${principalId}${SEPARATOR}`;
			const ids: string[] = [];
			for (const key of hosts.keys()) {
				if (key.startsWith(prefix)) ids.push(key.slice(prefix.length));
			}
			return ids;
		},

		registerHost({ principalId, hostId, socket }) {
			const key = hostKey(principalId, hostId);
			if (hosts.has(key)) {
				// One host per `(principalId, hostId)`. A second registration is a
				// stale reconnect racing the old socket's close or a bug; refuse the
				// newcomer and leave the incumbent serving its clients.
				socket.close(RELAY_CLOSE.HOST_CONFLICT, 'host already registered');
				return { receive() {}, close() {} };
			}
			const entry: HostEntry = { socket, clients: new Map() };
			hosts.set(key, entry);

			return {
				receive(frame) {
					const parsed = parseHostFrame(frame);
					if (!parsed) return;
					// Address one client endpoint; the payload stays opaque. An
					// unknown endpoint (it detached mid-flight) drops silently.
					const client = entry.clients.get(attachKey(parsed));
					if (client) safeSend(client, parsed.payload);
				},
				close() {
					// Only evict if this is still the registered host: a refused
					// newcomer shares the key but never owned the entry.
					if (hosts.get(key) !== entry) return;
					hosts.delete(key);
					for (const client of entry.clients.values()) {
						client.close(RELAY_CLOSE.HOST_GONE, 'host disconnected');
					}
					entry.clients.clear();
				},
			};
		},

		attachClient({ principalId, hostId, deviceId, attachId, socket }) {
			const host = hosts.get(hostKey(principalId, hostId));
			if (!host) {
				// No live host endpoint for this pair; the attach cannot pair.
				socket.close(RELAY_CLOSE.HOST_NOT_FOUND, 'no live host');
				return { receive() {}, close() {} };
			}
			const endpoint: ClientEndpoint = { deviceId, attachId };
			const key = attachKey(endpoint);
			host.clients.set(key, socket);
			// Tell the host a client endpoint attached, so it pushes the first
			// snapshot. The host owns the initial-state contract; the relay only
			// reports the endpoint transition.
			sendToHost(host.socket, { ...endpoint, event: 'attach' });

			return {
				receive(payload) {
					// Forward the client's opaque bytes stamped with its source
					// endpoint, so the host answers the right client.
					sendToHost(host.socket, { ...endpoint, payload });
				},
				close() {
					// Only detach if this socket is still the one under the key: a
					// reconnect under the same endpoint may have replaced it.
					if (host.clients.get(key) !== socket) return;
					host.clients.delete(key);
					sendToHost(host.socket, { ...endpoint, event: 'detach' });
				},
			};
		},
	};
}

/**
 * Parse one host-wire frame to the endpoint-addressed shape the relay routes
 * by. Rejects anything that is not `{ deviceId, attachId, payload }`: the relay
 * accepts no route, channel, or capability field, so there is nowhere for one
 * to enter (ADR-0115 clause 1, PR #2277's presence guard).
 */
function parseHostFrame(frame: string): HostToRelayFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(frame);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.deviceId === 'string' &&
		typeof record.attachId === 'string' &&
		typeof record.payload === 'string'
	) {
		return {
			deviceId: record.deviceId,
			attachId: record.attachId,
			payload: record.payload,
		};
	}
	return undefined;
}
