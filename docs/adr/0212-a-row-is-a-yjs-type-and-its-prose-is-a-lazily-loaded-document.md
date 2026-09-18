# 0212. A row is a Yjs type, and its prose is a lazily loaded document

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amended by:** [ADR-0248](0248-a-row-owns-an-independent-yjs-document-at-a-derived-address.md)
  at the index/document split. The row's scalar type remains nested in the
  application document, while its rich document is independently loaded.
  this branch. Reconcile at merge time (`docs/adr/README.md`). This record
  replaces an earlier 0212 that specified a hand-built cell store; that draft was
  `Proposed` and is rewritten in place, per the same-number rewrite pattern the
  corpus already uses.
- **Amended by:** [ADR-0219](0219-a-deleted-row-is-removed-and-the-presence-flag-is-retired.md)
  at deletion only. Withdrawn: clear-and-flag, the `!presence` attribute and its
  grammar, and the reuse story in which writing at an absent address revives it.
- **Amended by:** [ADR-0256](0256-automatic-folding-is-the-current-maintenance-path-and-manual-workspace-compaction-is-deferred.md)
  at workspace replacement: the current product has no whole-document rebuild
  action. Automatic folding stays within one Yjs document, while a future
  Compact workspace action may create a fresh document identity as a separate
  decision. A cursor is within that document only; the private identity names
  the document and authorizes a replica's admission.
