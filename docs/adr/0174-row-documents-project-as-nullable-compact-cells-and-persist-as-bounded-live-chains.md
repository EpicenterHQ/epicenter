# 0174. Row documents project as nullable compact cells and persist as bounded live chains

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-22: publication uses local and
  authority-accepted revision watermarks; documents remain record-wide, the
  composed cell projects only into portable artifacts, snapshots carry
  metadata, and a typed export operation serves single-document jobs)
- **Supersedes:** the document-plane persistence, exact-byte retention, no-cache, and presence mechanics of [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md), plus [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)'s statement that remote authority mechanics remain unchanged. ADR-0161 already removes the workspace ownership axis; the principal authority and fixed-address-socket proposals remain independent.
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md) (the authority is the trusted document joiner and compactor), [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md) (every live owner uses the same bounded baseline-plus-tail law), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) (the update log is a private physical representation of one logical row cell), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md) (document publication derives obligations from revision watermarks)
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md), [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)

## Context

A row document is part of its row, but its live write mechanics differ from
small scalar fields. Replacing one complete encoded document after every edit
would turn a small Yjs update into a large SQLite rewrite, while retaining every
incremental update forever would make storage and hydration unbounded. Client
checkpoints cannot safely replace authority state because one client cannot
prove that its snapshot includes every concurrent branch the authority already
accepted.

## Decision

Every Epicenter record logically contains scalar state and zero or one
persisted Yjs document, whatever collection it lives in; typed APIs expose
`openDocument` where the Lens makes it meaningful (table collections in V1).
The document has no identity or lifecycle outside its record. Only the
terminal tombstone reaps it; reversible unset does not. Blob membership
remains independently owned by the blob ADRs.

```txt
one logical record
├── scalar state
└── nullable Yjs document
        |
        +--> live private form:    compact baseline + bounded update tail
        +--> portable Backup form: one self-contained compact V2 update
        `--> snapshot form:        metadata only (revision, bytes, status)
```

The portable Backup projects the document directly on the record: the
`document_update_v2` column of `_epicenter_records` (ADR-0167) carries one
self-contained compact Yjs V2 update for the complete accepted document.
`NULL` means that no document state has ever been persisted for the record.
Visually empty application content may still encode causal deletion state or
unresolved dependencies and therefore need a non-null cell.

An inspection snapshot (ADR-0162) never carries a composed cell. It exposes
document metadata only: the record's local and authority-accepted revisions,
encoded chain size, and derived status. The rare "give me this one document
now" job is served by an explicit
typed per-record `exportDocument` operation that produces one self-contained
V2 update. Yjs composition therefore happens in exactly two places: on the
authority at Backup capture, and in that typed export. It never happens
per-record inside an inspection query, and live document storage is never
reshaped to make inspection easier.

Every live owner stores the logical document privately in the same SQLite
database as its scalar record, using a sparse document relation keyed by the
private interned record ID (ADR-0177) with:

```txt
zero or one compact gc:true baseline
plus a short ordered tail of accepted V2 updates
```

The chain is a physical write optimization, not document history, an
acquisition floor, a portable representation, or a checkpoint exposed to
replicas. The record tombstone transaction owns its deletion. Scalar state
remains small in the records relation; storing the document separately does
not create a second logical aggregate or weaken atomic local deletion.

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
state. Both background publication and an open document's low-latency carrier
enter the same acceptance operation, which rechecks row liveness, applies the
candidate, enforces the canonical post-candidate byte and struct bounds from
ADR-0146, commits the bounded representation, and only then acknowledges and
best-effort fans out the update.

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

- One logical record shape serves typed access, Backup, download, and restore
  without exposing live update logs or a document inventory, while snapshots
  stay cheap because they carry metadata instead of composed cells.
- Small edits append small records on the live path, while count and byte
  thresholds bound storage fragmentation and rehydration work.
- Compaction reduces retained encodings and deleted content. It does not
  coalesce Yjs struct clocks, so the 131,072-struct product bound remains an
  independent refusal even when encoded bytes are below 1 MiB.
- Bound state is durably observable. Local editing and persistence continue
  while publication is parked, and Epicenter never claims the parked document
  is settled. Byte fullness may recover after edits shrink the compact
  state; structural fullness requires moving the content to a fresh row.
- Data owns one address-scoped synchronization-status surface. A document-bound
  observation distinguishes encoded bytes from decoded structs and reports the
  measured value and limit. Epicenter Home must surface parked work; an
  application may observe the same status, but an accepted local editor mutation
  does not throw merely because authority publication is parked.
- Restore intentionally abandons unpublished document state from superseded
  replicas. Back up before Restore preserves the outgoing accepted authority
  state only; it never captures unpublished work from a replica.
- The authority can produce one compact accepted document for Backup without
  trusting a client checkpoint or waiting for every replica to reconnect.
- Realtime fanout lowers latency but never proves durability. ADR-0171's
  post-commit publication receipt owns that proof.
- A single principal authority remains the lifecycle and transaction owner.
  Per-document Durable Objects are not introduced merely to host live sockets.
- First attachment reuses the normal Yjs join and publication proof. It does
  not create a second document merge path or ask the person to adjudicate
  causal history.

The durable publication obligation is the first implementation requirement for
bound refusal: a refused document remains owed and can never make Epicenter
report the address as settled. Compact refusal measurements persist on the
record for the refused local revision; no payload is frozen. The structured address-scoped
observation and its Home presentation may land later in the implementation
wave. Until they do, this ADR remains Proposed; applications do not receive a
temporary mutation error or a manual settlement action.

## Acceptance evidence

Before this ADR becomes Accepted, maintained tests must prove:

- applying the compact baseline and tail is state-equivalent to the logical
  document before and after compaction, including deletion-only state and
  unresolved dependencies;
- duplicate and reordered valid updates converge, while a local edit racing a
  publication attempt cannot be cleared by the earlier attempt's receipt;
- stale common-history state cannot roll back newer accepted content or
  resurrect deleted Yjs structs, duplicate exact first-attachment publication
  is idempotent, and concurrent shared-lineage branches converge;
- failures at every SQLite compaction boundary leave either the old complete
  chain or the new complete baseline, never a partial replacement;
- a transport update larger than the physical tail-entry limit is admitted as
  a compact baseline when its resulting document remains within product bounds;
- byte and struct fixtures immediately below, at, and above each proposed
  product bound return deterministic acceptance or a structured parked
  observation without mutating committed authority state on refusal;
- record tombstone, handle closure, process restart, hibernation, and Restore
  obey the same document lifecycle, while reversible unset leaves the chain
  intact;
- the typed `exportDocument` operation produces a self-contained V2 update
  equal to the live document; and
- Backup projection produces one nullable compact V2 cell in
  `_epicenter_records` whose decoded state equals the authority's accepted
  document at the selected cut, while a snapshot's metadata columns match the
  live chain they describe.

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
