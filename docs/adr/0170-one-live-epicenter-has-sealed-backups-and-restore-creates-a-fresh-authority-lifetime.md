# 0170. One live Epicenter has sealed Backups; Restore creates a fresh authority lifetime

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amends:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), and [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md)

## Context

A person needs one live Epicenter, but also needs durable recovery, deliberate
rollback, edited portable-state replacement, and an escape from deletion
metadata accumulated during ordinary synchronization. Keeping several writable
authority generations would recreate database catalogs, branching, hidden
divergence, and generic merge. Keeping only user-managed files would leave no
host-visible recovery timeline.

## Decision

One principal owns one live Epicenter and zero or more sealed Backups:

```txt
One principal
├── one live Epicenter
│   └── one active authority lifetime
│
└── zero or more Backups
    ├── sealed
    ├── immutable
    ├── byte-complete
    ├── downloadable
    └── not synchronizable
```

`Epicenter` and `Backup` are the public nouns. A Backup is a portable Epicenter
artifact stored in a host-visible registry. It contains one accepted authority
cut as defined by
[ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md),
including every blob byte owned by that authority at the cut. A Backup can be
restored or deleted independently of the live Epicenter and every other Backup.
Implementations may deduplicate physical storage invisibly, but correctness
never depends on shared bytes, reference counts, or another Backup remaining
present.

Backup membership comes from the portable SQLite row relation. Capture freezes
one accepted authority cut, records each row's compact document update and
nullable blob digest, pins every selected external blob against deletion, copies
and verifies those bytes, and publishes the Backup only after the artifact is
complete. A separate blob-membership manifest is neither authoritative nor
required. The pin, copy, verify, and seal sequence remains necessary because a
SQLite snapshot cannot atomically capture external files.

The Epicenter host control plane owns active-lifetime selection and Backup
lifecycle independently of the replaceable authority. An authority lifetime
owns only its live authority state. Hosted, self-hosted, and local-only hosts
provide the same conceptual owner; this decision does not freeze where or how
that control state is stored.

The product exposes four Backup operations:

```txt
Back up
Download
Restore
Delete
```

Registry inspection exposes Backup metadata. Inspecting or editing its contents
requires downloading the portable artifact. A Backup cannot be opened as a live
Epicenter, synchronized, mutated in place, partially restored, merged into the
live Epicenter, or browsed by the host as application data.

Restore accepts a sealed Backup or a validated uploaded portable Epicenter. It
constructs a fresh authority from that complete logical state, gives the
successor a fresh opaque authority-lifetime identity, and atomically makes it
the one active Epicenter. It never reactivates the authority lifetime that
originally produced a Backup.

```txt
Backup or uploaded portable Epicenter
                  │
                  ▼
         validate complete state
                  │
                  ▼
       construct successor authority
                  │
                  ▼
       atomically activate successor
                  │
          ┌───────┴────────┐
          ▼                ▼
  successor is live   old lifetime is superseded
          │                │
          ▼                └── old replicas are refused
  devices reacquire
```

Every synchronization attempt is bound to exactly one authority lifetime.
Replicas of a superseded lifetime cannot continue writing, silently attach to
the successor, or synchronize against the old authority. They erase their old
replica state and reacquire the active Epicenter. Pending work that did not
reach the restored authority state is intentionally abandoned.

Activation is the linearization point. Every scalar, document, or blob
operation against the outgoing lifetime is either durably accepted before that
point or refused, including work already in flight. No operation may acknowledge
success against the superseded authority after activation.

Restore is the person's explicit canonical override. It does not automatically
create a Backup of the outgoing Epicenter. A person who wants that state
preserved chooses Back up before Restore. Validation and successor construction
must finish before activation, so failure before the atomic switch leaves the
current Epicenter active.

Row tombstones remain permanent within one authority lifetime. They do not enter
a Backup and do not carry into the successor created by Restore. Backing up the
current accepted state and restoring it is therefore the one semantic rebase
that also clears tombstones, synchronization sequences, retry metadata, and
document-log fragmentation. Routine SQLite and Yjs compaction remains separate
and never invalidates replicas.

An authority lifetime is internal architecture. Its identity is opaque and used
only for equality and refusal; it is not a public generation number, history
order, branch, or Backup ID. Old authority databases may remain temporarily
during failure-safe activation, but they are not user-visible Backups and are
deleted after the replacement is proven active.

## Consequences

- One person still has exactly one writable Epicenter. Backups add recovery
  without restoring Workspace, database, or branch plurality.
- Restore, destructive rollback, edited-artifact replacement, synchronization
  reset, and deletion-history clearing share one operation.
- A restored device must reacquire the whole Epicenter. Unsynchronized work on
  every old replica may be lost.
- The host earns a small Backup registry with enough metadata to identify,
  label, validate, account for, and operate on sealed Backups. That registry
  owns metadata and lifecycle only; it does not interpret Backup contents.
- Backup capture, validation, download, and Restore must stream large blob sets
  and prove one complete authority cut without requiring every device to settle.
- Storage use can grow with retained Backups. Quotas and explicit deletion make
  that cost visible. Blob-stripped Backups and partial downloads are refused so
  they cannot omit bytes owned at the cut. An Epicenter that owns no blobs still
  produces a valid complete Backup.
- Authority replacement needs lifetime binding, mismatch refusal, successor
  staging, atomic activation, replica reset, and failure-injection tests. It
  does not need multiple active generations, lineage ordering, branch merge, or
  per-device participation.

## Considered alternatives

- **Keep several writable generations.** Rejected because it creates a catalog
  of live data owners, permits hidden writes to old branches, and leads to diff,
  selection, and merge pressure.
- **Reactivate the generation that produced a Backup.** Rejected because old
  replicas could silently reconnect. Restore always creates a fresh lifetime.
- **Retain old private authority databases as Backups.** Rejected because they
  contain runtime schema, identity, tombstones, and synchronization state. A
  Backup uses the documented portable representation.
- **Automatically Back up before every Restore.** Rejected because Restore is
  already an explicit authoritative override. Preservation remains a separate
  user choice.
- **Let Restore merge into the live Epicenter.** Rejected because schema-opaque
  state has no generic merge law and Epicenter refuses distributed transactions.
- **Clear tombstones through a separate compaction protocol.** Rejected because
  Restore already provides the rare deliberate authority rebase without adding
  retention floors, replica membership, or stale-device recovery.
