# 0085. A box is a role an addressable endpoint plays, not a distinct node type

- **Status:** Accepted (a terminology and mental-model fix; no decision in ADR-0079 is reversed)
- **Date:** 2026-06-30
- **Relates:** [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (introduces "the box," this ADR reframes it), [ADR-0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) (Epicenter is one runnable star, reached by URL and token), ADR-0070 / ADR-0075 (self-host is the same shape as hosted, not a new mode), [ADR-0078](0078-inference-is-a-url-addressed-connection-the-relay-floor-carries-only-tools.md) (the `{baseUrl, token?}` connection primitive), [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) / [ADR-0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md) (consumers that need this reframing to reason correctly about which endpoint they are pointed at)

## Context

ADR-0079 introduced "the box" (illustrated as a Mac Studio) as if it named a distinct kind of node in the topology, standing apart from "the star" (Epicenter Cloud or a self-hosted instance, ADR-0069/0070/0075). But ADR-0079's own decision 4 already treats capability and inference as one connection primitive, the same `{baseUrl, token?}` shape the star uses (ADR-0078). Read together, those two facts are in tension: the prose implies three kinds of infrastructure (Cloud, box, device), while the architecture only actually has two (a device that runs an app, and an addressable service reached as `{baseUrl, token?}`). Left unreframed, a reader infers Epicenter operates or specially supports a "box" tier, which is exactly what ADR-0079's own product fork (Epicenter owns zero box transport) already refuses.

## Decision

**A "box" is not a node type. It is the role an addressable service plays when a user runs it personally, for a capability hosted sync cannot or will not run for them.** Every addressable service in this system, Epicenter Cloud, a self-hosted star, a personal capability endpoint, is the same `{baseUrl, token?}` shape. Whether "the box" and "the star" are the same physical machine is a deployment fact, not an architectural one:

- **A user who self-hosts their whole star: their star IS their box.** One process serves sync, `/v1`, and `/mcp`, on the same machine, at the same address. No separate concept is needed, and no separate address exists.
- **A user who uses hosted sync (Epicenter Cloud) but also runs an app forced to be personally owned (Local Books, by Intuit's one-connection-per-realm limit): their box is a second, different address from their sync star.** Epicenter Cloud's `{baseUrl}` carries sync; their own machine's `{baseUrl}` carries that one capability. Two addresses, not because there are two kinds of infrastructure, but because two independent services happen to be involved.

There is no third node type anywhere in this. A device reaching an app's data always resolves to one or more `{baseUrl, token?}` connections; some of those addresses happen to be Epicenter's, some happen to be the user's own, and which is which is a per-deployment fact, never a fixed architectural role.

## Consequences

- Retire "the box" as a proper noun implying a special, always-on, Mac-Studio-shaped concept. When the role needs naming, say "a capability endpoint" or "an endpoint you run yourself"; otherwise, just say "the star" or "a connection," as ADR-0069/0078 already do.
- Local Books' daemon is a capability endpoint, nothing more. When its owner self-hosts their whole star on the same machine, it is not a second address at all, only another surface the one star exposes.
- No decision in ADR-0079 changes: still two planes, still MCP scoped to ADR-0081's exception, still the freeze bound to the Whispering-sync milestone. Only the vocabulary and the mental model change, so a reader does not infer Epicenter operates or specially supports box infrastructure.
- **Coordination note:** as of this date, ADR-0079 has an in-progress, uncommitted elaboration in a parallel session (box surface primitives, a capabilities directory, headless box identity, vault placement). That work is complementary, not contradictory, to this ADR; it still describes the same `{baseUrl, token?}` shape, only with more built-out mechanism. Whoever lands that draft should fold in this ADR's terminology rather than reintroduce "box" as a proper noun.

## Considered alternatives

- **Keep "box" as a distinct third node type.** Rejected: contradicts ADR-0079's own decision 4 (capability and inference already share one connection primitive with the star) and invites the reader to think Epicenter operates or specially supports box infrastructure, which ADR-0079's product fork explicitly refuses.
- **Rename "box" to a single replacement term everywhere it appears (ADR-0072, ADR-0073, ADR-0079, related specs).** Considered, not done here: a full rename sweep is a larger, separate cleanup with its own review cost. This ADR settles the concept; a terminology sweep across existing prose is optional follow-up, not required for the model to be correct.
