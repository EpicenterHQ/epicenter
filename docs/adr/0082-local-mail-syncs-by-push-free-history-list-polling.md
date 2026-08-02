# 0082. Local Mail syncs by push-free `history.list` polling

- **Status:** Accepted
- **Date:** 2026-06-30
- **Amended by:** [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) at the write-through clause only: a write is no longer sent to Gmail from the request path. It is asserted locally (ADR-0198) and delivered by the account's one reconciler, which drains before it pulls. Gmail remains authority and the mirror still folds only what Gmail confirmed. Push-free polling, the single `historyId` cursor, and the full-resync-on-404 rule are untouched.
- **Relates:** [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (establishes Gmail permits per-device grants, unlike Local Books), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (the single-cursor CDC discipline this borrows), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (the write-through discipline this record originally borrowed, now withdrawn here by ADR-0199; Local Books is unaffected), [ADR-0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) (which process owns the poll loop), [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (the Gmail application identity, split out of this record on acceptance)

## Context

ADR-0081 settled that Gmail's OAuth concurrency policy permits each device to hold its own independent grant and mirror, unlike Local Books/QuickBooks. That left one open question for Local Mail: how a device's mirror actually learns about new mail. Two mechanisms were on the table: Cloud Pub/Sub push (`users.watch`) and plain interval polling of `users.history.list`, the same changefeed shape `local-books` already runs against QuickBooks's CDC endpoint.

The original draft rejected push on the grounds that it needs a publicly reachable webhook. That premise was wrong and is corrected here: `users.watch` publishes to a Pub/Sub topic, and a PULL subscription lets a long-lived local process consume notifications with no public endpoint at all. So the real question is not reachability. It is whether provisioning a topic and subscription per user, re-arming the watch every 7 days, and carrying a second sync path earn their cost against a timer.

Quota makes the comparison lopsided. `users.history.list` costs 2 quota units against a ceiling of 6,000 units per minute per user per project, so a single device polling every 30 to 60 seconds is nowhere near any limit (verified against Google's published Gmail API quota table, 2026-07-29).

## Decision

**Local Mail syncs by plain interval polling of `history.list`. There is no push, Pub/Sub topic, subscription, or webhook path.** Each device holds its own Gmail OAuth grant (per ADR-0081) and independently polls on a timer, with no triggering or "did something change" logic. The mirror follows `local-books`'s proven CDC discipline: one `historyId` cursor per account, advanced only inside the same transaction as the committed rows (ADR-0064's pattern), full resync on a 404/expired cursor.

**Withdrawn clause.** This record originally ended: "Writes are write-through: sent directly to Gmail first, folded into the mirror only after Gmail accepts (ADR-0061's pattern)." That is no longer the model and must not be read as direction. [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) replaced it: a write is asserted locally into a durable per-account map ([ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md)) and delivered later by the account's one reconciler, which drains before it pulls. What survives from the old clause is the part that was actually load-bearing and is unchanged: Gmail is authority, and the mirror is only ever written from what Gmail returned.

## Consequences

- No Pub/Sub topic or subscription lifecycle, no watch re-arm, no webhook receiver, and no second sync path to keep correct.
- New-mail latency is bounded by the poll interval (tens of seconds), not instant. This is an explicit refusal, not an oversight: the UX loss is small on a desktop app the user is looking at, and it deletes the entire push subsystem.
- Steady-state polling is not the quota cost driver; the initial full-mailbox import is. `history.list` costs 2 units per call while `messages.get` costs 20 per message, so a first sync of a large mailbox dominates any project's usage. Sizing and escape hatches for that cost belong to ADR-0188, which owns the application identity the quota is charged against.
- The revisit path, if instant delivery ever becomes a real requirement, is a Pub/Sub PULL subscription consumed by the same local engine, calling the same poll function early. It is purely additive and needs no server.
- **This record does not decide which Google OAuth client fronts the Gmail consent screen.** It originally did, on a hosted-vs-self-host axis that ADR-0188 shows was the wrong axis entirely. Application identity, the BYO override, and the device-only credential boundary are ADR-0188's, along with the cross-device refresh-token question this record had left open.

## Considered alternatives

- **Push via Pub/Sub PULL, consumed by the local engine.** Rejected for v1, on cost rather than on reachability: a topic and subscription to provision per user, a 7-day watch re-arm to keep alive, and a second code path to test, all to remove tens of seconds of latency from an app the user already has open. It stays the named upgrade path.
- **Push via Pub/Sub plus an HTTP webhook receiver.** Rejected: it does need a publicly reachable endpoint, which means Epicenter Cloud owning a live runtime surface in the mail path. Polling deletes that surface outright, and ADR-0188 forbids putting it back.
