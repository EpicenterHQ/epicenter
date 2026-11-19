# 0121. Background sync resolves key conflicts by server order

- **Status:** Accepted
- **Date:** 2026-07-15
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at conflict resolution and at the outbox. Withdrawn: server acceptance order as the conflict rule, the refusal to store a device timestamp or a per-key clock, and the durable outbox this record's crash-recovery paragraph depends on. What survives is the product posture: no background conflict inbox, and no retained losing value.
- **Relates:** ADR-0088, [ADR-0092](0092-identity-is-the-partition.md), ADR-0119

## Context

Reviewing every concurrent scalar assignment would require causal metadata,
conflict records, acknowledgement, resolution commands, retention, and a user
interface that follows background synchronization forever. Most independent
record edits touch different keys, while merge-sensitive content belongs in a
Yjs document.

## Decision

Background record synchronization never interrupts the user for scalar
conflicts. Patches to different keys compose. Concurrent assignments or unsets
of the same key resolve by server acceptance order. Epicenter stores no
background conflict inbox, device timestamp, per-key causal clock, or retained
losing value.

Sync starts automatically for a runtime bound to a synchronized authority. The
public workspace and document APIs expose no manual push, pull, leader,
checkpoint, or conflict-resolution controls. Connectivity only changes how
quickly accepted state converges.

Explicit movement between authorities is a separate app-owned copy or import.
It reads inert logical snapshots and emits ordinary create, patch, and delete
commands. There is no universal merge planner, generic restore over a live
workspace, sign-in promotion, or cross-workspace transaction.

Application identity is portable; replica identity is not. Reopening the same
durable replica after a crash continues its actor and outbox. Copying or
restoring physical bytes creates an inert import source and never reuses actor
identity.

## Consequences

- A long-offline patch may win a same-key conflict when the server accepts it
  later. This is the stated deterministic rule, not inferred human chronology.
- Undo is another application patch. Synchronization is not version history.
- Products that cannot lose one concurrent contribution model independent
  facts as rows or use a Yjs document.
- Duplicate sync supervisors are harmless when pushes are idempotent and pull
  installation checks the shared cursor transactionally. Browser leadership is
  unnecessary.
- Imports and authority movement remain explicit product workflows rather than
  hidden sync modes.

## Considered alternatives

- **Show a conflict editor after background sync.** Rejected because it turns
  transport into permanent product data.
- **Use device timestamps or HLCs.** Rejected because skew has an unbounded
  failure mode and metadata remains with every key.
- **Expose manual sync controls.** Rejected because correctness does not depend
  on callers scheduling transport.
- **Copy a live SQLite file between authorities.** Rejected because it mixes
  application data with replica identity and pending intent.
