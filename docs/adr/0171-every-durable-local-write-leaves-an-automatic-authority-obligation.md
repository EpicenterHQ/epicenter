# 0171. Every durable local write leaves an automatic authority obligation

- **Status:** Accepted
- **Date:** 2026-07-20 (revised 2026-07-22: document and blob obligations
  derive from local truth versus authority-accepted watermarks)
- **Supersedes:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md)
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)

## Context

Scalar writes already become locally durable with a pending intent and clear
that intent only after the authority returns current settlement facts. Row-document updates are durable
in SQLite, but their publication currently depends on an open document
connection. Blob replication is an explicit application action. These three
rules make identical user intent produce different durability outcomes and
force applications to know synchronization machinery.

## Decision

Epicenter owns one convergence law:

> Every write that Epicenter accepts durably records, in the same local
> transaction, durable evidence of what the authority is still owed. One
> Epicenter runtime owner drains those obligations automatically. It clears an
> obligation only after post-commit proof from the active authority lifetime.

Applications read and write through typed scalar lenses, row-document handles,
and row-owned blob operations. They do not call `sync`, `publish`, `upload`,
`download`, `purge`, or a remote-settlement barrier. Synchronization status is
observation, never an action.

```txt
application write
      |
      v
local SQLite transaction
  durable state + authority obligation
      |
      v
one runtime-owned drain
      |
      +--> scalar acceptance
      +--> document acceptance  <--- optional low-latency WebSocket
      `--> blob acceptance
                  |
                  v
          authority commit
                  |
                  v
        plane-specific proof
                  |
                  v
       conditional local clear
