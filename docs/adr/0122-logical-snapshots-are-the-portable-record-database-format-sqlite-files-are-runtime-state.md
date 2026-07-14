# 0122. Logical snapshots are the portable records database format; SQLite files are runtime state

- **Status:** Superseded
- **Date:** 2026-07-11
- **Relates:** [ADR-0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md), [ADR-0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md)
- **Amended by:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md) (replacement reuses the logical snapshot format but has no shared staging protocol); [ADR-0131](0131-every-durable-records-materialization-carries-its-canonical-descriptor.md) (SQLite remains runtime state but carries the canonical descriptor for independent inspection)
- **Superseded by:** [ADR-0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md)

## Context

Epicenter materializes record data in ordinary SQLite tables, but a physical
SQLite file also contains engine-specific pages, indexes, storage migrations,
and replica-private synchronization state. Bootstrap, import, restore,
Cloud-to-self-host movement, and administrative replacement need one database
image that crosses those runtime boundaries without copying actor identity,
cursors, or pending outboxes.

## Decision

The portable format for an Epicenter records database is a logical snapshot,
never a physical SQLite file, WAL, or page stream. The snapshot identifies its
records schema hash and carries the live table rows, expressed through the
same table, row, field, and JSON value vocabulary as the mutation protocol.
Deletion is physical absence, so a snapshot's size follows the live dataset;
it carries no deletion history. Preference KV lives in the workspace's eager KV
Yjs document, which has its own portable encoding and is not part of the record
snapshot.

A synchronization checkpoint wraps that logical state with its server sequence,
actor high-water marks, generation, chunk manifest, and integrity checks. Those
fields make an accepted mutation prefix replaceable; they are not application
data. A local SQLite file is one runtime materialization of the logical state
plus private storage revision, actor, cursor, outbox, and quarantine state. It
is neither the portable export nor the identity of the replica.

Every database-boundary operation reads and writes through the logical snapshot
interface. Sync retains only the current checkpoint. Backup, history, or an
engine-specific fast clone may choose different retention or transfer
mechanisms, but they must preserve and verify the same logical image rather than
becoming a second database format.

Collaborative child documents remain a separate lazy plane with their own
format hashes and portable encoding. A record snapshot preserves the row
identities from which child-document addresses are derived; it does not carry
document format declarations or inline an eager physical copy of every body.

## Consequences

- Browser, Bun, and Durable Object SQLite may use different physical schemas,
  indexes, and storage revisions while sharing one import and sync contract.
- New and stale replicas install a checkpoint, rebuild runtime indexes, reapply
  private pending mutations, and continue from the checkpoint sequence without
  replaying deleted history.
- Import, restore, endpoint movement, and records-epoch replacement compare or
  transform logical state instead of copying files or inventing workflow-specific
  formats.
- Logical exports retain application row identities but omit actor identity,
  cursors, outboxes, and other replica-private state. Adopting a copied
  physical file therefore remains an explicit import under a new actor, and
  because no deletion history exists, that import preserves identities only
  into a fresh records database; merging into a populated database is app-owned.
- Sync snapshots are transport compaction, not a version-history promise. A
  product that retains historical checkpoints must name and own that retention
  separately.
- Physical file transfer may remain an internal optimization only when the
  receiver verifies that it represents the expected logical snapshot and does
  not inherit replica identity.
- Snapshot installation pays the cost of reconstructing runtime-specific
  indexes and storage layout. That cost buys portability and keeps physical
  migrations out of the wire contract.

## Considered alternatives

- **Make the SQLite file the portable artifact.** Rejected: it couples every
  runtime to one file representation and mixes application state with indexes,
  storage migrations, cursors, actor identity, and pending intent.
- **Define a separate format for sync, import, restore, and replacement.**
  Rejected: each format would need its own row, schema, and conflict
  semantics for the same logical database.
- **Retain every checkpoint as history.** Rejected: portability and retention
  are separate decisions. Sync needs one current baseline; product history must
  be modeled and retained deliberately.
