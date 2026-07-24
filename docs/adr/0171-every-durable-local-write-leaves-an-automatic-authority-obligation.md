# 0171. Every durable local write leaves an automatic authority obligation

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-24: HTTP-only document publication and explicit pull)
- **Supersedes:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md)
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md), [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md)

## Context

Local durability and remote convergence are different guarantees. A transport
connection can reduce latency, but it cannot prove that locally accepted work
will survive handle closure, process exit, network loss, or a lost response.
That proof must begin in local SQLite and end at committed authority state.

Earlier document designs mixed the two concerns. A background publisher owed
durable work while an open-document WebSocket also produced and delivered
updates. Exact digest receipts then tried to make both carriers settle the same
obligation. The socket did not strengthen local durability; it introduced a
second candidate-production path, connection lifecycle, reconnect protocol,
fanout path, and settlement vocabulary.

## Decision

Epicenter owns one convergence law:

> Every write that Epicenter accepts durably records, in the same local
> transaction, durable evidence of what the authority is still owed. One
> Epicenter runtime owner drains those obligations automatically. It clears an
> obligation only after the active authority commits the corresponding work.

Applications read and write through typed scalar Lenses, row-document handles,
and row-owned blob operations. They never publish, drain, settle, or retry
outbound work. Synchronization status is observation, never an action.

```txt
application write
      |
      v
local SQLite transaction
  durable state + authority obligation
      |
      v
runtime-owned supervisor
  scalar submission
  document HTTP publication
  blob publication
      |
      v
authority commit
      |
      v
plane-specific acknowledgement
      |
      v
conditional local settlement
```

The three planes remain independent convergence units:

| Plane | Durable local work | Authority acknowledgement |
| --- | --- | --- |
| Scalar | compacted pending operation in the record's numbered lane | current authority facts for every submitted address |
| Document | bounded Yjs chain plus local and accepted revisions | accepted captured revision, or an address-scoped refusal |
| Blob | one immutable byte stream plus its SHA-256 | accepted matching SHA-256 for the live record |

They share one supervisor lifecycle, immutable replica identity, fixed
open-time carrier, wakeups, retry, backoff, authority-lifetime replacement,
status, and disposal. They do not share a generic outbox, payload encoding,
transaction, or giant whole-Epicenter request.

Scalar synchronization retains its exact canonical retry bytes and numbered
fork detection. Reconstructing a scalar submission after an application
upgrade is not proven byte-stable, and the authority correctly refuses a
same-number, different-hash retry. Document simplification does not weaken that
scalar rule or the blob plane's digest identity.

### Document publication

A local document update appends its Yjs V2 bytes and advances
`document_revision` in the same SQLite transaction. The same record stores
`document_accepted_revision`, the greatest locally authored revision that the
active authority has accepted.

```txt
document_revision
document_accepted_revision
document_refused_revision = null | N
```

A document is owed exactly when its local revision is greater than its accepted
revision, no refused revision is recorded, and the record is visibly live. No
dirty boolean, refusal code, stored measurement, or durable per-attempt payload
duplicates that state.

The supervisor briefly coalesces local edit wakeups and drains owed addresses
through a keyset-paged forward scan, publishing each document through an
ordinary per-document HTTP request. Each page is taken strictly after the
previous page's last address, so one address that cannot be discharged this
pass delays only itself instead of re-serving the same page forever.
Scheduling is workspace-wide; the wire protocol is not one atomic
multi-document batch.

Publication captures the current local revision and reconstructs a complete
compact Yjs state from durable SQLite. The authority rechecks row liveness,
applies the submitted state idempotently, enforces the document bound, commits,
and returns one outcome. Every response includes the active authority lifetime;
an accepted response also includes the authority's opaque document version:

```txt
accepted(activeAuthorityLifetime, documentVersion)
not-live(activeAuthorityLifetime)
too-large(activeAuthorityLifetime)
lifetime-mismatch(activeAuthorityLifetime)
```

Local settlement first verifies that the response lifetime still matches the
replica's active authority lifetime. An accepted response then advances
`document_accepted_revision` through the captured revision. It never clears a
newer revision. A response for revision N therefore cannot settle revision
N+1. If the response is lost, the next attempt may reconstruct and send newer
complete state. Yjs update idempotency makes repeated application safe; exact
byte retention and digest-bound receipts are unnecessary.

`not-live` is governed entirely by the scalar record lifecycle and leaves no
durable document state. Owed-document enumeration already requires a visibly
live record, and the supervisor drains the scalar and facts planes before the
document plane, so the ordinary cause of an authority-absent record is that
this pass's scalar work has not landed yet. The replica records nothing and
retries on a later pass; the keyset scan is what keeps that from spinning.

Recording it durably would be wrong, not merely redundant: nothing clears such
a suppression when a scalar fact later confirms the record live, so the
document would stay owed forever while being permanently excluded from every
owed scan. A terminal scalar tombstone still reaps the document and all
publication state.

`too-large` records one nullable `document_refused_revision` naming exactly the
revision that exceeded the bound. The document remains locally durable and
usable, and automatic publication stops for that revision only. A later local
edit creates the next revision and clears the refusal in the same transaction,
so republication is automatic without a re-arm command. One refused document
never blocks other addresses. Epicenter does not retry the same refused
revision, and it does not promise that editing repairs accumulated CRDT
structure; it only stops pretending the lineage is dead, because deleting
over-bound content demonstrably repairs the common byte case.

