# 0081. Per-upstream OAuth concurrency decides whether a materialized mirror is box-owned or device-local

- **Status:** Accepted
- **Date:** 2026-06-30
- **Relates:** [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) (the box holds immovable, sensitive resources; this names which resources are actually forced to be box-only), ADR-0061 (Local Books serves facts from the mirror), ADR-0064 (one realm CDC cursor), ADR-0075 (self-host removes the third-party-operator constraint that would otherwise block replicating a mirror to other devices)

## Context

ADR-0079 modeled "cloud-upstream apps" (Local Books, Gmail next) as one category: each one's data is immovable and sensitive, so it materializes into one box-owned SQLite mirror, and other devices reach it only as MCP tool calls, never their own copy. That assumption was tested by asking a narrower question: could a device instead hold its own independent mirror, talking to the upstream directly, with no box in the loop at all? The answer is not the same for every upstream, and it is decided by a fact about the upstream's own OAuth implementation, not by anything Epicenter controls.

Checked directly against each provider's own behavior:
- **QuickBooks Online (Intuit):** refresh tokens rotate on every use, invalidating the prior token; concurrent refresh from two independent holders of the same connection races (confirmed: Intuit developer community, Nango's QuickBooks OAuth writeup). Separately, and more decisively: Intuit allows **exactly one active OAuth connection per company realm per app** — a second device's authorization attempt disconnects the first (`app_already_purchased`), confirmed against Intuit's own developer community answer. There is no workaround that gives two devices their own independent QuickBooks connection to the same company.
- **Gmail (Google):** Google allows **up to 100 concurrent refresh tokens per account per OAuth client id**. Multiple devices can each hold their own independent grant and their own `historyId` sync cursor, polling `users.history.list` directly, with no shared-token race and no per-realm connection limit (confirmed: Google's OAuth2 and Gmail API documentation).

## Decision

**Whether a cloud-upstream app's mirror can be materialized independently per device, or must stay owned by exactly one box, is decided per-upstream by that upstream's own OAuth/connection concurrency policy. It is not a property of "cloud-upstream apps" as a category.**

- **Local Books stays box-owned.** Intuit's one-connection-per-realm-per-app limit forecloses independent per-device QuickBooks connections outright, not just as a race-condition risk. A device without a reachable box either queries the box live (MCP tool calls, today's model) or, if ever built, receives a read-only replicated copy of the box's mirror — but it never holds its own QuickBooks connection.
- **Gmail may materialize per device.** Google's concurrency ceiling supports each device authorizing independently and syncing its own mirror directly against the Gmail API, with no box dependency, no replication channel, and no always-on machine required for Gmail specifically.

## Consequences

- "Cloud-upstream apps refuse the mesh, materialize centrally" (the working assumption since ADR-0072/0073) is correct for Local Books by external necessity, and was never a universal law. Any future cloud-upstream app integration must check its upstream's own OAuth concurrency policy before assuming either topology; do not generalize Local Books' constraint or Gmail's freedom to a new provider without checking.
- Gmail can ship as a genuinely independent per-device materializer: no box, no always-on machine, and no replication channel are needed for a device to hold its own grant and mirror. "Device" means a machine that can run the engine. This concurrency freedom never became a phone client: [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) makes Local Mail desktop-first, and [ADR-0098](0098-local-mail-state-round-trips-through-gmail.md) gives the phone Gmail's own app. What Google's ceiling buys is many desktops, not a mobile port.
- Local Books on a device with no reachable box stays read-unavailable under today's model. Closing that gap requires either keeping the box reachable when needed (cheapest, already works) or building box-to-device mirror replication (new scope, not built, and only worth it if offline book-browsing on a device with no box access becomes a real product requirement).
- ADR-0079's framing of "the box holds the heavy, immovable, sensitive resources" should be read as a per-resource fact to verify, not a default assumed for every future cloud-upstream integration.

## Considered alternatives

- **Assume every cloud-upstream app is box-owned-only by default.** Rejected as a blanket rule: correct for Local Books, but needlessly limits Gmail, which Google's own concurrency policy already supports independently — defaulting Gmail to box-owned would forfeit offline per-device mail with no underlying constraint forcing it.
- **Assume every cloud-upstream app can materialize independently per device by default.** Rejected: would silently break Local Books. Two devices each authorizing QuickBooks against the same company realm disconnect each other; this is enforced by Intuit, not a risk Epicenter's own engineering discipline can route around.
