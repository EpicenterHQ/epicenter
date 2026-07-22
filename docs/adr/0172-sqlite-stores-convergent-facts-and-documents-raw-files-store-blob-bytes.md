# 0172. SQLite stores convergent facts and documents; raw files store blob bytes

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-22: publication obligations derive
  from local truth versus authority-accepted watermarks)
- **Amended by:** [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) (document logs become bounded baseline-plus-tail chains and publication uses revision watermarks rather than frozen retry images)
- **Amends:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)
- **Relates:** [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

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
│   ├── per-record scalar lane state and obligations
│   ├── bounded Yjs document baseline-plus-tail chains
│   ├── locally authored and authority-accepted document revisions
│   ├── local nullable blob digests
│   └── authority-accepted blob digests
└── blobs/
    ├── staging/   in-flight capture bytes with no permanent identity
    └── at most one immutable content-addressed byte file per live record
```

The browser stores this layout in OPFS and keeps one Worker-owned SQLite
connection behind the storage lease. Native runtimes use native SQLite and the
native filesystem with the same ownership law. OPFS is the filesystem; it is
not an alternative database engine.

SQLite owns small mutable records that require crash-safe framing, indexing,
compaction, schema versioning, record-liveness admission, or coordination with
scalar deletion. Yjs document updates therefore remain in the SQLite update
log. Epicenter does not invent raw per-document files, custom byte framing,
truncation recovery, compaction swaps, or cross-medium record-liveness checks.

Raw files own blob bytes because blobs are immutable, potentially large, and
streamed. SQLite records the local nullable SHA-256 and authority-accepted
SHA-256 for each record's universal zero-or-one blob slot. Their inequality
derives the publication obligation. Filename, media type, application meaning, and other
interpretation belong to application citations, not sidecar metadata in the
blob store.

Blob publication follows one named write order:

```txt
stream bytes to blobs/staging/<digest>.tmp and fsync
  -> rename to the content-addressed blobs/<digest> (idempotent)
  -> one SQLite transaction records ownership evidence
     (local digest; the accepted digest remains behind until its receipt)
```

Because the SQLite commit is ordered strictly after the rename,
evidence-without-bytes cannot occur; bytes-without-evidence is always reapable
debris. Two idempotent sweeps own every crash residue: the **reopen sweep**
clears `staging/` wholesale when the owner starts, and the **debris sweep**
deletes content-addressed files that no record references, after a tombstone
or a whole-replica erase. Nothing else deletes blob bytes.

The record tombstone transaction ends the logical life of the record and
removes its document chain and pending publication evidence; reversible unset
removes neither. The debris sweep then deletes the record's blob file
idempotently. Raw bytes without a live owning record are storage debris, never
resurrectable product state. The runtime does not inspect schema-opaque
application citations and cannot use them as a garbage-collection oracle while
the record remains live.

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
record address. A private blob-root generation switched by the logical transaction
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
- Blob-file cleanup may lag the logical tombstone transaction. That lag costs
  storage only and cannot restore a deleted record.
- Whole-replica `Discard` is logically atomic without pretending SQLite can
  atomically delete external files. The attachment record and empty logical
  state commit together; physical reclamation follows the same debris rule as
  a record tombstone.

## Acceptance evidence

Before this ADR becomes Accepted, each storage adapter must prove that bounded
document chains remain transactional SQLite state, blob bytes remain streamable
raw files, and a record tombstone cannot resurrect either medium. Failure
injection must leave a complete committed SQLite state plus either valid
record-owned blob bytes or removable debris, never live bytes for a deleted
record. It must also kill the process between the staging fsync, the rename,
and the ownership commit, and prove both sweeps are idempotent.

The same failure injection covers first-attachment `Discard`: hydration never
starts before the logical clear and attachment commit, a failed transaction
preserves the intact unattached replica, and a committed transaction exposes no
live local record or obligation even when raw-file reclamation is interrupted.
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
