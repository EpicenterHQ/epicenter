# 0121. Background sync is automatic and database-boundary merges are reviewable

- **Status:** Accepted
- **Date:** 2026-07-11
- **Relates:** [ADR-0088](0088-sign-in-is-an-enhancement-never-a-door.md)
- **Amended by:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md) (schema change and records replacement start a new records epoch); [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md) (schema changes publish a new application data generation while ordinary sync remains generation-blind); [ADR-0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md) (edited table state is reviewed against the latest head and admitted as forward intent); [ADR-0140](0140-portable-ownership-has-no-generic-whole-workspace-import.md) (the platform has no generic database or whole-workspace import planner)

## Context

Reviewable conflicts are valuable when a user deliberately combines two complete
databases. They are a different product during continuous synchronization:
detecting and retaining every overwritten scalar value requires per-cell causal
metadata, conflict records, acknowledgement, resolution mutations, garbage
collection, and UI that can block or trail background work. Most routine edits
touch different cells, while content that cannot tolerate scalar replacement is
already a Yjs document.

## Decision

Background synchronization never interrupts the user for scalar conflicts.
Causally ordered writes preserve their order; genuinely concurrent assignments
to different cells compose; concurrent assignments to the same cell resolve by
server acceptance order. Epicenter does not retain a background conflict inbox,
expose per-edit discard, or promise recovery of every overwritten scalar value.

Explicit database-boundary operations are reviewable and split by capability;
there is no universal import planner. Without retained deletion history a
destination cannot distinguish a stale source row from a never-seen one, and a
schema-blind planner cannot safely mint fresh ids because references may hide
in ordinary cells or opaque JSON. So the boundary flows divide by what they
may honestly promise about identity:

- A disruptive administrative replacement starts a new records epoch from one
  complete logical snapshot. Restore, endpoint movement, physical-clone
  adoption, or local-to-account promotion may each impose a different review
  and identity policy outside the sync engine.
- Copying selected content into an already-populated database is app-owned
  until the schema declares an explicit reference vocabulary; a generic
  planner does not guess how to remap inbound references.

Reviewable comparison operates on pinned source and destination logical
snapshots by table, row, and cell. Unambiguous work applies without review:
source-only rows and equal cells. The user applies a bulk preference to
differing cells and reviews genuine ambiguity. Applying a plan revalidates the
destination head, and the selected result is emitted as ordinary `createRow`,
`updateRow`, and `deleteRow` mutations; the sync protocol has no separate
merge verb.

A synchronized records schema change, restore, or wholesale replacement is not
a reviewable background merge. The administrator briefly rejects writes,
installs a complete logical snapshot as a new records epoch, and requires
replicas to resynchronize. Forgotten private work remains local and never enters
the new epoch automatically. The shared protocol owns only the epoch fence; it
does not own preparation, review, byte staging, or rollback policy.

A local-only database carries application tables and child documents, but no
actor identity, cursor, sync outbox, or dormant mutation history. Enabling sync
opens or creates the account database, installs its current snapshot, imports
the local rows and child docs logically, and begins recording normal mutations.
Promotion into a fresh account database preserves row identities; combining a
local database with an already-populated account database is the app-owned
copy flow above. The source stays intact until the imported mutations are
accepted.

Application identity is portable; replica identity is not. Logical exports keep
stable row ids and content but omit actor identity, cursors, and outboxes.
Every physical restore or copy, including a backup of a genuinely lost
replica, opens as an import source and mints a new actor identity: the
protocol cannot distinguish a restored lost replica from a live clone, and an
actor-preserving restore silently discards divergent writes when a reused
sequence number was already accepted with a different payload. Reopening the
same durable file after a crash is not a restore; its actor and outbox
continue, and sequence deduplication absorbs the retry.

## Consequences

- A long-offline device may overwrite a same-cell assignment made later by
  another device when its mutation reaches the server later. This is the stated
  tiebreak for concurrent scalar intent, not an attempt to infer human chronology
  from unreliable device clocks.
- There is no permanent version-history product hidden inside synchronization.
  Normal Undo emits another mutation. Replacing local state from Cloud is an
  explicit destructive rebootstrap, not selective outbox surgery.
- A signed-in replica may remain offline indefinitely. On return it installs the
  current server snapshot, reapplies its pending mutations, and continues without
  requiring retained log history.
- Reviewable comparison is useful beyond sign-in: compatible local files,
  backups, Cloud databases, and self-hosted databases all read through one
  logical snapshot interface, even though the identity policy differs by
  boundary flow. Replicas bound to an old records epoch are deliberately
  excluded from this generic merge promise. The first implementation is a
  summary with a bulk preference; a per-cell editor is built only when review
  volume earns it.
- A development-only observer may count remote operations that overlap a pending
  local cell, but aggregate diagnostics do not create a conflict-review product
  contract.
- Fields where losing one concurrent assignment is unacceptable must use a Yjs
  document or domain operations represented as rows. Counters, ledgers, and
  append-only facts are not implemented as read-modify-write scalar cells.

## Considered alternatives

- **Show a conflict editor after every background sync collision.** Rejected: it
  turns transport into permanent user data and recreates the causal metadata,
  resolution lifecycle, and history this design removes.
- **Use device timestamps or HLCs to approximate human chronology.** Rejected:
  clock skew has an unbounded failure mode and the metadata remains with every
  cell. The central sequencer already provides a deterministic order.
- **Copy the local SQLite file over the account database on sign-in.** Rejected:
  it destroys destination-only fields, replica metadata, and pending account
  work. Logical import uses the same mutation path as every other write.
- **Record a local-only outbox in case the user signs in later.** Rejected: a user
  who never signs in would accumulate unbounded transport history. Sign-in imports
  current state, not every historical keystroke.