- **Relates:** [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
  (the lens and the application surface),
  [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (persistence and history).
- **Supersedes:** [ADR-0163](0163-scalar-sync-separates-fact-reads-from-numbered-intent-submissions.md)
  (`Proposed`) and, through it,
  [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md),
  [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md)
  and [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md)
  (all `Accepted`), because retiring 0163 alone would revive them. Withdrawn from
  all four: numbered intent submission, the sealed batch and its
  `(sequence, digest)` receipt, `batch-conflict` recovery, replica-id rotation,
  settled watermarks, and the three-way bootstrap / history-gap /
  lineage-mismatch recovery taxonomy. A Yjs state vector answers all three
  recovery questions with one mechanism. The earlier 0212 draft carried these
  same supersessions for the same reason with a different replacement; the
  replacement changed, the retirement did not.
  Also [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md).
  Withdrawn: the write-once blob slot and `digest A + B -> refuse or park B`. A
  blob digest is an ordinary field a later write repoints.
- **Amends:** [ADR-0121](0121-background-sync-resolves-key-conflicts-by-server-order.md)
  at the conflict rule and the outbox. Withdrawn: server acceptance order as the
  rule, and the durable outbox its crash-recovery paragraph depends on. What
  survives, and is restated here, is that no background conflict inbox exists and
  no losing value is shown to a person.
  Also [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md)
  at the unit of convergence, which becomes one Yjs attribute. Its refusal of
  distributed transactions survives and is why this record needs no cross-field
  invariant.
  Also [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md)
  at the presence law. Withdrawn: that `absent` is a terminal tombstone making an
  address single-use. An address is reusable; the content is not.
  Also [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md)
  at the mechanism, not the law. An unsent Yjs update *is* the obligation.
  Also [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)
  at its storage inventory: "pending intents" is withdrawn with the queue. Its
  division of labour survives.
  Also [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md)
  at the publication obligation: the revision counter is replaced by the unsent
  bytes themselves. Its nullable compact projection survives.
  ADR-0207 is **not** amended. A draft of this record claimed a body reaches the
  folder; it does not. Because a row's document is inherent rather than declared,
  Epicenter never learns which root inside it is prose, which is exactly why
  ADR-0207 refused to render it after carrying the idea through three shapes
  (`:299-311`). That record's hole stands unchanged: a table's prose is either in
  an ordinary field or unreachable from the folder.
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md)
  (`Accepted`) at root naming only. Withdrawn: that Epicenter "does not declare,
  validate, version, reserve, enumerate, or interpret" roots. Epicenter now
  declares that a root is a table, names a row's document `<table>/<rowId>`, and
  reserves the `!` prefix. What survives, and is the reason the split below
  matters, is the clause that does the work: Epicenter never interprets the
  inside of that document. An application names its own roots there and chooses
  its own format, exactly as 0135 and 0130 both say.
- **Confirms and does not amend:**
  [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md)
  (`Accepted`, "every ordinary row inherently owns one lazy collaborative
  document. The table does not opt in, declare roots, or choose a format").
  Two earlier drafts proposed amending it, first to declare a document per
  column and then to declare one per field with a lens sentinel. Both are
  withdrawn. This record adopts 0130 exactly as written, including its API:
  `using document = await tables.notes.document.open(row.id)`, with the
  application naming roots inside.
- **Amended by:** [ADR-0284](0284-the-application-document-is-an-index-and-a-rows-remaining-fields-live-in-its-own-document.md) at what the row document holds: scalars declared `record`, beside the prose.

## Context

Epicenter holds what a person makes: their notes, tags, ratings, playlists,
saved views, recordings. Mail and tracks are mirrors that rebuild from a
provider and never merge (ADR-0192); blobs are captures written once. Only the
contributed plane needs to merge, and it is small: the real vault measures 986
notes and 2.84 MB, 3.2 frontmatter fields each, with a ~2.8 KB body.

An earlier draft of this record specified a hand-built per-field cell store with
its own version triple, digest and clock clamp: about 2,100 lines across three
records. Measured head to head against Yjs 14 on that same vault, the hand-built
store lost on every axis that matters:

| | Yjs | hand-built cell store |
| --- | --- | --- |
| stored size | **3.02 MB** | 5.11 MB |
| sync manifest | **state vector, ~0 KB** | 201 KB |
| one field changed, on the wire | **43 B** | 172 B |
| full projection rebuild | **2 ms** | 4 ms |
| a field edited 5,000 times | **2 structs, 0.1 KB** | grows linearly |

Yjs cannot do exactly one thing the hand-built store could: resolve a conflict by
recency. A concurrent write to the same field is won by the higher Yjs
`clientID`, not by whoever edited last. Verified by giving the low-`clientID`
device a 20-operation head start and making it write last; it still lost. That
loss is accepted deliberately, and it is the only thing 2,100 lines were buying.

## Decision

**A row is one Yjs type in a per-application index document. Every row also
inherently owns one document, keyed by its address and loaded on demand, whose
contents Epicenter never declares or reads.**

### The index document

One `Y.Doc` per application, `gc: true`. **One root per table, not one per row.**
A table's root holds its rows as attributes; each row is a nested type whose
attributes are its scalar fields:

```txt
"notes"      table root.  attrs are row ids -> a nested type per row.
                          each nested type's attrs are that row's fields.
"tags"       table root.
```

**One root per row is refused, and the reason is a hard wall rather than a
preference.** `Item.write` calls `findRootTypeKey`
(`node_modules/@y/y/src/structs/Item.js:477`), and `findRootTypeKey` is a linear
scan of `doc.share` (`utils/ID.js:79-87`, read directly). With one root per row,
`doc.share` is the row count, so encoding the document is quadratic in rows:

| rows | one root per row | one root per table |
| --- | --- | --- |
| 1,000 | 23.2 ms | 1.8 ms |
| 5,000 | 364.4 ms | 3.0 ms |
| 20,000 | **5,416.8 ms** | 13.1 ms |
| 100,000 | unusable | 38.2 ms |

`documents.ts:328-331` runs exactly that encode every 64 appends, so at twenty
thousand rows the root-per-row grammar is a five-second freeze on one write in
sixty-four. The wall is row count, not write rate.

The nested grammar costs nothing in merge behaviour. Verified: a device deleting
a row while another edits it offline converges with the tombstone held and the
edit retained, and two devices editing different fields of one row while both
offline both survive, exactly as with roots. An earlier draft rejected nesting
after testing it with `deleteAttr(rowId)` on the table root, which does destroy a
concurrent edit; that is not how deletion works here.

Every scalar field is one attribute, so per-field merge is preserved. Storing a
whole row in one attribute instead loses one side and costs a 6.5x larger delta.

A row carries no sequence content of its own. Rows are maps.

`!` is reserved and no lens name may begin with it, so `!presence` cannot collide
with a field. It stays a single character because `!` can begin neither an
arktype expression nor a JavaScript identifier, so the reservation is enforced by
syntax rather than by a rule someone has to remember.

### Prose is a separate document, and it is not declared

Prose is **not** stored in the row, and the lens says nothing about it. Every row
inherently owns one `Y.Doc`, keyed by its address (ADR-0130):

```txt
"notes/n1"           one document per ROW, opened when the row is opened
```

Nothing stores a reference. The address *is* the reference, so there is no id to
dangle and deleting the row implies deleting its document. An application that
wants several streams of prose puts several roots inside the one document, which
is what ADR-0130's `document.get('editor')` and `document.get('comments')`
already describe. Epicenter learns none of their names.

Measured on the real vault:

| | prose inside the row | prose as its own document |
| --- | --- | --- |
| bytes loaded at startup | 3.04 MB | **0.31 MB** |
| total stored | 3.04 MB | **2.99 MB** |
| cold open | 7.2 ms | **2.3 ms** |
| open five notes | n/a | **0.18 ms** |
| per-document overhead | n/a | **27 B** over raw text |
| ADR-0146's 1 MB bound | **3.04 MB, over** | index 0.31 MB, largest prose 30.4 KB |

The split is smaller in total, ten times smaller at startup, and it is the only
arrangement that satisfies ADR-0146's `stateBytes = 1_048_576` bound, which
ADR-0174 makes terminal. Separate documents cost 27 bytes each.

**The index syncs always; a prose document syncs when it is opened.** A closed
note's prose being minutes stale costs nothing, because nothing is reading it.
Prefetching every body is 2.7 MB and is a policy, not a mechanism.

### Opening a prose document is asynchronous

It is a load, and on two of the three shipped surfaces it is a round trip to
<!-- doc-path-check: ignore-next-line (names a file the superseded stack carried; ADR-0227 deleted it) -->
another process (`packages/app/src/data/browser/worker.ts:762`,
<!-- doc-path-check: ignore-next-line (names a file the superseded stack carried; ADR-0227 deleted it) -->
`packages/app/src/data/desktop.ts:282`). A synchronous property chain in front of it
would either force eager loading, giving back the entire startup win above, or
buffer into a document that has not arrived. The lazy load is the decision; the
API must show it.

### An application owns the inside of a prose document

Epicenter creates the document and never looks in. Plain text, a ProseMirror
tree, or anything else is the application's business, and this is the surviving
half of ADR-0135.

That containment is load-bearing rather than stylistic. `@y/prosemirror` calls
`setAttr` and `deleteAttr` on the type it binds to (`sync-utils.js:243-246`), and
`nodeToDelta` writes a node's attributes (`:435-437`), with the top-level call at
`:399` carrying the document node's own attributes. An editor bound to the row
would share an attribute namespace with the row's fields. Verified in the
separated shape: an editor writing junk attributes into its own document, then
calling `clearAttrs()`, leaves the row's fields untouched.

### Existence and deletion

`Doc.get(key)` **mints** a root: it is `map.setIfUndefined(this.share, key, ...)`
(`utils/Doc.js:197-203`). A misspelled id therefore creates a root, and roots
cannot be removed. Verified: reaching into `doc.share` and deleting corrupts the
encoder outright, so the document no longer encodes.

So one reserved attribute carries both existence and liveness:

```txt
!presence   "present" | "absent"
```

A root with no `!presence` never existed. `open(id)` checks `doc.share.has(id)`
before it ever calls `get`.

Deletion clears and marks:

```ts
for (const key of row.attrKeys()) row.deleteAttr(key)   // drop the fields
// drop each content document
row.setAttr('!presence', 'absent')
```

Clearing is what reclaims space, and it is not optional. Measured over 1,000
rows: setting a flag alone leaves the document **larger** than before
(2,908 KB against a 2,888 KB baseline), because the content is all still there.
Clearing takes it to 86 KB.

A dead row then costs about **80 bytes**, forever, and the cost has a shape:

```txt
dead row ~= 35 + len(rowId) + SUM over cleared fields of (2 + len(fieldName))
```

Measured the way deletion actually works, clearing every attribute and then
flagging, with ADR-0206's 24-character minted ids: **82 B** for a three-field
row. Flat in row count, 82.5 B at a hundred rows and 82.0 B at twenty thousand.
Unchanged by value size, an 8-byte value and a 1 KB value both cost 82 B; by
edit history, 85 B after twenty edits per field; and by compaction. A 2.8 KB
nested document adds 13 B.

**It is flat in row count and not flat in row shape.** Each cleared attribute
leaves a tombstone costing two bytes plus its own field name, and the V2 encoder
does not deduplicate that name across rows, so a forty-character field name
costs forty bytes on every dead row forever. Short field names are worth
something. A hundred thousand lifetime deletions cost about **8.2 MB**.

Three earlier figures in drafts of this record were wrong: 21 to 23 bytes, then
68, then 170. The first two measured a root that had never held a field. **The
170 is reproducible only with `gc: false`**, which measures 169.1 B, and that
one wrong flag produced two wrong sentences: replaying gc-off state into another
gc-off document indeed does not reduce it, which is where the companion claim
that "compaction through a fresh `gc: true` document does not reduce it" came
from, while replaying it into a genuinely `gc: true` document drops it to 82 B.

The stated derivation was also arithmetically impossible. It claimed 86 B became
170 B because ADR-0206 mandates 24-character ids, but the measured slope is 1.13
bytes per id character, so going from four characters to twenty-four adds twenty
bytes, not eighty-four.

### Tombstones are never collected

One hundred thousand lifetime deletions cost about 8.2 MB. Collecting them
instead would require knowing every device has seen the delete, which means a
device roster, per-device positions, and a rule for when a silent device is
gone. That is a distributed-systems subsystem bought to save eight megabytes.
An earlier draft said 2.2 MB here and 17 MB two paragraphs above, which could
not both be true.

Yjs enforces this by construction, because a root cannot be removed. The
decision is therefore a statement of what the library already does, not a policy
anything has to hold.

### Deletion is terminal; the address is not

Creating at an absent address sets `!presence` back to `"present"`. The previous
content is gone from the CRDT and comes back only from history (ADR-0214).

### Trash belongs to the application

Epicenter has one delete. An application that wants a trash uses an ordinary
nullable field and simply does not call delete yet. Retention windows, timers
and two-stage lifecycles are product decisions and do not belong in the store.

## Consequences

- **A concurrent write to the same field resolves by `clientID`, not by
  recency.** Different fields, different rows, and prose all merge correctly.
  This is the whole cost of the decision and it is not recoverable from inside
  the CRDT; ADR-0214's history is the answer when it matters.
- **Deleted:** the cell relation, the version triple, the multiset digest, the
  five-minute clock clamp, the re-stamp and its measured loss, the download
  cursor, and the authority-side merge. About 2,100 lines of record become about
  600, and the authority stops needing to understand anything but bytes.
- **A prose document is unreachable from the folder in the push direction.**
  ADR-0207's hole is re-accepted rather than closed: prose lives in a document
  whose shape Epicenter never learns, so it does not reach the folder in either
  direction. An application that wants its writing on disk puts it in an ordinary
  field, which renders and round-trips like any other.
- **A table root grows monotonically, and listing it pays for every row ever
  deleted.** Reading `!presence` on every row is what costs: measured, listing a
  thousand live rows among a hundred thousand takes 24.9 ms nested, and 14.7 ms
  under the refused root-per-row grammar. Neither is free, because both touch
  every corpse. If a table ever gets slow to list, the fix is a second attribute
  on the table root naming only the live rows, which is read in one call rather
  than one per row. Not built; no table is near this.
- **Private document identity gates admission; there is no public generation.**
  A stale device compares its declared identity with the authority's identity
  and discards the physical replica rather than merging across documents. That
  identity is one equality check, not a lineage or migration system. Automatic
  folding keeps it unchanged. A future Compact workspace action may replace it,
  but that action is deferred until measured root pressure justifies its loss
  boundary.
- **A prose document must never have its type replaced.** Measured: replacing the
  document behind a row reclaims the old content correctly, but a handle still
  held by an editor keeps accepting writes that go nowhere, silently. A row's
  document is opened, never assigned, so the operation has no expression in the
  API (ADR-0213).
- **Yjs 14 is a new API, not a new encoding.** Verified both directions: a v13
  document reads v14 bytes and a v14 document reads v13 bytes.
