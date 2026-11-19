# 0086. There is no live consumer for network-reachable capability reach; opensidian's cross-device tools are superseded by the super app, not migrated

- **Status:** Accepted (resolves [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md)'s Trigger to revisit)
- **Date:** 2026-07-01
- **Relates:** [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (names the trigger this resolves), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (the actual delivery vehicle, and the reason the trigger's premise no longer holds), ADR-0072 (its own daemon-reopening trigger, also resolved here), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (why Local Books is box-owned at all), [ADR-0085](0085-a-box-is-a-role-an-addressable-endpoint-plays-not-a-node-type.md) (the vocabulary this decision assumes)

## Context

ADR-0079's Trigger to revisit asks a forward-looking product question: is "reach my box" a power-user feature or a mass-market turnkey product, assuming a consumer exists or will exist to justify either answer. Grounded directly against the code and against the one concrete candidate consumer named in the (uncommitted, paused) capability-plane buildout plan: opensidian's relay-floor auto-mount of a `books` route. That consumer, and every other candidate checked (the CLI's `cross-device-tools` command, `mcp-gateway-catalog.ts`), routes over the old relay floor by `{device, route}`, not by an independently-managed `{baseUrl}`, so none of them is a genuine network reach to Local Books from a device other than whatever runs the super app. ADR-0080, decided the same day, already settled that the super app is the one delivery vehicle for cross-app chat and consumes Local Books as a local stdio subprocess, never over a network. Confirmed directly with the product owner: opensidian's own chat-with-cross-device-tools, the first place `composeToolCatalogs` was proven, is superseded by the super app, not a permanent separate surface that needs its own migration path.

## Decision

**There is no live consumer, current or planned, for a network-reachable per-app capability endpoint.** Local Books' capability reach stays exactly what it already is: a local stdio MCP subprocess (arm B, ADR-0080), consumed only by whatever process runs the super app, on the same machine. Opensidian's relay-floor consumption of Local Books is not migrated to a new capability-plane endpoint; it is retired along with opensidian's own chat prototype, since the super app is its successor.

This resolves ADR-0079's Trigger to revisit. The trigger asked "power-user or mass-market," a question about which *shape* a future consumer would need. The answer here is prior to that question: there is no consumer of either shape today, so no further spend goes toward either the power-user or the turnkey version until a real, named consumer exists.

## Consequences

<!-- doc-path-check: ignore-next-line -->
- The capability-plane buildout (`specs/20260630T120000-capability-plane-greenfield-buildout.md` and its handoff, never committed, and now removed from the worktree they sat in) loses its stated reason to exist. Its one named justification, migrating opensidian's consumer, is void, since that consumer is itself being retired. That work should not resume as scoped; picking it up again requires a new named consumer first.
- ADR-0072's own reopening trigger ("reopen the daemon... when there is a concrete need for multi-device chat with the books from a non-terminal client... and the shared Epicenter agent-chat client is the ready delivery vehicle") is now answered in the opposite direction its authors may have expected: the delivery vehicle exists, the super app, but it reaches Local Books locally, not by reopening a network daemon. The daemon-reopening trigger stays closed.
- The relay floor's channel layer keeps its existing deletion path, bound to the Whispering-sync milestone (ADR-0079), now with one less reason to delay: there is no in-flight migration left for it to wait on.
- This forecloses nothing permanently. Reopening a network-reachable capability endpoint later requires the same bar every deferred feature in this system requires: a real, named consumer, not a hypothetical one.

## Considered alternatives

- **Keep the capability-plane buildout going, migrating opensidian's consumer to direct Tailscale reach as planned.** Rejected: the consumer being migrated is itself being retired, so the migration would land nothing at the other end.
- **Leave ADR-0079's trigger open and unresolved, since it is phrased as a future product question.** Rejected: the trigger's premise, that a consumer exists or will exist, does not hold today. Leaving it open reads as still-undecided when the actual state is confirmed: no consumer, a stronger and more honest claim than "revisit later."

## Update 2026-07-07: reaffirmed against ADR-0115

ADR-0115 adds a hosted relay for Super Chat remote attach, and it does not reopen this decision. Network-reachable per-app capability reach stays refused. The AttachRelay is endpoint-addressed (`principalId`, `hostId`, `deviceId`, `attachId`), not route-addressed: it carries a live session between two of the principal's endpoints and exposes no route name, no route registry, no `exposedRoutes` presence, no MCP-over-relay platform surface, and no per-app endpoint directory. A session channel with one named consumer is a different thing than a capability route, and a second consumer of the primitive still requires a new ADR naming a real, live consumer, the bar this ADR set.
