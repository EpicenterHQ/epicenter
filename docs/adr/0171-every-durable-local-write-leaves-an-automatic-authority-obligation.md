# 0171. Every durable local write leaves an automatic authority obligation

- **Status:** Proposed
- **Date:** 2026-07-20
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

| Plane    | Durable local work                                                                                | Authority proof                                           |
| -------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Scalar   | compacted desired-state intent in the scalar outbox                                               | current authority fact for every touched address          |
| Document | bounded Yjs baseline-plus-tail chain plus a dirty revision and optional frozen `inflight` payload | post-commit receipt for the exact frozen `inflight` bytes |
| Blob     | one immutable local byte stream plus its row-addressed publication record                         | accepted SHA-256 for the live row's blob slot             |

These are independent convergence units, not one transaction. They share one
runtime lifecycle owner for attachment, credentials, wakeups, retry, backoff,
authority-lifetime changes, status, and disposal. They retain separate payload
stores, admission rules, bounds, acknowledgements, and wire versions. There is
no generic `outbox(kind, payload)` and no whole-Epicenter transport batch.

A local document update appends its Yjs V2 bytes and advances a lightweight
row-local publication revision in one SQLite transaction. It marks that revision
dirty but does not copy or continually re-merge the update into a second pending
BLOB. The document chain remains the one durable source from which publication
bytes are derived.

The publication record contains:

```txt
revision  monotonic row-local revision advanced by each local document update
dirty     whether revision includes work not yet proven at the authority
inflight  optional exact frozen V2 payload, digest, and captured revision
```

When a dirty row has no payload in flight, the owner reads its document chain
and revision in one SQLite snapshot, hydrates the current document, and uses the
authority's last known state vector only as a transfer hint when encoding the V2
update to submit. It freezes those exact bytes, their digest, and the captured
revision into `inflight` only if the revision still matches. A racing edit makes
that comparison fail or advances the revision after the freeze; it never changes
the immutable retry image.

After the authority has applied and committed the submitted update, it returns
a document publication receipt binding the active authority lifetime, complete
row address, document protocol version, and digest of the exact frozen payload.
The owner clears `inflight` only when every receipt field matches its stored
retry image. It marks the row clean only when the current revision still equals
the captured revision; otherwise the newer dirty revision enters another freeze
and publication attempt. A lost receipt causes the same bytes to be sent again.
Yjs update application is idempotent, so the authority can commit the same
semantic state and return the same proof without retaining permanent request
history.

State vectors remain transfer hints. An endpoint may use one to compute state
the other endpoint lacks, but never as authority-durability proof: a delete-only
Yjs update can change document meaning without advancing the struct clocks a
state vector records. V2 difference encoding still carries the delete set in
the frozen payload. Closing the last live handle destroys the in-memory `Y.Doc`
but leaves the SQLite revision and any in-flight retry image intact. A
background drain therefore publishes dirty documents without depending on open
handles.

A row's blob publication is also write-once. The authority accepts an absent
slot with digest A, treats a retry of A as idempotent, and refuses or parks a
different digest B while that row remains live. The obligation clears only
after the authority acknowledges matching bytes at the active lifetime and row
address. New bytes require a new row rather than another blob member or mutable
replacement protocol.

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
- Oversized or otherwise refused work remains visibly pending or parked at its
  address. Epicenter never reports it as synchronized and never spins one
  failing address through a global retry loop.
- Row deletion remains terminal. Its local transaction installs scalar
  deletion state and removes document state and pending publication evidence;
  later byte cleanup cannot resurrect the row.
- A device that never reconnects can still lose its unpublished work during a
  user-authorized Restore. This is the accepted limit of an authority Backup,
  not a hidden synchronization mode.

## Acceptance evidence

Before this ADR becomes Accepted, one shared protocol suite must prove the
following laws across the three planes:

- a crash after the local write cannot erase the authority obligation;
- a crash or lost response after authority commit cannot create a false clean
  state, and an exact retry is idempotent;
- scalar or document work created while an earlier attempt is in flight remains
  pending after the earlier authority proof arrives;
- no connection, state vector, sequence watermark, or fanout observation can clear an
  obligation without its plane-specific post-commit proof;
- a row deletion racing document or blob publication cannot resurrect row-owned
  state; and
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
