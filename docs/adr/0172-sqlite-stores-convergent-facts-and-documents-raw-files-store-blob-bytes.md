# 0172. SQLite stores convergent facts and documents; raw files store blob bytes

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at the storage inventory only. Withdrawn: "scalar state and pending intents" (`:24`), since the intent queue is deleted, and "accepted nullable blob digests" (`:27`), since a blob digest becomes an ordinary cell. The division of labour this record decides, SQLite for convergent facts and raw files for blob bytes, is untouched.
- **Amended by:** [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) (document logs become bounded baseline-plus-tail chains and publication stores exact retry evidence rather than authority vectors), [ADR-0178](0178-row-facts-and-value-facts-are-separate-relations-keyed-by-structured-coordinates.md) (convergent facts split into row and value relations, and document relations key on structured row coordinates)
- **Amends:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
- **Relates:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

- **Current blob direction:** [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) and [ADR-0426](0426-blob-identities-survive-copies-between-scoped-locations.md) replace the blob inventory/address claims below. Blob identities are independent of row coordinates; browser storage uses IndexedDB and desktop storage uses flat files. This note does not revise the structured-data history.

## Context

Browser persistence is sometimes framed as a choice between SQLite and OPFS.
SQLite already lives in OPFS through the browser's SQLite VFS. The actual
choice is which data benefits from SQLite's transactional framing and which
data benefits from raw streaming files.

## Decision

One local Epicenter owner uses the same conceptual layout in every runtime:

```txt
Epicenter storage root
├── epicenter.sqlite3
│   ├── scalar state and pending intents
│   ├── bounded Yjs document baseline-plus-tail chains
│   ├── exact document publication retry evidence
│   ├── accepted nullable blob digests
│   └── pending blob publication records
└── blobs/
    └── at most one immutable byte file per live row
```

The browser stores this layout in OPFS and keeps one DedicatedWorker-owned SQLite
connection behind the storage lease. Native runtimes use native SQLite and the
native filesystem with the same ownership law. OPFS is the filesystem; it is
not an alternative database engine.

SQLite owns small mutable records that require crash-safe framing, indexing,
compaction, schema versioning, row-liveness admission, or coordination with
scalar deletion. Yjs document updates therefore remain in the SQLite update
log. Epicenter does not invent raw per-document files, record framing,
truncation recovery, compaction swaps, or cross-medium row-liveness checks.

Raw files own blob bytes because blobs are immutable, potentially large, and
streamed. SQLite records the accepted nullable SHA-256 for each row's universal
zero-or-one blob slot and the small obligation needed to publish newly accepted
bytes. Filename, media type, application meaning, and other interpretation
belong to application citations, not sidecar metadata in the blob store.

The SQLite row-deletion transaction ends the logical life of the row and
removes its document log and pending publication records. The owner then
deletes the row's blob file idempotently. Raw bytes without a live row are
storage debris, never resurrectable product state. The runtime does not inspect
schema-opaque application citations and cannot use them as a garbage-collection
oracle while the row remains live.

First-attachment `Discard local data` applies the same boundary to the whole
unattached replica. One SQLite transaction removes scalar state, document
chains, publication obligations, and accepted blob membership while recording
the permanent principal attachment. Authority hydration begins only after that
transaction commits. The owner then reclaims raw blob files idempotently. A
crash may leave files with no live SQLite owner, but those bytes are debris and
cannot reappear as product state.

A raw blob file is usable only when its bytes verify against the digest
currently owned by SQLite. Delayed `Discard` cleanup targets the pre-clear
physical generation or an equivalent immutable file identity. It can neither
satisfy nor delete a blob owner created later by authority hydration at the same
row address. A private blob-root generation switched by the logical transaction
is one valid implementation. Digest-qualified immutable paths are valid only
when cleanup rechecks or leases current SQLite ownership so it cannot delete a
presently owned equal-digest file.

## Consequences

- Browser documents already receive OPFS durability through SQLite; moving
  them to raw OPFS files would add machinery rather than remove it.
- Scalar deletion, document deletion, and publication cancellation share one
  transaction even though potentially large blob bytes stay outside SQLite.
- Blob reads and writes can stream without loading a complete object into
  SQLite or across WebView JSON IPC.
- Browser and native runtimes share one storage law without pretending their
  filesystem adapters are one implementation.
- Blob-file cleanup may lag the logical deletion transaction. That lag costs
  storage only and cannot restore a deleted row.
- Whole-replica `Discard` is logically atomic without pretending SQLite can
  atomically delete external files. The attachment record and empty logical
  state commit together; physical reclamation follows the same debris rule as
  row deletion.

## Acceptance evidence

Before this ADR becomes Accepted, each storage adapter must prove that bounded
document chains remain transactional SQLite state, blob bytes remain streamable
raw files, and row deletion cannot resurrect either medium. Failure injection
must leave a complete committed SQLite state plus either valid row-owned blob
bytes or removable debris, never live bytes for a deleted row.

The same failure injection covers first-attachment `Discard`: hydration never
starts before the logical clear and attachment commit, a failed transaction
preserves the intact unattached replica, and a committed transaction exposes no
live local row or obligation even when raw-file reclamation is interrupted.
Same-address hydration with equal and different blob digests must prove that
old-generation cleanup cannot satisfy or delete the new owner before or after a
crash.

Physical measurements are adapter-specific. Evidence from native SQLite and
browser OPFS reports the database and the file-level measurements that the
adapter can observe. Cloudflare Durable Object evidence reports its exposed
database size, SQL row counts, execution cost, and platform-limit refusals; it
does not invent WAL, temporary-file, or storage-root measurements that the
managed runtime does not expose. ADR-0161's scalar-only layout evidence remains
separate and does not cap document chains, raw blob bytes, or choose a scalar
layout.

## Considered alternatives

- **Store documents as raw OPFS files.** Rejected because it requires custom
  framing, torn-write recovery, compaction, versioning, and cross-medium
  lifecycle reconciliation.
- **Store blob bytes inside SQLite.** Rejected because large immutable streams
  do not need relational mutation or transaction participation.
- **Keep browser blobs in IndexedDB.** Rejected because OPFS already owns the
  Epicenter storage root and raw files are the canonical representation the
  browser and native hosts can share.
- **Store blob metadata beside the bytes.** Rejected because applications
  already own the citation that gives bytes their name, media type, and
  meaning.
