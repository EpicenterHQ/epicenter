# 0174. Row documents project as nullable compact cells and persist as bounded live chains

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-23: closed documents finish
  publishing local work; revised 2026-07-24: one HTTP carrier owns
  publication, inbound refresh is an explicit application pull, and there is
  no document WebSocket)
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at the publication obligation. Withdrawn: the revision counter and `accepted_revision`. What a peer still needs is expressed by a Yjs state vector, so nothing separate decides what to push. The nullable compact projection this record decided survives unchanged, and its terminal `too-large` issue is why ADR-0212 splits prose into its own document.
- **Supersedes:** the document-plane persistence, exact-byte retention, no-cache, presence, and per-document socket mechanics of ADR-0145, plus [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)'s statement that remote authority mechanics remain unchanged. ADR-0161 already removes the workspace ownership axis; the principal authority proposal remains independent.
- **Amends:** ADR-0145 (the authority is the trusted document joiner and compactor), [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md) (every live owner uses the same bounded baseline-plus-tail law), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) (the update log is a private physical representation of one logical row cell), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md) (document publication tracks a revision counter, not exact retry evidence or authority vectors)
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), ADR-0167, [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

## Context

A row document is part of its row, but its live write mechanics differ from
small scalar fields. Replacing one complete encoded document after every edit
would turn a small Yjs update into a large SQLite rewrite, while retaining every
incremental update forever would make storage and hydration unbounded. Client
checkpoints cannot safely replace authority state because one client cannot
prove that its snapshot includes every concurrent branch the authority already
accepted.

Durable convergence and live collaboration need one acceptance law but not one
delivery schedule. A locally authored update must not become stranded when its
document handle closes. Conversely, continuously downloading every remote
document body would spend storage, bandwidth, and lifecycle machinery on
documents no application is using.

## Decision

Every Epicenter row logically contains scalar fields and zero or one persisted
Yjs document. The document has no identity or lifecycle outside its row. Blob
membership remains independently owned by the blob ADRs.

```txt
one logical row
├── scalar fields
└── nullable Yjs document
        |
        +--> live private form: compact baseline + bounded update tail
        `--> artifact form:     one self-contained compact V2 update
```

Inspection, Backup, and every portable Epicenter project the document directly
on the logical row:

```sql
rows(
  namespace_key,
  table_key,
  row_id,
  fields_json,
  document_update_v2 BLOB NULL
)
```

`document_update_v2` is one self-contained compact Yjs V2 update for the
complete accepted document. `NULL` means that no document state has ever been
persisted for the row. Visually empty application content may still encode
causal deletion state or unresolved dependencies and therefore need a non-null
cell.

Every live owner stores that logical document privately in the same SQLite
database as its scalar row, using a sparse one-to-one document relation with:

```txt
zero or one compact gc:true baseline
plus a short ordered tail of accepted V2 updates
```

The chain is a physical write optimization, not document history, an
acquisition floor, a portable representation, or a checkpoint exposed to
replicas. The row-liveness transaction owns its deletion. Scalar fields remain
small in their scalar relation; storing the document separately does not create
a second logical aggregate or weaken atomic local deletion.

Each owner bounds the tail by both entry count and total encoded bytes. Crossing
either threshold hydrates the covered baseline and tail into a fresh `gc: true`
`Y.Doc`, encodes one complete update, and atomically replaces the covered chain
with that baseline. The concrete thresholds are adapter-tested implementation
constants, not protocol or product promises. An offline replica does not pin
the tail: a compact full state continues to join later valid Yjs updates from
that replica.

The authority is not an editing peer. It authors no application operations,
has no collaborative identity, and carries no awareness or presence state. It
is the trusted Yjs joiner, validator, and compactor for the accepted authority
state. Every publication candidate arrives through one ordinary per-document
HTTP request and enters one acceptance operation, which rechecks row liveness,
applies the candidate, enforces the canonical post-candidate byte and struct
bounds from ADR-0146, commits the bounded representation, and only then
acknowledges acceptance. Yjs storage or compaction failure inside that
operation is an operational failure, never a deterministic refusal of the
candidate.

Every locally authored document update persists before publication and remains
a durable authority obligation independently of the in-memory document
lifecycle. The runtime publishes that work continuously when possible. Closing
the last handle may request a best-effort flush, but it neither waits for
network settlement nor cancels unfinished work. A later runtime resumes the
same obligation from SQLite.

Inbound document content is lazy and explicitly requested. A replica does not
continuously download remote Yjs state for a closed document, and no document
WebSocket exists. Opening a document hydrates locally durable state; the
returned handle is fully usable when local hydration resolves and never waits
for network synchronization. While the document is open, the application
explicitly asks it to pull newer authority-accepted state, choosing its own
cadence; a small application-owned polling helper performing an immediate
pull and then polling while the view is mounted is the expected first shape.
Repeated and overlapping pulls are safe: Epicenter owns overlap behavior
internally, an unchanged authority document avoids transferring its body, and
an accepted inbound pull never creates a local publication obligation. Scalar
facts still arrive in the background so the replica can observe row creation,
metadata changes, and terminal deletion without hydrating the document body.

A local author sees its own durably persisted edit immediately. Other
replicas see that edit only after the authority accepts it and they next
pull. If later evidence shows an application needs lower latency, it may pull
more often or a reusable scheduling helper may be added without changing the
document protocol; near-instant socket delivery is refused in exchange for a
substantially simpler system.

First-attachment `Bring local data` preserves each local document's exact Yjs
V2 state and causal struct identities. The ordinary background publication
drain submits that state to the same authority acceptance operation. Shared
history deduplicates, genuine concurrent branches join, and stale common
history cannot replace newer accepted state. The attachment path never flattens
a document to visible JSON or text and reauthors it as new operations.

Runtime-minted globally unique row IDs make independently created rows a union.
A shared row ID therefore denotes one causal row lineage under ordinary
Epicenter operation. The attachment path adds no external import policy,
document-lineage identifier, collision inventory, replacement choice, or
special import mode. A remote terminal row tombstone still refuses document
admission. First-attachment `Discard local data` removes the local chain and
publication obligation before authority hydration.

A wire-valid candidate may be too large for one adapter's tail-entry limit even
when the resulting canonical document is within its product bounds. In that
case the owner hydrates and validates the candidate, then atomically stores the
resulting compact baseline instead of appending the transient bytes. It does not
reject valid document state solely because the transport encoding is a poor
physical tail row.

An in-memory `Y.Doc` is always derived from SQLite. An owner may retain derived
hot documents or discard them after an operation; cache size, eviction, and
hibernation behavior are implementation tuning and cannot change durability or
receipt semantics.

## Consequences

- One logical row shape serves typed access, inspection, Backup, download, and
  restore without exposing live update logs or a document inventory.
- Small edits append small records on the live path, while count and byte
  thresholds bound storage fragmentation and rehydration work.
- Compaction reduces retained encodings and deleted content. It does not
  coalesce Yjs struct clocks, so the 131,072-struct product bound remains an
  independent refusal even when encoded bytes are below 1 MiB.
- Exceeding a product bound is an exceptional terminal condition for that Yjs
  lineage, not a recoverable synchronization workflow. Epicenter records one
  durable address-scoped issue, `{ kind: 'too-large' }`, stops publishing that
  lineage, and never claims the address is synchronized. The document remains
  locally durable and locally usable, and an accepted local editor mutation
  does not throw merely because publication stopped. Epicenter does not
  repeatedly retry, automatically re-arm after later edits, distinguish
  byte-recoverable from struct-nonrecoverable states, or claim ordinary
  editing will repair accumulated CRDT history.
- The application owns oversized-document presentation and recovery. Honeycrisp
  may offer Export or Copy into a fresh note; other applications may offer
  domain-specific recovery such as splitting or flattening. Epicenter
  implements no universal repair workflow. One terminal address never blocks
  publication of other dirty addresses.
- Restore intentionally abandons unpublished document state from superseded
  replicas. Back up before Restore preserves the outgoing accepted authority
  state only; it never captures unpublished work from a replica.
- The authority can produce one compact accepted document for Backup without
  trusting a client checkpoint or waiting for every replica to reconnect.
- Locally authored document work continues publishing after the document
  closes and across process restart. Handle lifetime cannot determine whether
  an edit reaches the authority.
- Closed remote documents consume no Yjs download or subscription. Opening
  renders from local durable state immediately; remote catch-up is an explicit
  pull after opening and never extends the initial loading gate.
- A pull failure returns a typed Result and leaves the locally durable
  document open and usable. Temporary pull or network failures may surface
  through app-wide synchronization status; they never invalidate or close the
  local document.
- A document that was never hydrated or explicitly retained for offline use
  may be unavailable when first opened without a connection. Offline policy
  may retain selected documents, but it does not turn every closed document
  into a background subscription.
- A single principal authority remains the lifecycle and transaction owner.
  Per-document Durable Objects are not introduced merely to host live sockets.
- First attachment reuses the normal Yjs join and publication proof. It does
  not create a second document merge path or ask the person to adjudicate
  causal history.

The durable publication obligation is the first implementation requirement
for bound refusal: a bound-refused document records its terminal issue and
can never make Epicenter report the address as synchronized. Applications do
not receive a temporary mutation error or a manual settlement action.

## Acceptance evidence

Before this ADR becomes Accepted, maintained tests must prove:

- applying the compact baseline and tail is state-equivalent to the logical
  document before and after compaction, including deletion-only state and
  unresolved dependencies;
- duplicate and reordered valid updates converge, while authority acceptance
  of a captured revision cannot clear a newer local revision;
- closing the last document handle before, during, and after publication never
  loses or cancels a durable local obligation, and process restart resumes it;
- a closed document receives no document body updates and makes no pull
  requests, an open document pulls only when the application asks, overlapping
  pulls are safe, and disposal prevents a late pull result from mutating the
  handle;
- a pull delivers only authority-accepted state and never creates an outbound
  obligation, while the local author may continue from its own durable local
  state;
- stale common-history state cannot roll back newer accepted content or
  resurrect deleted Yjs structs, duplicate exact first-attachment publication
  is idempotent, and concurrent shared-lineage branches converge;
- failures at every SQLite compaction boundary leave either the old complete
  chain or the new complete baseline, never a partial replacement;
- a transport update larger than the physical tail-entry limit is admitted as
  a compact baseline when its resulting document remains within product bounds;
- byte and struct fixtures immediately below, at, and above each proposed
  product bound return deterministic acceptance or a terminal `too-large`
  refusal without mutating committed authority state, and one refused address
  never blocks other dirty addresses;
- row deletion, handle closure, process restart, hibernation, and Restore obey
  the same document lifecycle; and
- Backup and portable projection produce one nullable compact V2 cell whose
  decoded state equals the authority's accepted document at the selected cut.

The exact struct ceiling requires a maintained rich-text workload covering
typing, formatting, undo, deletion, and multiple offline clients, plus maximal
valid and maliciously dense fixtures in workerd. This evidence may revise the
constant without reopening the bounded-structure product refusal.

## Considered alternatives

- **Store the complete document directly beside live scalar fields.** Rejected
  because each small edit rewrites the complete BLOB and makes scalar updates
  share a physical record with potentially large document bytes. The nullable
  cell remains the correct logical and portable projection.
- **Keep an unbounded update log.** Rejected because authority storage, Backup
  capture, and cold hydration would grow with edit history instead of current
  accepted state.
- **Let clients compact and replace authority state.** Rejected because a
  client cannot prove its replacement covers concurrent authority branches.
  Verifying that claim requires the same trusted Yjs join the authority already
  performs.
- **Replace or choose documents during first attachment.** Rejected because
  exact Yjs joining already preserves shared history and concurrent branches.
  Replacement loses valid offline work, while a keep/replace/merge inventory
  turns importer provenance into a user-facing conflict system.
- **Make the authority an opaque update mailbox.** Rejected because it gives up
  bounded accepted state, canonical bounds enforcement, and one complete
  authority document for Backup.
- **Use one Durable Object per document.** Rejected because it separates the
  document from row deletion and account Backup, requiring revocation,
  enumeration, and cross-object lifecycle machinery.
- **Continuously mirror every remote document body.** Rejected because
  cross-device continuity does not require background hydration of content the
  application has not opened. Lazy catch-up preserves the product promise
  without a workspace-wide document feed.
- **Make handle closure responsible for publication.** Rejected because a
  process can close while offline or terminate before a final request settles.
  The durable SQLite obligation, not a graceful lifecycle callback, owns
  eventual publication.
- **Broadcast speculative peer updates before authority acceptance.** Rejected
  because recipients could display state that later fails row-liveness, bounds,
  or authority-lifetime admission. A pull returns only state the authority has
  already committed.
- **Keep a document WebSocket for open documents.** Rejected because a socket
  that publishes or settles work is a second candidate-production path with
  its own reconnect, backoff, status, and credential machinery, and a socket
  that only wakes pulls is not yet earned by any current product requirement.
  Roughly one second of application-owned polling latency is the accepted
  trade for deleting that family.
- **A universal oversized-document recovery workflow.** Rejected because
  recovery is domain-specific: Honeycrisp exports or copies into a fresh note,
  and other applications may split or flatten. A generic repair system would
  own state machines for a condition that generous bounds make exceptional.
