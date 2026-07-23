/**
 * The attach host directory entry (ADR-0115): the whole of what a
 * signed-in client may learn about an attachable Super Chat host before it
 * attaches. A client discovers a host by `hostId`, a human `label`, and a
 * liveness `status`, and by nothing else. The directory names what to dial, not
 * what the host can do.
 *
 * ## Why this is a closed schema
 *
 * With one consumer, an attachable host is a Super Chat host by definition
 * (ADR-0115 clause 3), so there is no capability field to carry: adding one
 * would be `exposedRoutes` in a closed-enum costume. This entry is therefore a
 * `.onUndeclaredKey('reject')` schema, so any route-, capability-, action-, or
 * tool-shaped field (`capability`, `route`, `exposedRoutes`, `action`, `tools`,
 * `methods`, `method`, `path`, `name`, `topic`, `toolName`, a `tools/list` or
 * `tools/call` verb) fails to parse. That is PR #2277's presence-schema guard,
 * re-homed onto the AttachRelay directory: the directory cannot grow into a
 * capability registry, because an undeclared key has nowhere to land.
 *
 * ## Where this sits
 *
 * This is the account-and-device-layer directory ADR-0115 clause 3 puts above
 * the relay, beside the device grants (`device-grants.ts`), never inside the
 * relay coordinator (`core.ts`), which stays byte-, frame-, key-, and
 * directory-blind: it forwards opaque bytes addressed by `principalId`,
 * `hostId`, `deviceId`, `attachId`, and never learns a directory exists.
 *
 * ## How membership and liveness split (the two facts a status is)
 *
 * A directory entry is a join of two facts that live in different owners:
 * - **membership + label** ("this principal's known desktops and their names")
 *   is what {@link createHostDirectory} retains. A host publishes itself by the
 *   act of connecting as a host (`role=host`, the mount records `hostId`+`label`
 *   here); a client never performs that act, so it is structurally absent. There
 *   is no host/client discriminator to store or filter: membership IS the trace
 *   of the host-register act. Membership is retained after disconnect, so an
 *   asleep desktop still lists as `offline` rather than vanishing.
 * - **liveness** ("is a host socket live right now") belongs to the coordinator
 *   (`core.ts` `liveHostIds`), the single conflict-correct source. A
 *   {@link HostDirectoryReader} joins the two at read time, so a crashed host is
 *   never a stale `online`: the coordinator drops it, and the retained
 *   membership renders `offline`.
 *
 * The store is in-memory and per-process (a restart forgets membership, exactly
 * as the grant store and coordinator do); persisting it is deferred until a real
 * need earns it. The `unreachable` status is emitted only by a store that can
 * hold "claimed online but the socket is dead" (the Cloud per-principal index,
 * deferred); the Bun self-host reader here emits only `online`/`offline`, and
 * the client's ask-gate treats `offline` and `unreachable` identically.
 */

import { type } from 'arktype';

/**
 * A host's liveness in the directory, the whole signal a client dials on. Three
 * states, because the phone must tell "wake your desktop" from "reconnecting"
 * (ADR-0115):
 * - `online`: the host endpoint is registered and reachable for a fresh attach.
 * - `offline`: the desktop is not connected at all (asleep or shut down).
 * - `unreachable`: the host is known but its live channel is not usable right
 *   now (its relay socket dropped, or a partition), so a fresh attach cannot
 *   form even though the desktop is not definitively gone.
 *
 * Both `offline` and `unreachable` deny a new local-source question and both
 * still allow reading synced history: reading is a durable-replica read that
 * needs no live host (ADR-0055), while asking needs the live session. The two
 * are kept distinct so a client renders the right recovery, never so the relay
 * routes on them; the relay never sees this enum.
 */
export const AttachHostStatus = type("'online' | 'offline' | 'unreachable'");
export type AttachHostStatus = typeof AttachHostStatus.infer;

/**
 * One attachable Super Chat host, as a client discovers it. Exactly `hostId`,
 * `label`, and `status`: the id to dial, the human name to show, and whether it
 * is live. The schema rejects undeclared keys, so it can never describe what the
 * host exposes (ADR-0115 clause 3); that refusal is the whole point.
 */
export const AttachHostDirectoryEntry = type({
	/** The endpoint id a client dials to attach; never a route name. */
	hostId: 'string > 0',
	/** The operator's human label for this host ("Braden's Mac"). */
	label: 'string',
	/** Whether the host is live for a fresh attach. */
	status: AttachHostStatus,
}).onUndeclaredKey('reject');
export type AttachHostDirectoryEntry = typeof AttachHostDirectoryEntry.infer;

/**
 * The read seam a discovery mount drives: given the server-stamped principal,
 * return that principal's host directory entries. One deployment binds one
 * backend behind it (the Bun self-host reader below; a Cloud per-principal index
 * later), exactly the `resolveRelay` shape, so the mount stays
 * backend-blind. Async so a Durable-Object-backed index can satisfy it.
 */
export type HostDirectoryReader = {
	list(
		principalId: string,
	): AttachHostDirectoryEntry[] | Promise<AttachHostDirectoryEntry[]>;
};

/** One retained host membership record: the id to dial and its human label. */
type HostMembership = { hostId: string; label: string };

/**
 * The retained membership+label half of the directory (the liveness half is the
 * coordinator's `liveHostIds`). A host is recorded by the act of connecting as a
 * host and is kept after it disconnects, so an asleep desktop still lists. This
 * holds no host/client discriminator and no status: status is computed at read
 * time by joining with the coordinator, so this store can never drift into a
 * stale `online`.
 */
export type HostDirectory = {
	/**
	 * Record (or refresh the label of) a host under a principal. Called by the
	 * mount when a `role=host` endpoint connects; idempotent, so a reconnect or a
	 * refused conflicting registration only upserts the same membership.
	 */
	record(principalId: string, hostId: string, label: string | undefined): void;
	/** Every retained host membership under a principal, in insertion order. */
	entries(principalId: string): HostMembership[];
};

/** Build one in-memory host directory. A Bun deployment holds one per process. */
export function createHostDirectory(): HostDirectory {
	/** principalId -> (hostId -> label). Partitioned by principal, never merged. */
	const byPrincipal = new Map<string, Map<string, string>>();

	return {
		record(principalId, hostId, label) {
			if (!hostId) return;
			const hosts = byPrincipal.get(principalId) ?? new Map<string, string>();
			// A blank label falls back to the hostId, so an entry always has a
			// non-empty `label` the closed schema accepts.
			hosts.set(hostId, label && label.length > 0 ? label : hostId);
			byPrincipal.set(principalId, hosts);
		},
		entries(principalId) {
			const hosts = byPrincipal.get(principalId);
			if (!hosts) return [];
			return Array.from(hosts, ([hostId, label]) => ({ hostId, label }));
		},
	};
}