```

The proof establishes committed authority state. The transport that carried the
request or response has no durable meaning.

The law has three independent protocol realizations:

| Plane    | Durable local work                                                               | Authority proof                                        |
| -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Scalar   | compacted pending operation in the record's pending lane                         | current authority fact for every touched address       |
| Document | bounded Yjs baseline-plus-tail chain plus local and authority-accepted revisions | post-commit receipt binding the accepted update digest |
| Blob     | one immutable local byte stream plus its SHA-256                                 | accepted SHA-256 for the live record's blob slot       |

The scalar plane alone freezes exact retry bytes. Scalar folding is numbered,
order-sensitive, and fork-detected; document joining is commutative and
idempotent. Different acceptance laws deliberately keep different retry
disciplines.

These are independent convergence units, not one transaction. They share one
runtime lifecycle owner for attachment, credentials, wakeups, retry, backoff,
authority-lifetime changes, status, and disposal. They retain separate payload
stores, admission rules, bounds, acknowledgements, and wire versions. There is
no generic `outbox(kind, payload)` and no whole-Epicenter transport batch.

An unattached replica records the same plane-specific durable work while it
operates offline, but cannot seal or send work against an authority lifetime it
has not learned. If first attachment chooses `Bring local data`, attachment
preserves pending scalar intents, document revisions ahead of their accepted
watermark, and finalized blob digests ahead of their accepted digest. After the authority lifetime is learned,
the ordinary drains make that work eligible to seal and send. Attachment never
reconstructs an obligation from visible state. There is no first-import outbox,
migration receipt, or second acceptance path. If first attachment chooses
`Discard local data`, one local transaction removes those logical states and
obligations while recording the permanent attachment before authority hydration
starts.

A local document update appends its Yjs V2 bytes and advances a lightweight
row-local `document_revision` in one SQLite transaction. The document chain
remains the one durable source from which publication bytes derive. The same
record stores `document_accepted_revision`, the greatest locally authored
revision proven committed by the active authority lifetime. Publication is
owed exactly when `document_revision > document_accepted_revision`; no dirty
boolean duplicates that comparison.

The durable document publication state contains:

```txt
document_revision           monotonic row-local revision advanced by each local update
document_accepted_revision  greatest local revision proven committed by this authority lifetime
refusal evidence            optional measured bytes and structs for the current refused revision
```

When a document is owed, one SQLite snapshot reads its chain and revision
together. The owner hydrates the current document and encodes the complete
compact V2 state. Publication is self-contained: no authority state vector can
omit local structs or suppress a delete-only change and then become settlement
proof for the captured revision.

The attempt holds only its captured local revision and payload digest in
memory. After the authority applies, bounds, and commits the update, HTTP and
WebSocket carriers return the same receipt binding authority lifetime, record
address, protocol version, and digest. A matching receipt advances
`document_accepted_revision` monotonically to the captured revision. A racing
edit leaves a greater local revision owed. A lost receipt advances nothing;
the next attempt regenerates the newest missing update. Yjs idempotency makes
that retry safe without durable per-attempt bytes or an authority-side
per-replica document ledger.

Authority publication does not use a state vector to reduce the owed update.
Closing the last live handle destroys the in-memory `Y.Doc` but leaves the
chain and both revisions intact. A background drain therefore publishes owed
documents without depending on open handles.

A record's blob publication is also write-once. The authority accepts an
absent slot with digest A, treats a retry of A as idempotent, and refuses or
parks a different digest B while that record remains live. The record stores
the locally finalized SHA-256 and the SHA-256 accepted by the active authority
lifetime. Publication is owed when those nullable digests differ and clears
only after the authority acknowledges matching bytes at the active
lifetime and record address. New bytes require a new record rather than
another blob member or mutable replacement protocol.

Document publication is outbound and automatic. Remote document state remains
lazy and arrives when the row document is next opened. A realtime connection
for an open document may reduce edit latency, but it is an overlay, not the only
durability path. The first document protocol carries no awareness or presence.
Closing an application surface must never strand accepted document work.

Every exchange is bound to one opaque authority-lifetime identity. Restore
creates a new lifetime, refuses old replicas, and invalidates prior authority
proof. Superseded replicas discard scalar intents, document chains and
publication records, and blob obligations from the old lifetime before they
reacquire the restored Epicenter. Unpublished work is intentionally abandoned;
Restore never reinterprets an old obligation against the successor.
Backups contain accepted authority state only; pending work on an offline
device is not part of a Backup.

## Consequences

- Local durability has one meaning across scalars, documents, and blobs:
  accepted work survives process and handle closure and remains owed to the
  authority.
- Ordinary applications contain no networking policy, retry loop, upload
  bookkeeping, or settlement choreography.
- A scalar submission never becomes a semantic commit. Documents and blobs do
  not enter it merely to make the implementation look unified.
- Closed documents can converge without eager inbound hydration or permanent
  live `Y.Doc` instances.
- A realtime document socket may report connection and low-latency convergence,
  but those observations do not prove authority durability.
- Oversized or otherwise refused work remains visibly owed or blocked at its
  address. Epicenter never reports it as settled and never spins one
  failing address through a global retry loop.
- The record tombstone remains terminal. Its local transaction installs the
  tombstone and removes document state and pending publication evidence; later
  byte cleanup cannot resurrect the record. Reversible unset reaps neither the
  document nor the blob slot.
- A device that never reconnects can still lose its unpublished work during a
  user-authorized Restore. This is the accepted limit of an authority Backup,
  not a hidden synchronization mode.
- An unattached person's explicit `Discard local data` also abandons unpublished
  work, but only before the replica has an authority owner. `Bring local data`
  preserves that work and drains it through the same proof-bearing operations
  used after attachment.

## Acceptance evidence

The shared protocol suite proves the following laws across the three planes:

- a crash after the local write cannot erase the authority obligation;
- a crash or lost response after authority commit cannot create a false
  settled state, and regenerated document or blob retry is idempotent;
- scalar or document work created while an earlier attempt is in flight remains
  owed after the earlier authority proof arrives;
- no connection, state vector, sequence watermark, or fanout observation can clear an
  obligation without its plane-specific post-commit proof;
- a record tombstone racing document or blob publication cannot resurrect
  record-owned state;
- first-attachment `Bring` retains every pre-attachment obligation until its
  ordinary plane-specific proof, and a brought tombstone removes or refuses
  record-owned document and blob work regardless of which plane reaches the
  authority first, while `Discard` removes every logical obligation in the same
  transaction that records attachment;
- a crash after `Bring` commits attachment but before lifetime discovery,
  sealing, or first submission preserves the exact pending work; and
- a Restore linearization either accepts work in the outgoing lifetime or
  refuses it, while every later retry from that lifetime is rejected.

Each storage adapter runs the same state-machine fixtures. Transport tests then
prove that background exchange and realtime document delivery enter the same
authority acceptance operation rather than two semantic paths.

## Considered alternatives

- **Require applications to publish explicitly.** Rejected because it makes
  authority durability depend on application policy and leaves closed
  documents and forgotten blobs stranded.
- **Publish documents only while their handles are open.** Rejected because
  handle lifetime is a UI resource boundary, not a durable-data boundary.
- **Use one generic outbox or one whole-Epicenter exchange.** Rejected because
  it duplicates document bytes, cannot carry large blobs efficiently, couples
  unrelated bounds, and suggests cross-plane commit semantics.
- **Eagerly mirror every remote document and blob.** Rejected because outbound
  durability does not require hydrating or downloading unopened row content.
