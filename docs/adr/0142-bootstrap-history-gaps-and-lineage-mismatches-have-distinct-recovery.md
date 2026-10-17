# 0142. Bootstrap, history gaps, and lineage mismatches have distinct recovery

- **Status:** Accepted
- **Date:** 2026-07-17
<!-- doc-path-check: ignore-next-line -->
- **Superseded by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`). Withdrawn: the three-way bootstrap, history-gap, and lineage-mismatch recovery taxonomy, which is unnecessary as separate mechanisms because merge is idempotent. The lineage question itself survives in a different form, as the authority's store lifetime. Note that `captureRecovery`, `startFresh`, `recovery-required`, and `history-expired` have zero references in `packages/` or `apps/`, so this record is unbuilt in source despite `specs/20260717T212450-two-plane-row-document-runtime.md:381` claiming otherwise.
- **Supersedes:** [ADR-0136](0136-replica-baseline-acquisition-uses-a-disposable-anchored-live-scan.md)

## Context

A fresh device and a valid device below the retained transport-history floor
both need complete current authority state. A restored or concurrently copied
private SQLite file is different: its receipt may disagree with the authority's
accepted lineage, so continuing could silently discard ambiguous local work.
Treating both conditions as generic synchronization failure either asks users to
repair routine staleness or hides a real safety stop.

## Decision

Fresh bootstrap and below-floor catch-up enter one hidden complete-state
acquisition. The client builds disposable scratch confirmed state, preserves all
open and sealed intents, catches the scratch state up to one fixed authority
head, and atomically promotes it. Local reading and editing continue from the old
confirmed state plus intent overlays while an existing replica rebuilds. A new
replica exposes its local overlay immediately with synchronization status still
syncing or pending; it does not report caught up until its first complete
confirmed state is installed. Operations that must fold against canonical
authority state, including explicit Device Add, wait for that state without
turning ordinary local editing into a network door.

Acquisition progress is never canonical or resumable. The authority publishes
no immutable snapshot, scan session, floor pin, or per-replica transfer state.
A crash, invalid page, or retention-floor race deletes scratch and restarts the
same acquisition. Applications do not receive a history-expired state. A large
automatic rebuild may expose passive progress but does not require permission.

A receipt or digest mismatch instead sets `recovery-required` and stops network
synchronization without making the local workspace read-only. Recovery captures
the workspace's current logical visible content into a separate reviewable copy.
The user may selectively recreate records from that copy in a fresh enrolled
replica.
Epicenter never merges divergent private SQLite histories automatically and
never treats a SQLite file as a portable sync artifact.

The app obtains that copy through `workspace.sync.captureRecovery()`. The copy
contains logical rows, compact document state, and KV only. It contains no
replica id, round, digest, checkpoint, acquisition scratch, or SQLite pages.
After preserving it, the app explicitly calls `workspace.sync.startFresh()` to
discard the halted Account sync lineage and acquire current authority state.
Selected recovered content is then recreated through ordinary application
commands under fresh row identities. The generic runtime does not overwrite
current authority rows or KV from the ambiguous copy.

## Consequences

- A device may stay offline indefinitely and quietly rebuild when it reconnects.
- Long-offline local edits remain automatically eligible after promotion.
- Routine history compaction creates no expiry policy or second user recovery
  flow.
- Divergent restored data cannot enter the current account silently.
- Recovery preserves ambiguous local content without overwriting newer authority
  state.
- Complete acquisition is covered by concurrency, floor-race,
  atomic-promotion, restart, and overlay-preservation tests.

## Considered alternatives

- **Expire replicas below a fixed schedule.** Rejected because fresh devices
  still need complete acquisition while expiry adds a manual recovery family.
- **Retain all transport history.** Rejected because one abandoned device could
  make authority storage unbounded.
- **Publish resumable snapshots.** Rejected because snapshot identity, retention,
  progress, and cleanup become a second transfer product.
- **Automatically merge a restored private database.** Rejected because the
  system cannot prove which ambiguous intents already entered authority order.