Storage, adapter, decoding, compaction, authentication, and transport failures
are operational failures. They remain retryable and must not be converted into
permanent document refusals. Carriers must therefore decode the typed authority
outcome on the conflict status the route uses for refusals: discarding a valid
refusal response as a transport error turns a settled decision back into an
unbounded retry.

### Document pull

Outbound publication is automatic. Inbound document refresh is explicit and
open-handle scoped:

```ts
document.pull(): Promise<Result<void, DocumentPullError>>;
```

Opening a document waits only for local SQLite hydration and returns a fully
usable handle. It does not wait for the network. The application may call
`pull()` immediately after rendering, on focus, on a timer, from a Refresh
action, or not at all.

`pull()` conditionally requests the authority's accepted state. Every response
is bound to the active authority lifetime and an opaque document version.
Before installing bytes, the runtime rechecks the handle generation, disposal
state, and authority lifetime. It applies newer state durably before updating
the live handle. Accepted inbound bytes never create an outbound publication
obligation. Repeated or overlapping pulls are safe. A failed pull leaves the
local document open and usable.

Opening means local readiness, not remote freshness. A document with no local
bytes may initially render empty until the application performs its first
pull. Maintained first-party applications issue an immediate pull after local
rendering, then apply their chosen visible polling policy.

Closed documents receive no document-body downloads. Scalar synchronization
continues independently and remains the owner of row creation, metadata,
unset, and terminal deletion.

There is no document WebSocket, presence protocol, fanout connection, socket
settlement, or wakeup channel. Applications that want roughly one-second
collaboration can poll open documents at that cadence. Lower latency can be
reconsidered only when a measured product requirement earns another transport.

### Carrier-free and replaced replicas

An account replica opened without a carrier records the same durable
plane-specific work. A later carrier-bearing open of that immutable replica
drains it normally.

An unclaimed replica records local work but never contacts an authority. Its
data leaves only through ADR-0178's explicit, user-confirmed Lens import. The
destination writes through ordinary operations and creates ordinary
obligations; there is no import outbox or alternate settlement path.

Every exchange is bound to one opaque authority lifetime. Restore creates a new
lifetime, refuses the superseded replica, and invalidates prior settlement.
Restore never reinterprets an old obligation against the successor. Backups
contain accepted authority state only.

## Consequences

- Local durability means the same thing across scalars, documents, and blobs:
  accepted local work survives handle and process closure and remains owed.
- Document collaboration may appear after an application-chosen polling delay
  rather than immediately.
- Complete-state publication is proportional to the encoded document size.
  State-vector-scoped HTTP diffs may be added only when measurements earn the
  extra request or validator machinery; they do not change settlement.
- Applications own inbound refresh timing but never outbound durability.
- A socket connection can no longer become a second synchronization engine.
- Closed documents consume no document-body download traffic.
- One oversized lineage becomes truthfully local-only without blocking the
  workspace publisher.
- A terminal record tombstone removes document state, publication state, and
  sync issue atomically. Reversible unset preserves them.
- Restore and explicit unclaimed-replica retirement may abandon unpublished
  local work under their existing user-authorized rules.

## Acceptance evidence

Before this ADR becomes Accepted, maintained tests must prove:

- local state and its obligation commit atomically;
- restart resumes automatic publication;
- several edits inside the debounce window coalesce;
- publication is bounded and independent per address;
- acceptance for revision N cannot clear N+1;
- a lost acknowledgement retries safely without exact-byte retention;
- repeated Yjs application is semantically idempotent;
- storage failure is not reported as a document refusal;
- one undischargeable address does not block or starve later addresses, and a
  full page of them cannot spin the drain;
- an authority not-live answer leaves no durable state, and the document
  publishes once the scalar record lands, with no local edit or re-arm;
- a refused revision is durable, observable, and superseded by the next local
  edit, so deleting over-bound content republishes the same lineage;
- a carrier that receives a typed refusal on the conflict status decodes it
  instead of raising a transport error;
- a tombstone racing publication cannot resurrect record-owned state;
- accepted pulled state creates no outbound obligation;
- unchanged pull avoids transferring document bytes when the chosen validator
  says authority state is unchanged;
- overlapping pulls are safe;
- pull after disposal cannot mutate the handle;
- a pull response from a replaced authority lifetime cannot install state;
- closed documents make no pull requests;
- a carrier-free account replica retains obligations for a later
  carrier-bearing open;
- an unclaimed replica never contacts an authority; and
- authority replacement cannot accept settlement from the previous lifetime.

## Considered alternatives

- **Retain a document WebSocket as a low-latency overlay.** Rejected because it
  creates another candidate, reconnect, fanout, and lifecycle path without
  strengthening durable publication.
- **Require applications to publish explicitly.** Rejected because local
  durability would depend on application scheduling.
- **Publish only while a document is open.** Rejected because handle lifetime
  is a UI resource boundary, not a durable-data boundary.
- **Poll every closed document.** Rejected because scalar metadata already
  owns discovery and closed document bodies have no active consumer.
- **Retain exact retry bytes and digest receipts.** Rejected because complete
  Yjs state can be reconstructed from durable truth and applied idempotently.
- **Use one multi-document atomic request.** Rejected because independent
  documents have independent bounds and failure outcomes.
- **Use one generic outbox.** Rejected because the three planes have different
  payloads, admission laws, and settlement proofs.
