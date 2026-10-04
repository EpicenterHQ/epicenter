# 0163. Latest scalar state synchronizes through one Epicenter exchange

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md), and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
- **Amends:** the scalar protocol in [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md)

## Context

Push, pull, and acquisition were consequences of workspace-scoped histories,
retention floors, and baseline recovery. Whole-Epicenter replication and a
zero-legacy-data launch permit a smaller protocol. The remaining hard case is
deletion: a replica may stay offline indefinitely and later present state that
was deleted elsewhere.

[ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
fixes the semantic unit at one independently convergent scalar address and
refuses commit semantics for transport grouping. The sequence, receipt,
pagination, and checkpoint-like mechanisms below remain a Proposed protocol
candidate until adversarial review proves that each one is necessary.

## Decision

Every scalar address stores exactly one winning latest-state record at the
authority: either live state or a deletion state. Each accepted change receives
a monotonically increasing authority sequence. Values use
`(namespace key, value key)` as the address; rows use
`(namespace key, table key, globally unique row ID)`.

A row tombstone is terminal synchronization state, not an application row. It
retains the address and winning version but no deleted scalar payload,
document, or blob bytes. Row IDs are never reused by conforming runtimes; later
create and update operations at a tombstoned address are no-ops. Row tombstones
remain permanent
within one authority lifetime. [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)
permits discarding them only by replacing that entire lifetime from a complete
Backup, which invalidates every old replica.

An unset value also has a payload-free latest state so replicas can observe the
unset, but it is not terminal: a later accepted `set` replaces it. Row and value
states may share one physical relation while their discriminator-aware folds
preserve this lifecycle difference.

Scalar synchronization uses one versioned exchange for the entire Epicenter:

```txt
POST /api/sync/v1

request  replica identity, authority-lifetime binding (null when fresh),
         durable watermark `after`, optional transient scan bound `through`,
         optional bounded batch of pending local changes
response active lifetime, minimal accepted-batch receipt (sequence, digest),
         `through`, ordered latest-state records, continuation fact `more`
```

Every request is bound to one opaque equality-only authority lifetime. A fresh
replica sends `null`, may carry an initial batch, and binds the returned
lifetime. A bound replica presents its exact lifetime; a mismatch is an
actionable refusal that makes the replica erase its old-lifetime state and
reacquire, per
[ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md).
Same-lifetime progress beyond the authority head is a disjoint terminal
checkpoint-ahead diagnostic, never Restore recovery.

Paging uses one durable replica watermark. The first request of a scan omits
`through`; the authority samples it at its current maximum sequence and
returns records whose latest `changed_sequence` lies in `(after, through]`,
ordered by sequence. Each installed page atomically advances the durable
`after`: to the last returned sequence while `more` records remain, and to
`through` on the terminal page. A continuation request carries the durable
`after` plus the transient `through`; a crash forgets only `through` and
begins a fresh scan from durable progress, so no completed page is downloaded
or installed again. A record changed during a scan moves above `through` and
arrives next exchange, and the fixed bound guarantees termination during
sustained writes.

A batch rides only the first page of a scan; it is transport grouping, never a
semantic commit, and co-batch atomic visibility is explicitly unpromised. The
authority keeps one row per replica: the last accepted batch sequence and
request digest. An exact retry returns that stored receipt without reapplying;
a gap or fork is a batch conflict whose local recovery is a fresh replica
identity. A benign semantic noop against an existing record touches that
record with a fresh changed sequence, so ordinary scanning re-delivers
authority truth that a replica's pending optimism suppressed. A change whose
merged record exceeds the record bound refuses the entire batch envelope
before any mutation, identifying the offending change; the replica parks that
exact obligation visibly and reseals the rest. Refused work is never silently
reported as synchronized.

The exact request encoding, admission ceilings, and retry rules belong to the
protocol implementation and conformance tests. They must not split the product
back into push, pull, acquire, database, or table-specific network operations.

Synchronization starts automatically when an attached replica has credentials
and network access. Public status is observation only: idle, syncing, pending
for a small actionable reason, or authentication required. There is no public
settlement cut, protocol floor, acquisition mode, lineage recovery, or generic
authority scheduler. The scalar HTTP route version and row-document WebSocket
subprotocol version evolve independently.

Row documents remain a separate lazy plane because hydrating every Yjs document
would defeat table-shaped local reads. Durable outbound document publication
continues after the last live handle closes, as defined by ADR-0171. A realtime
connection for an open document is only a collaboration overlay; its exact
topology remains independently versioned and must not become the durability
contract.

## Consequences

- Permanent compact row tombstones delete retention floors, deletion-history
  windows, baseline acquisition, replica acknowledgment catalogs, and offline
  migrators.
- A globally unique row ID prevents collisions and reuse, but does not by itself
  communicate deletion. The tombstone supplies the missing causal winner.
- New replicas start at sequence zero and learn the current latest state without
  a separate acquisition protocol.
- The authority retains one compact tombstone for every row address deleted
  during its lifetime. This is the deliberate storage cost of indefinite
  offline correctness within that lifetime. An unset value occupies one
  latest-state record only until a later set.

## Considered alternatives

- **Delete tombstones after all known replicas acknowledge them.** Rejected
  because it requires permanent replica membership, lost-device lifecycle, and
  restored-replica rules.
- **Compact tombstones behind a retention floor.** Rejected because it brings
  baseline acquisition and lineage recovery back.
- **Treat globally unique IDs as sufficient.** Rejected because an offline
  replica can upload an older state for the same legitimate ID.
- **Send the full live dataset on every exchange.** Rejected because physical
  absence can communicate deletion only at unbounded recurring bandwidth cost.
