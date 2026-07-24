/**
 * Presence wire protocol: the relay-owned peer list, plus the one frame the
 * node sends to publish its own presence identity.
 *
 * The relay owns presence (its `connections` map is the source of truth) and
 * broadcasts the FULL peer list on every membership change. The client stores
 * the latest list verbatim: there is no delta protocol and no client-side
 * reassembly, the frame IS the state.
 *
 * Presence is liveness and participant identity, not capability
 * advertisement: the payload is each peer's `nodeId`, `connectedAt`, and
 * `agentId`. Action manifests and route catalogs are not presence; actions
 * live on the workspace bundle, never on collaboration or the wire.
 *
 * Owned by the relay (`core.ts`, the sender); room clients read the frame
 * shape from their own copy of this contract.
 *
 * Schemas are TypeBox: they ARE valid JSON Schema at runtime, double as the
 * source of truth for the TypeScript types via `Static`, and feed
 * `typebox/compile`'s `Compile()` to produce checked-once validators reused
 * at every boundary. No hand-written duck-typing helpers.
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

/**
 * One peer's entry on the wire.
 *
 * `nodeId` is the peer's sync/presence participant identity; `connectedAt`
 * lets receivers render an "online since" affordance. `agentId` is the catalog
 * agent this peer answers as (ADR-0025), present only on a peer that mounted
 * with one (a resident daemon) and absent for ordinary participants. It is the
 * join key a picker uses to decorate a durable agent as live: the catalog owns
 * the agent's properties, presence only reports which agent ids are online now.
 */
export const PeerSchema = Type.Object(
	{
		nodeId: Type.String(),
		connectedAt: Type.Number(),
		agentId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type Peer = Static<typeof PeerSchema>;

/**
 * Server -> client: full set of currently-connected peers, pushed on every
 * membership or identity change. `peers` always excludes the receiver's
 * own install: the relay computes the list per-recipient so the client never
 * has to filter self.
 */
export const PresenceFrameSchema = Type.Object(
	{
		type: Type.Literal('presence'),
		peers: Type.Array(PeerSchema),
	},
	{ additionalProperties: false },
);
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

/**
 * Client -> server: publish this node's presence identity (its agent
 * designation). The relay stores it against the sending
 * socket's nodeId and rebroadcasts presence so peers see the update. Sent once
 * on connect. `agentId` is set only by a peer that mounted as a resident agent
 * (ADR-0025); ordinary participants omit it.
 */
export const PresencePublishFrameSchema = Type.Object(
	{
		type: Type.Literal('presence_publish'),
		agentId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type PresencePublishFrame = Static<typeof PresencePublishFrameSchema>;

/**
 * Pre-compiled validator for inbound presence frames. Used by the client to
 * narrow untrusted text frames at the receive boundary.
 */
export const checkPresenceFrame = Compile(PresenceFrameSchema);

/**
 * Pre-compiled validator for inbound `presence_publish` frames. Used by the
 * relay to validate a peer's published identity before storing.
 */
export const checkPresencePublishFrame = Compile(PresencePublishFrameSchema);
