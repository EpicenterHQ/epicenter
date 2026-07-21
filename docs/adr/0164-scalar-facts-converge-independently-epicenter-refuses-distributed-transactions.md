# 0164. Scalar facts converge independently; Epicenter refuses distributed transactions

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amends:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md) by defining the independently convergent semantic unit carried by the wire

## Context

Epicenter stores one person's curated data as typed values and row aggregates
that own scalar fields, lazy documents, and optional immutable bytes. The
current synchronization implementation groups pending scalar changes for
transport and exact retry, but that grouping does not come from an application
transaction. Treating an
incidental transport group as a commit would turn an implementation detail into
a distributed transaction promise.

## Decision

One principal owns one Epicenter:

```txt
One principal
└── one Epicenter
    ├── typed values
    └── typed rows
        ├── scalar fields
        ├── one latent Yjs document
        └── zero or one write-once immutable blob
```

Applications contribute typed lenses over portions of this shared Epicenter.
They do not own separate databases or synchronization streams.

One scalar address is the unit of independent convergence: either a row
addressed by `(namespace key, table key, row ID)` or a value addressed by
`(namespace key, value key)`. A scalar operation becomes durable locally,
remains available offline, and eventually converges with the authority and
other replicas.

Epicenter exposes no public multi-address transaction and promises no atomic
remote visibility across scalar addresses. SQLite transactions may preserve
local durability inside an operation. A protocol may aggregate independent
changes for bounded transfer, retry, or storage efficiency, but that grouping
is never an application commit and carries no product semantics.

The scalar wire remains open to simplification. This decision does not require
a batch, checkpoint, fence, cursor, receipt, commit log, or exact authority
snapshot. Each mechanism must independently earn its place by preserving
single-address convergence, retry safety, deletion, recovery, or measured
performance.

When several values must change as one conceptual object, the application puts
them in one scalar row or one row-owned Yjs document. A real cross-row business
invariant belongs in an application-specific semantic authority, not in the
Epicenter synchronization layer.

Rows are also the multiplicity primitive for binary assets. Several attachments
use several rows with ordinary non-enforcing references. Epicenter promises no
atomic parent-and-asset creation, reference swap, cascade, or cleanup.

Portability is a separate product promise. A portable representation may
capture one owner's complete current logical state without making every live
replica an exact authority snapshot or adding distributed transactions.

## Consequences

- Applications cannot atomically publish a parent row, child row, derived
  counter, and backlink as one distributed operation. Replicas may temporarily
  observe intermediate combinations.
- Applications co-locate inseparable scalar facts in one row, use a row
  document for merge-sensitive content, derive secondary facts, tolerate
  temporary intermediate state, or introduce a semantic backend when a true
  invariant exists.
- Transport grouping remains replaceable. It may be resized, renamed, split,
  or deleted without changing the application contract.
- Epicenter does not need public transaction scopes, commit identities,
  transaction-aware retention, chunk staging, atomic remote promotion, or
  cross-row conflict and recovery semantics.
- Local SQLite remains an offline-capable materialization of independently
  convergent facts, not a distributed transactional database.

## Considered alternatives

- **Expose distributed multi-address transactions.** Rejected because it adds
  commit grouping, atomic remote installation, retention, conflict, and recovery
  obligations that the product does not need.
- **Expose local-only multi-address transactions.** Rejected because an atomic
  local API that tears during remote replication would imply a guarantee the
  system does not preserve.
- **Treat each transport batch as a semantic commit.** Rejected because timing
  and byte limits group unrelated pending writes arbitrarily.
