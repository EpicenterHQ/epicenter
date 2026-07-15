/**
 * The branded `AgentId` type: the stable, durable address of an answering agent.
 *
 * An agent is a participant declared by configuration (a hosted cloud agent, an
 * explicit local agent, or cloud job) with a fixed model, a curated toolset,
 * and a runtime. The `AgentId` is how a conversation names the one agent it is
 * bound to (`conversations.agent`, ADR-0025): the durable, human-authored address
 * that survives a redeploy or a move to a new machine, unlike the per-install
 * {@link NodeId} (transport identity) or the Yjs `clientID` (runtime CRDT identity)
 * that churn underneath it.
 *
 * Agent ids are authored in configuration, not generated: a constant like
 * `epicenter-cloud` for the hosted cloud agent, or a user-given agent name.
 * Presence resolves a live `AgentId` to whatever `NodeId` currently hosts it.
 */

import type { Brand } from 'wellcrafted/brand';

/**
 * Branded string naming one answering agent. The brand prevents accidental
 * mixing with a {@link NodeId}, a `PrincipalId`, or a room guid: an agent address is
 * not a transport id.
 *
 * At trusted call sites that receive a known authored `string`, brand it with
 * {@link asAgentId}.
 */
export type AgentId = string & Brand<'AgentId'>;

/**
 * Syntactic sugar for `value as AgentId`. The constrained `string` parameter is
 * what earns it over a raw `as` (callers can't accidentally widen to `unknown`).
 * The only place in the codebase where `as AgentId` should appear.
 */
export const asAgentId = (value: string): AgentId => value as AgentId;
