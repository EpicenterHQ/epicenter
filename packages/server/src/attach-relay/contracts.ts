/**
 * Vocabulary for the AttachRelay (ADR-0115): Epicenter forwards live Super Chat
 * bytes between two authenticated endpoints of one principal, a signed-in client
 * and a desktop Super Chat host. The relay is endpoint-addressed, never
 * route-addressed: it routes by the quadruple `principalId`, `hostId`,
 * `deviceId`, `attachId`, and by nothing else. There is no route name, no route
 * registry, no capability field. Those are the relay-floor organs deleted in
 * PR #2277, and endpoint addressing is what keeps them from having anywhere to
 * live (ADR-0115 clause 1).
 *
 * ## What the relay owns
 *
 * The relay owns the endpoint envelope and socket fan-out. It does not own Super
 * Chat command semantics, host snapshots, tool names, or local-source reach. The
 * payload is trusted transport data: hosted Cloud may observe it, but the relay
 * still stores no frames and exposes no route or capability surface.
 *
 * @see `attach-relay/core.ts` for the coordinator that consumes these types.
 */

/**
 * The minimal per-connection surface the coordinator drives, structural by
 * design so a Bun `ServerWebSocket`, a browser `WebSocket`, and a test double
 * all satisfy it without a wrapper.
 *
 * `send` carries one opaque string frame; the coordinator never inspects it
 * beyond the envelope the host wire wraps it in. `readyState` follows the
 * WebSocket spec (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3) so the coordinator
 * can skip a send onto a socket racing closed.
 */
export type RelaySocket = {
	send(data: string): void;
	close(code: number, reason: string): void;
	readonly readyState: number;
};

/**
 * The address of one client endpoint under a host: the `deviceId` (which
 * signed-in device) and the `attachId` (which attach session on that device).
 * The `principalId` and `hostId` are implicit on a host's own wire: a host
 * registered once under them, so every frame on its wire is already scoped to
 * that host endpoint. This is the whole of the relay's addressing on the host
 * wire, and it names no route.
 */
export type ClientEndpoint = {
	deviceId: string;
	attachId: string;
};

/**
 * A frame the relay delivers to the host. Either a client endpoint's lifecycle
 * transition (it attached or detached, so the host can push it an initial
 * snapshot or drop it) or that endpoint's opaque command bytes. The relay
 * generates the lifecycle events from the socket set it already observes; it
 * never parses the `payload`. Discriminated by which of `event`/`payload` is
 * present, so the envelope stays a pair of endpoint ids plus one opaque field,
 * never a routing verb table.
 */
export type RelayToHostFrame =
	| (ClientEndpoint & { event: 'attach' | 'detach' })
	| (ClientEndpoint & { payload: string });

/**
 * A frame the host sends the relay: bytes addressed to exactly one client
 * endpoint. There is no broadcast frame: the host addresses each client endpoint
 * on its own. Fan-out to N clients is N of these, never one frame the relay
 * expands.
 */
export type HostToRelayFrame = ClientEndpoint & { payload: string };

/**
 * The identity and request a relay backend needs to accept one authenticated
 * attach upgrade. `principalId` is the authenticated principal stamped
 * server-side by the mount (the instance principal on self-host, the OAuth
 * subject on Cloud), never a query value. The endpoint ids come from the connect
 * query; the backend validates their presence for the given `role` through
 * {@link parseAttachEndpoint}.
 */
export type AttachUpgrade = {
	request: Request;
	principalId: string;
	role: string | undefined;
	hostId: string | undefined;
	deviceId: string | undefined;
	attachId: string | undefined;
	/**
	 * A host endpoint's human label for the directory ("Braden's Mac"), read off
	 * the connect query by the mount and recorded in the host directory
	 * (ADR-0115 clause 3: a directory field, not a route/capability). It never
	 * reaches the coordinator, which stays label-blind; only a `role=host`
	 * connect carries it, and a client connect ignores it.
	 */
	label?: string;
};

/**
 * The relay backend seam the mount drives: it accepts one authenticated
 * upgrade and returns the HTTP response the route returns verbatim. The Bun
 * backend ({@link import('./bun-server.js')}) returns a synchronous `Response`;
 * the Cloudflare backend ({@link import('./cloudflare-do.js')}) forwards to a
 * Durable Object stub and returns a `Promise<Response>`. Both satisfy this one
 * seam, so the mount is backend-blind.
 */
export type AttachRelayUpgradeHandler = {
	handleUpgrade(upgrade: AttachUpgrade): Response | Promise<Response>;
};

/**
 * A validated attach endpoint: the server-stamped `principalId` plus the
 * connect query's `role` and its role-specific ids. A host registers under
 * `(principalId, hostId)`; a client attaches under the full quadruple. This is
 * the one addressing shape both transports accept, and it names no route,
 * channel, or capability field (ADR-0115 clause 1).
 */
export type AttachEndpoint =
	| { role: 'host'; principalId: string; hostId: string; label?: string }
	| {
			role: 'client';
			principalId: string;
			hostId: string;
			deviceId: string;
			attachId: string;
	  };

/**
 * Shape a validated {@link AttachEndpoint} from the server-stamped `principalId`
 * and the connect query's ids, or `undefined` if the shape is incomplete for the
 * `role`. Both backends (Bun `bun-server`, Cloudflare `cloudflare-do`) run this
 * one validator, so the relay's addressing shape is enforced identically: it
 * accepts only the endpoint quadruple, never a route, channel, or capability
 * field, so there is nowhere for one to enter (ADR-0115 clause 1).
 */
export function parseAttachEndpoint(params: {
	principalId: string | undefined;
	role: string | undefined;
	hostId: string | undefined;
	deviceId: string | undefined;
	attachId: string | undefined;
	label?: string | undefined;
}): AttachEndpoint | undefined {
	const { principalId, role, hostId, deviceId, attachId, label } = params;
	if (!principalId || !hostId) return undefined;
	if (role === 'host') {
		// `label` is optional directory metadata; a host with no label is valid and
		// the directory falls back to its `hostId`.
		return { role: 'host', principalId, hostId, ...(label ? { label } : {}) };
	}
	if (role === 'client') {
		if (!deviceId || !attachId) return undefined;
		return { role: 'client', principalId, hostId, deviceId, attachId };
	}
	return undefined;
}

/** Application close codes the relay uses on the client and host wires. */
export const RELAY_CLOSE = {
	/** A client attached to a `(principalId, hostId)` with no live host. */
	HOST_NOT_FOUND: 4404,
	/** The client's host endpoint dropped; its attach cannot outlive it. */
	HOST_GONE: 4410,
	/** A second host tried to register a `(principalId, hostId)` already held. */
	HOST_CONFLICT: 4409,
} as const;
