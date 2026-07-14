# 0132. An obsolete replica exports one read-only recovery checkpoint

- **Status:** Accepted
- **Date:** 2026-07-13
- **Amends:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md)
- **Relates:** [ADR-0131](0131-every-durable-records-materialization-carries-its-canonical-descriptor.md)
- **Amended by:** [ADR-0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md) (a complete ownership backup spans every declared plane and never implies live rollback)

## Context

An epoch mismatch already preserves local rows and pending outbox mutations,
but private SQLite tables do not make that pending intent usable. Durable but
inert state is not a complete recovery promise. The user needs one artifact
that a tool can inspect without teaching synchronization how to migrate or
replay obsolete work.

## Decision

A replica durably fenced by an epoch mismatch may export one read-only recovery
checkpoint. The checkpoint contains a format tag, workspace id, obsolete
records epoch, canonical descriptor and hash, complete local logical rows, and
the pending logical mutations in actor order.

Checkpoint creation is one local SQLite read transaction. The row image includes
the replica's optimistic pending effects; the mutation list separately preserves
the user's unsynchronized intent. Active replicas do not expose a checkpoint.

Epicenter provides no inverse operation. Import, automatic replay, mutation
translation, merge, replacement, and recovery UI remain app-owned or deferred.

## Consequences

- A person or tool can inspect both the obsolete local result and the exact
  logical intent that never entered the new epoch.
- Restart does not change the checkpoint because the epoch mismatch, rows, and
  outbox are all durable.
- The artifact contains replica-private pending mutations by design, so it is
  distinct from the ordinary logical snapshot format.
- Export does not make the obsolete replica writable or synchronizable.
- A future application may offer review or copy tools without adding an old-to-
  new replay path to the shared protocol.

## Considered alternatives

- **Preserve only a pending count.** Rejected: the user cannot inspect or recover
  the actual intent.
- **Automatically replay pending mutations into the new epoch.** Rejected: the
  mutation vocabulary and schema changed, so replay would recreate mixed-schema
  translation.
- **Add a generic checkpoint importer.** Rejected: import policy depends on the
  application and would turn one-way recovery into a migration product.
