# 0295. A database is one Yjs document and a row holds its rich content

- **Status:** Accepted, amended 2026-08-30 at where a rich field surfaces
- **Amended by:** [ADR-0431](0431-rows-return-values-and-own-a-separate-body.md) moves the body from a row attribute to its sole sequence child. The one-document decision remains unchanged; current code calls the shared type `Y.Node` in RC26.
- **Date:** 2026-08-29
- **Supersedes:** [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md) entirely, [ADR-0278](0278-a-replica-syncs-the-application-document-and-fetches-row-documents-on-demand.md) entirely, [ADR-0284](0284-the-application-document-is-an-index-and-a-rows-remaining-fields-live-in-its-own-document.md) entirely.
- **Amends:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) at the object granularity and the per-row HTTP surface; [ADR-0282](0282-the-authority-hydrates-the-document-and-one-object-per-document-bounds-the-blast-radius.md) at one-object-per-document; [ADR-0283](0283-a-generations-collection-is-a-ledger-that-allocates-admits-and-sweeps.md) at the per-document routes and the address register; [ADR-0280](0280-a-browser-stores-durable-record-is-a-chain-of-updates-in-indexeddb-folded-on-idle.md) at the document dimension of the record key; [ADR-0286](0286-every-generation-is-minted-from-an-artifact-and-compaction-is-an-export-then-an-import.md) and [ADR-0290](0290-a-mint-is-a-foreground-job-the-client-owns-and-it-cannot-outlive-a-page.md) at their per-document upload invariants; [ADR-0300](0300-accepted-edits-are-live-immediately-and-persistence-and-sync-are-best-effort.md) at accepted edits being delivered before local persistence settles.
- **Relates:** [ADR-0294](0294-a-database-is-sized-against-a-measured-device-budget-not-an-assumed-ceiling.md), which withdrew the memory justification for the split this record retires; [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md), whose shape this restores; [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md), which this makes literally true.
- **Unbuilt:** generation deletion remains unbuilt; see ADR-0293. The client
  and authority are built: a database is one `Y.Doc`, a rich field is a nested
  type on the row, and `store/envelope.ts`, `store/documents.ts`, the derived
  row addresses, and the tombstone protocol are deleted. The authority is
  `sync/authority.ts`, byte-blind and positional (ADR-0298).

## Context

A database was N Yjs documents: one application document holding every row's
scalar fields, and one document per row holding its rich content. That split
exists for one reason, and the reason is an engine property rather than a
product need: Yjs cannot partially hydrate a document, so the document boundary
is the residency boundary. Splitting rows out of the index was the only way to
keep prose off every device's boot path.

In Yjs the document is also the sync stream, the storage object, the server
addressing unit, and the identity. They cannot be separated. So a split made for
residency bought an envelope to re-multiplex what it had split, one Durable
Object per row document, derived row addresses, a document identity stamp, a
tombstone protocol to delete across two documents, and a declared index/record
field split every application author had to learn.

Measured, the split buys about two times on the client. The index alone at
25,000 rows is 133 MB (notes) to 254 MB (recordings), so the row ceiling is set
by the index either way; what the split defers is bodies, not rows. On the
authority it costs 30,001 objects per generation at the stated ceiling, whose
per-object overhead prices at 8.2 times the content it carries (ADR-0287).

## Decision

**A database is one Yjs document.** It has one identity, one socket, one
authority object, one stored blob, one address.

Its layout, which is ADR-0215's restored and is already what `store/document.ts`
builds for the application document:

```txt
Y.Doc
├── "kv"                    Y.Type   root
│     └── theme, sidebarWidth, …
└── "tables:notes"          Y.Type   root
      └── note-abc123       Y.Type   the row
            ├── title      = "Q3 planning"     scalar: a plain value
            ├── pinned     = true              scalar
            └── body     → Y.Type              rich: a nested type
```

A row is a nested `Y.Type` under its table root. Its attributes are the declared
fields. A scalar field holds a plain value; a rich field holds a nested
`Y.Type`. Row existence is the presence of the nested type, and there is no
second fact to consult.

**A rich field is never a top-level root.** `Item.write` resolves a root-parented
item through `findRootTypeKey`, a linear scan of `doc.share`: one root per row
costs 23 ms at 1,000 rows, 364 ms at 5,000, and 5,417 ms at 20,000, against
1.8 / 3.0 / 13.1 ms nested (`evidence/bench/row-model.ts`, ADR-0212).

**A rich field is minted exactly once, in the transaction that mints its row.**
Root types converge by name; nested types do not, so two devices independently
minting a body at the same attribute key lose one subtree. Minting with the row
removes the concurrency entirely.

**The authority is one Durable Object per `(principal, dataId, generation)`.** It
holds opaque update bytes, assigns log positions, and relays entries after a
replica's cursor. It does not hold a `Y.Doc` or answer `since(stateVector)`;
ADR-0298 restores the byte-blind positional authority that ADR-0277 had
replaced.

**The device is the residency boundary.** ADR-0294 measured a
tab budget of 1,792 MB on an idle iPhone 15 Pro and a per-document cost of
`rows x 5.5 KB + body bytes x 1.8`, which puts roughly 127,000 pages at the
measured 3.2 KB vault mean inside a 1,400 MB working budget. The earlier
per-item rule that priced this at about 100 MB was read from process RSS, which
overstates by two to three times. On the client, one document per database has
roughly fifty times the headroom the largest real collection needs. Because the
authority does not hydrate the document, those measurements describe client
memory rather than an authority ceiling.


## Amendment, 2026-08-30: the row carries its content node

