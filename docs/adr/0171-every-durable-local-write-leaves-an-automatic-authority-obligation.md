# 0171. Every durable local write leaves an automatic authority obligation

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-24: document publication is HTTP-only
  and settles by revision, not by an exact frozen payload and digest receipt)
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at the mechanism, not the law. Every durable local write still leaves the authority owed something. Withdrawn: the obligation as a separate record (an unconfirmed cell now *is* the obligation), the blob plane, its park state, and its terminal-issue record.
- **Supersedes:** ADR-0144, ADR-0149
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md), ADR-0163, [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)

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
      +--> document acceptance
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

| Plane    | Durable local work                                                        | Authority proof                                       |
| -------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| Scalar   | compacted desired-state intent in the scalar outbox                       | current authority fact for every touched address      |
| Document | bounded Yjs baseline-plus-tail chain plus a monotonic dirty revision      | acceptance acknowledgement for one captured revision  |
| Blob     | one immutable local byte stream plus its row-addressed publication record | accepted SHA-256 for the live row's blob slot         |

These are independent convergence units, not one transaction. They share one
runtime lifecycle owner for attachment, credentials, wakeups, retry, backoff,
authority-lifetime changes, status, and disposal. They retain separate payload
stores, admission rules, bounds, acknowledgements, and wire versions. There is
no generic `outbox(kind, payload)` and no whole-Epicenter transport batch.

An unattached replica records the same plane-specific durable work while it
operates offline, but cannot seal or send work against an authority lifetime it
has not learned. If first attachment chooses `Bring local data`, attachment
preserves the existing pending scalar intents, dirty document revisions, and
finalized blob publication records. After the authority lifetime is learned,
the ordinary drains make that work eligible to seal and send. Attachment never
reconstructs an obligation from visible state. There is no first-import outbox,
migration receipt, or second acceptance path. If first attachment chooses
`Discard local data`, one local transaction removes those logical states and
obligations while recording the permanent attachment before authority hydration
starts.

A local document update appends its Yjs V2 bytes and advances a lightweight
row-local publication revision in one SQLite transaction. It marks that revision
dirty but does not copy or continually re-merge the update into a second pending
BLOB. The document chain remains the one durable source from which publication
bytes are derived.

The publication record contains:

```txt
revision           monotonic row-local revision advanced by each local update
accepted revision  highest revision the authority has acknowledged accepting
issue              optional terminal address-scoped condition (`too-large`)
```

The address owes publication whenever `revision > accepted revision` and no
terminal issue is recorded. To publish, the owner reads the chain and current
revision in one SQLite snapshot, hydrates the current document, encodes one
complete V2 update, and submits it with the captured revision over an ordinary
HTTP request. Nothing is frozen: a racing edit simply advances `revision`
past the captured value, and the next attempt reconstructs newer state.

When the authority has applied and committed the candidate, it acknowledges
acceptance. The owner then advances `accepted revision` through the captured
revision and no further: acceptance of revision N can never clear revision
N+1, so work authored during the request stays owed. A lost acknowledgement
leaves the address dirty and a later attempt resubmits reconstructed current
state. Yjs update application is commutative and idempotent, so repeated or
overlapping submissions converge at the authority without duplication.
Semantic idempotency, not exact-byte replay, owns retry safety; there is no
frozen retry image, no payload digest, and no receipt binding lifetime,
address, protocol version, and digest.

State vectors remain transfer hints. An endpoint may use one to compute state
the other endpoint lacks, but never as authority-durability proof or change
detection: a delete-only Yjs update can change document meaning without
advancing the struct clocks a state vector records. V2 difference encoding
still carries the delete set. Closing the last live handle destroys the
in-memory `Y.Doc` but leaves the SQLite revision intact. A background drain
therefore publishes dirty documents without depending on open handles.

A row's blob publication is also write-once. The authority accepts an absent
slot with digest A, treats a retry of A as idempotent, and refuses or parks a
different digest B while that row remains live. The obligation clears only
after the authority acknowledges matching bytes at the active lifetime and row
address. New bytes require a new row rather than another blob member or mutable
replacement protocol.

Document publication is outbound, automatic, and HTTP-only. One
workspace-owned scheduler wakes after local document work, briefly coalesces
edits, discovers dirty addresses from SQLite, and publishes each dirty
document through an ordinary per-document HTTP request with bounded
concurrency. A slower safety wake resumes crash, restart, credential, and
transient-failure recovery. Remote document state remains lazy: an
application explicitly asks an open document to pull newer authority-accepted
state, and a closed document receives no document-body downloads. There is no
document WebSocket, no presence protocol, and no second outbound carrier.
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
- An oversized document is an exceptional terminal condition for that Yjs
  lineage, recorded as one durable address-scoped issue. The document remains
  locally durable and locally usable, Epicenter stops publishing that lineage,
  and the application owns presentation and recovery. One terminal address
  never blocks other dirty addresses, and Epicenter never reports the address
  as synchronized. Transport and storage failures, by contrast, remain
  retryable operational failures.
- Row deletion remains terminal. Its local transaction installs scalar
  deletion state and removes document state and pending publication evidence;
  later byte cleanup cannot resurrect the row.
- A device that never reconnects can still lose its unpublished work during a
  user-authorized Restore. This is the accepted limit of an authority Backup,
  not a hidden synchronization mode.
- An unattached person's explicit `Discard local data` also abandons unpublished
  work, but only before the replica has an authority owner. `Bring local data`
  preserves that work and drains it through the same proof-bearing operations
  used after attachment.

## Acceptance evidence

Before this ADR becomes Accepted, one shared protocol suite must prove the
following laws across the three planes:

- a crash after the local write cannot erase the authority obligation;
- a crash or lost response after authority commit cannot create a false clean
  state, and a retry that reconstructs and resubmits current state is
  semantically idempotent;
- scalar or document work created while an earlier attempt is in flight remains
  pending after the earlier authority proof arrives;
- no connection, state vector, or sequence watermark observation can clear an
  obligation without its plane-specific post-commit proof;
- a row deletion racing document or blob publication cannot resurrect row-owned
  state;
- first-attachment `Bring` retains every pre-attachment obligation until its
  ordinary plane-specific proof, and a brought row deletion removes or refuses
  row-owned document and blob work regardless of which plane reaches the
  authority first, while `Discard` removes every logical obligation in the same
  transaction that records attachment;
- a crash after `Bring` commits attachment but before lifetime discovery,
  sealing, or first submission preserves the exact pending work; and
- a Restore linearization either accepts work in the outgoing lifetime or
  refuses it, while every later retry from that lifetime is rejected.

Each storage adapter runs the same state-machine fixtures. Transport tests
then prove that document publication has exactly one carrier and one authority
acceptance operation, and that an explicit inbound pull never creates or
clears an outbound obligation.

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
- **Freeze an exact retry image and settle against a digest-bound receipt.**
  Rejected because Yjs semantic idempotency already makes reconstructed
  resubmission safe. The frozen payload, digest, receipt parser, and the
  parked/re-arm state machine that guarded them deleted more correctness than
  they added; the accepted trade is that a retry may transmit newer state than
  the failed attempt carried.
- **Publish or settle over an open document's WebSocket.** Rejected because a
  second carrier producing candidates and clearing obligations duplicates the
  publication engine's rules at a different lifecycle. The accepted trade is
  roughly one second of inbound latency for open documents, owned by an
  explicit application pull, in exchange for one publication path.
- **One giant atomic multi-document HTTP batch.** Rejected because per-address
  acceptance, bounds, and failure isolation are the unit of correctness;
  coalescing happens in the scheduler, not on the wire.