The decision above is unchanged. A database is still one Yjs document, a row is
still a nested `Y.Type` under its table root, and a rich field is still a
nested type on the row. What moved is only how an application reaches one.

**`table.content(rowId)` is deleted.** It returned `{ types, subscribe }`, and
it existed because `readRow` cannot return a nested type: the scalar read owes
JSON and a type is not one. That is a fact about `readRow`, and this record let
it become a fact about the API. `get` places the content node on the flat row
before handing it over, so a caller writes `note.content`, and `RowOf` names
it.

Three things followed, and each is worth recording because each was a defect
this shape had been hiding:

- **`RowOf` had been lying.** It included rich fields while `get` never
  returned them, so `note.content` typechecked and was `undefined`. Corrected on
  2026-08-29 by removing them from the type; corrected properly here by adding
  them to the value.
- **`content` was not reactive and looked like it was.** `fromData` made
  `list`, `get` and `ids` track and left `content` alone, which is defensible;
  two Skills editors wrapped it in `$derived` anyway and rendered nothing when a
  row arrived from sync after mount. A rich field reached through `get` is
  tracked, so the bug is now unwritable.
- **The renderer was assembling by hand.** `{ id, ...handle.stored(rowId),
  ...handle.content(rowId).types } as RowValues` fused two verbs behind a cast.
  The exporter reads `store.rowFile(table, rowId)` now, which is on the STORE
  rather than a handle because it must return keys this release no longer
  declares and rows it cannot conform, and a handle is a lens.

**What survives of `content` is one verb.** `watch(node, listener)` is the
content-scoped change signal, and it is the half that earned a wrapper: a
`Y.Type` has its own `on('delta')`, but the store defers delivery to the commit
flush, so a listener that writes is writing against a settled commit. That
ordering is what Honeycrisp's `updatedAt` write depends on. `RowContent` is
deleted; after the types moved onto the row it was `{ types }` with no caller.

**The concurrency argument is untouched.** A rich field is still integrated
exactly once, in the transaction that mints its row, at a minted row id. The
row now carries the type out; nothing about when it comes into being changed.

## Consequences

- Deleted: `store/envelope.ts`, `store/documents.ts`, `sync/hub.ts`,
  `sync/frames.ts`, `sync/authority.ts`, `sync/transport.test.ts`,
  `sync/document-identity.test.ts` and their suites, roughly 4,500 lines, rising
  to about 5,400 with `sync/client.ts` and the port conformance suite.
- Deleted with them, once the store collapsed: the `document` column on the
  durable record, the `retire` op and the `_tombstones` relation, the port's
  `readDocument`/`listDocuments` readers, the controller's `pendingAppends` and
  `pendingDocuments` overlays, and `definition/addresses.ts`'s whole
  `RowAddress` half. A browser record's shape changed, so `STORE_GENERATION`
  goes to `v2` and a `v1` record is stranded rather than migrated.
- Stopped existing: derived row document addresses, the document identity stamp
  and supersession, the tombstone and retirement protocol, `derive` and
  `deriveOnCommit`'s cross-document choreography, the index/record schema split,
  and the address register in the generations ledger.
- The generation model is untouched. A generation is still an exact number,
  created once by importing a folder, never mutated in place, stored as one
  blob, existing if and only if its ledger row exists. None of those sentences
  mentioned Yjs.
- The bootstrap payload is one document's state rather than an envelope of
  addressed sections, so ADR-0292's "it is not one giant Yjs document" no longer
  holds and ADR-0293's multi-section framing collapses to a single payload.
- Harder: every persist folds the whole document, boot hydrates everything,
  every device receives every keystroke of every row, and one object serializes
  every socket for the database. The failure domain is the whole database rather
  than one row, against a 10 GB per-object storage cap.
- Reversing the prose split costs about 5 ms of cold open and 2.7 MB of startup
  bytes on the real 986-note vault (ADR-0212).
- Undo requires that every derived or system write carry a non-null origin,
  forever. Honeycrisp already scopes undo per fragment.
- Nested edits bubble through `changedParentTypes`, so a keystroke now reaches
  the table root's delta path. The current subscriber is a coarse per-commit
  flag; anything later that re-renders a list off that signal fires at typing
  frequency.
- `@y/prosemirror` binds to a nested type without change: it is typed against
  `Y.Type` and makes no root assumption. `apps/honeycrisp/src/lib/editor/Editor.svelte`
  changes by zero lines; its `yxmlfragment` prop name becomes a misnomer.

## Considered alternatives

- **Keep N documents and multiplex them.** Refused. The envelope already does
  this on the client, but it preserves the addressing, residency, and lifecycle
  machinery that the one-document shape removes. The byte-blind authority can
  relay opaque bytes without hydrating a document; ADR-0298 records that
  authority model.
- **Yjs subdocuments.** Refused, and measured: 25,000 never-touched subdocs cost
  about 5.1 KB of heap each because `ContentDoc.integrate` eagerly constructs a
  full `Doc` per reference. Subdoc updates never appear in the parent's stream,
  no provider dials them for you, and no API encodes a parent with its subdocs,
  so the envelope would survive re-keyed by guid. It is the N-document design
  with opaque addresses and a new per-row memory floor.
- **Change CRDT engine to one with lazy container materialization.** Deferred,
  not refused. Loro measures dramatically better on this exact axis, but has
  open issues for whole-document compaction memory and shallow-snapshot import
  reproduced on workerd, a 0.x ProseMirror binding with an open content-wipe
  bug, and effectively one maintainer. Revisit; do not bet stored personal data
  on it today.
