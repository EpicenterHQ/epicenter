# 0207. Rows render continuously to markdown, and frontmatter is the only way back

- **Status:** Accepted
- **Revived in part by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md). The folder, the one-file-per-row shape, and the "point your agent at `~/Epicenter`" premise return; the entire write direction (`push`, receipts, the scan, `status`, frontmatter-as-the-way-back) does not. Frontmatter-as-the-way-back and the receipt that guards it return under [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md), owned by the application rather than the host; `status`, the scan as a product surface, and any path from a rendered body back to a node stay refused.
- **Date:** 2026-08-04
- **Amended by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`) at the hole this record named and accepted (`:262-265`, "a table's prose is either in a field or unreachable from the folder"). The hole closes in the render direction only: a lens names which field is the body, so prose reaches the folder. It does not close in the push direction, and that is chosen rather than deferred, so a markdown-to-operations diff stays an optimisation nobody owns. What is required is that the folder stop treating a content field as an ordinary string.
- **Amended by:** [ADR-0234](0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md) at Ark pages only. Withdrawn there: continuous field rendering, the field-only prose restriction, and conflict-free push. Ark materializes a deliberate checkout of its page row and prose document, then imports only a three-way-safe patch.
- **Amended by:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) at "a row document is never rendered" and the rejected "app-supplied render and parse functions on a table definition"; an application may now supply a document codec, because the definition is an imported module rather than a serialized JSON artifact.
- **Built.** `defineTable`'s `body` key, the renderer, the receipt store, the scan, `push`, and `status` exist and are tested end to end against a real replica (`apps/epicenter/src/folder/`). The host starts the renderer at boot and composes `status` and `push` as the `folder__` verbs on its one action surface (`main.ts`, `src/folder-catalog.ts`, ADR-0021), so the folder round-trips. `push` is a `mutation`, which is what raises the session's approval prompt before anything is sent.
- **Relates:** [ADR-0206](0206-a-rows-id-comes-from-whoever-knows-it-and-one-relation-holds-every-fact.md) (one fact relation and a path-safe row id, which is what makes one projection rule sufficient), ADR-0010 (refused a continuous appdata sidecar and named the folder-the-user-controls shape this builds), [ADR-0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) and [ADR-0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) (Matter runs this same mapping at the opposite polarity and owns the serializer), [ADR-0176](0176-lenses-declare-no-query-capabilities-indexed-reads-require-separate-owners.md) (this adds no query surface), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (app data is machine-facing; this is not), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md), [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md), [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md)

## Context

Every durable fact this system holds is reachable only through an application.
A row's fields are JSON in one relation and a row document is a chain of Yjs
updates, so no editor, no shell tool, and no coding agent can read a body without
going through code written for the purpose. ADR-0176 keeps predicates out of the
typed surface and ADR-0162 gives ad hoc inspection to Home, but neither hands
anyone a directory.

ADR-0010 already refused one answer to this. A draft branch materialized each
recording to a hidden appdata sidecar, and the refusal named the reason
precisely: "a continuous producer with no consumer, paid on every edit." The
files were in `~/Library/Application Support`, where no human, agent, or CLI
would ever look. That same record then named the shape it would accept, a folder
the user controls alongside a SQLite surface the agent reads, and deferred it
until a real reader existed.

The reader exists now, and it is a coding agent with `ls`, `Read`, and `Edit`.

Two things changed what this costs. ADR-0206 collapsed the address space to one
relation, one depth, and a row id already safe in a path segment, so a projection
needs exactly one rule. And Matter (ADR-0065, ADR-0026) has been running this
exact mapping in production at the opposite polarity, which means the markdown
round trip is a solved, tested problem rather than a thing to invent.

## Decision

**Rows render continuously to markdown in a folder the user controls, and
frontmatter is the only way back.**

### One human-facing location

```txt
~/Epicenter/
  so.epicenter.honeycrisp/
    notes/
      <row>.md
```

Home directory, capitalized, no dot. That is the convention every tool in this
category converged on independently (`~/Dropbox`, `~/OneDrive`, and the same path
under `%USERPROFILE%` on Windows), and lowercase-with-a-dot is the signal for
hidden machine state, which this is not. Configurable, but the default has to be
typeable, because "point your agent at `~/Epicenter`" is the whole product.

This is **not** the app data root (ADR-0201). That directory holds the replica,
blob bytes, and caches, is explicitly not an inter-app API, and putting a human
surface in it recreates exactly the failure ADR-0010 refused.

The replica itself stays there and does not appear here. `epicenter.sqlite3` is
one generic fact relation holding JSON, shared by every app: querying it means
`json_extract` across a union, which is a storage format rather than a query
surface. What belongs beside the markdown is a queryable projection, decided by
[ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md).

### Every table materializes, and there is no flag

There is no opt-in and no opt-out. Every table a Lens declares renders to files,
so `ls ~/Epicenter` is the database, and an app author writes nothing to get it.

A flag was considered and refused for lack of a producer. Every shipped Lens
table is user data (`skills`, `notes`, `conversations`, `devices`, `bookmarks`,
`entries`, `settings`, `tabs`), because a Lens table is by construction something
an app author declared as their data model. The replica's own bookkeeping lives
in the `_replica_*` schema and is not a Lens table at all. If a genuine
machinery table ever appears, adding `materialize: false` then is one additive
key and breaks nothing.

The asymmetry that decided it: an author who forgets to opt in produces an empty
directory that explains nothing, which is ADR-0010's failure arriving from the
other side. An author who should have opted out produces a folder with a few
opaque files in it, which is a wart someone fixes in a line.

### Rendering is continuous and never destructive

The renderer holds back **exactly what you could still push, and shows current
state everywhere else**. A cell you changed is pending intent and is left alone.
A cell you did not touch is updated in place. A body you did not touch is
re-rendered. One rule with no exceptions, so no file ever drifts outside the
cells you are actively editing, and the folder never becomes a patchwork of
current and stale rows that look identical.

### `epicenter push` is the only write door

Nothing leaves the machine because a file changed. `status` and `push` are scans,
run when you type them; there is no watcher, so an edit made while the engine was
stopped is found exactly as if it had been running.

Push compares two values per field: `base`, the receipt of what was written into
the file, and `mine`, the file now. Every field that matches the receipt is
untouched and is not sent. Everything else is.

That is the entire rule, and it is what protects a peer: a field you did not
change is absent from the patch, so nothing can clobber what another device
wrote to it, however long the file has been sitting.

**There is no conflict.** Epicenter has no conflict concept anywhere. A write is
`{ set, unset }` per field, the authority sequences them, and two devices setting
one field resolve by order without asking anyone. A folder is another device, so
it resolves the same way. Comparing against the row as it stands now, and
stopping when both sides moved, would make this the only place in the system that
escalates to a human, in service of a case the rest of the system settles
silently.

There is no second table for prose either, because the body is one of these
fields.

The receipts live in the host's own store under the app data root (ADR-0201),
never in the folder and not in `epicenter.sqlite3`. Never in the folder so the
directory holds no hidden state and `rm -rf` on it costs nothing. Not in the
replica's file for two reasons, the second being the real one: `createEpicenter`
deliberately does not expose its database handle, and this is the renderer's
bookkeeping rather than the replica's. The folder is the human-facing artifact;
this is the machinery behind it, and machinery is what the app data root is for.

Each receipt is a path, an address, and the fields written. Losing the store is
safe and self-healing: every file becomes unpushable until it is re-rendered,
which costs unpushed edits and nothing else.

A scan reads and parses every file rather than consulting `mtime` and `size`
first. Slower, and free of edge cases: the fast path's failure mode is missing an
edit made in the same second the renderer wrote the file, which is git's
racy-index problem, and buying it back costs a stat pair, a branch, and a rule.
Add it when a scan is measured and found slow.

The receipt is the only thing that can distinguish your edit from the state the
file was rendered at. A file whose receipt was lost is therefore refused rather
than pushed, since without it every field looks changed and a stale file would
send fields you never touched. Re-rendering restores it.

### A body is a field, and row documents are never materialized

The file's body is one `string` field, named by the table:

```ts
defineTable({
  fields: { title: field.string(), content: field.string() },
  body: 'content',
})
```

A field name, checked at authoring time against that table's own fields and
required to be `field.string()`. Absent is the ordinary case: every field renders
in frontmatter and the file has no body.

**A row document is never rendered and never written.** `RowDocument` exposes
`Y.Doc['get']`, so a document is an arbitrary `Y.Doc`. Markdown can represent
some of them and write back fewer: a `YXmlFragment` behind a rich text editor
serializes out and does not come back without a ProseMirror schema every
application would have to conform to, plus a tree diff through library internals.
That is a large, permanent surface bought for one direction of one case.

A table whose prose lives in a document declares no body, and that prose stays
where it is designed to be edited, in the application. This is the one place the
folder is deliberately incomplete, and it is a refusal rather than a deferral.

What it buys is that the folder has no second kind of anything. No text diff, no
operational transform, no document plane, no vocabulary of body kinds, and no
table whose body renders but cannot be pushed. Fields already round-trip, merge
per cell, and validate, so prose inherits all three by being one.

An application that wants its prose in the folder moves it to a `string` field
and gives up character-level collaborative editing on it. That is the
application's trade to make, openly, rather than a mechanism the folder grows to
paper over it.

This is cheap for one reason worth stating, because it was mispriced twice during
design: the hard case, applying your edit to a document a peer already moved,
never reaches the merge code. Concurrent edits stop at push like any other
conflict. What remains is a document whose rendered body still equals the base
byte for byte, where a plain text diff's offsets are already correct.

### Each file is a claim, and claims are judged independently

The `id` in frontmatter binds a file to a row, so the filename is decoration and
renaming is never ambiguous. Absence of an id is a positive signal rather than an
accident: a file with no id creates a row, and the minted id is written back into
the file at push.

Duplicate ids are the failure this actually produces, because `cp a.md b.md`
makes one. Push refuses, names both paths, and asks which is the row. It never
guesses.

A malformed claim is refused **per file, never per push**. No transaction spans
rows, so a value that is a valid YAML scalar but wrong for its declared field has
nothing to do with a valid claim on a different row. Push names the file and the
field, applies everything else, and leaves the bad file for you to fix.

### Deletion is expressible, and always shown

A row no file claims any more is a pending deletion. This is the one place the
folder's *absence* carries intent, so a backup tool, a bad glob, or a disk fault
becomes a queued deletion. It is therefore always listed in `status`, and **no
flag may skip the deletion section of a push**.

Matched by the id in frontmatter rather than by path, so renaming a file carries
its receipt with it instead of reading as a deletion plus a baseless stranger.

### Serialization is Matter's, and is not rewritten

`packages/matter-core` already publishes the round trip: value-identity rather
than byte-identity, YAML 1.2 core with no Norway coercion, the body carried
verbatim through a frontmatter write, and a nullish contract where clearing a
field deletes the key instead of writing `null`. `applyFieldEdit` is exactly the
in-place field write this needs, and it is what lets a peer's field change land
on a file whose body you are editing. A second serializer is refused.

Parsing is schema-directed by the Lens, so a value that is a valid YAML scalar
but wrong for its declared field is refused rather than coerced. The body is
carried verbatim in both directions and never reparsed, so prose that opens with
its own `---` fence survives the round trip untouched.

### Blobs never enter

A row's blob (ADR-0173) is not materialized. Frontmatter carries the id and
nothing else. This is not a limitation to lift.

### The layout is derived, and is not a compatibility surface

Nothing durable records how the folder was laid out. Filenames, frontmatter
serialization, and body rendering are all functions of the replica, and changing
any of them is re-rendering rather than migrating. The row id in frontmatter is
what binds a file to a row; the filename is decoration and owes nothing to a
previous version.

## Consequences

- An agent reads and edits with `cd`, `ls`, `Read`, and `Edit`, with no tool to
  install, no schema to discover, and no capability to grant.
- **ADR-0010's test is the one this must keep passing.** A continuous producer
  needs a consumer. The consumer here is a coding agent in a directory the user
  can name, which is precisely what appdata was not. If `~/Epicenter` stops being
  where people look, ADR-0010's objection returns and is correct.
- **Push is not a second sync path.** A patch lands in the replica and travels by
  the outbox that already exists. Markdown never touches sync.
- **ADR-0176 is untouched.** No predicate, ordering, page, or cursor is added.
  Rendering a table is `scan` with a different output.
- **Matter and this share a serializer, not a polarity.** Matter is disk-as-truth
  with a disposable SQLite projection; this is SQLite-as-truth with a disposable
  folder. ADR-0065 forecloses merging them, since sync and accounts are out of
  Matter's definition by design.
- No lock, so no application ever has to implement a frozen state, and ADR-0203's
  contention question is answered by per-unit merge rather than by an owner.
- **One rule, and only one kind of thing:** send the fields that differ from the
  receipt. The unit is a field, and prose is a field, so there is no second
  behavior to keep in step.
- **Nothing in the folder ever asks a human to resolve anything.** Push either
  sends or refuses for want of a receipt. That matches every other writer in the
  system and is what keeps "point an agent at it and walk away" true.
- **The folder never touches the document plane.** No `Y.Text`, no
  `YXmlFragment`, no text diff, no operational transform, no ProseMirror. The
  entire Yjs surface of this feature is that it has none.
- **A table's prose is either in a field or unreachable from the folder.** That
  is a real hole, and it lands hardest on rich text editors. It is the price of
  the previous two lines, and it is paid by the application, visibly, rather than
  by the mechanism.
- **Every app gets the folder without writing a line.** An app author who never
  reads this record still finds their tables on disk, which is the only way the
  consumer ADR-0010 requires reliably exists.
- **What this forecloses:** files as a durable form, a watcher that publishes on
  save, a second write path that bypasses `patch`, blob bytes on disk, a lock on
  any row, a conflict surface, app-supplied render or parse callbacks in a table
  definition, and any promise that the layout is stable across versions.

## Considered alternatives

- **Files as the truth, with SQLite as a rebuildable index.** Matter's polarity,
  and it genuinely works, which is why it ships. Rejected here because it moves
  the truth to the weaker representation: the mapping stops being total the first
  time a schema holds something markdown cannot express, and it discards a
  replica, a field-level merge, and a browser and phone story that already work.
- **A temporary checked-out copy, locked for its duration.** The previous version
  of this record. Rejected once the comparison was done honestly: a checkout has
  the *same* conflict surface as a continuous folder, because two writers touched
  one row either way, and it adds staleness on every file you did not edit. The
  lock it needs would also have to be implemented as a visible frozen state in
  every application.
- **A watcher that publishes every save.** Rejected: no review before anything
  lands, and `rm` reaches the synced database instantly. The read/write asymmetry
  is real, and one mechanism cannot serve both.
- **A read-only tree with no write path at all.** Rejected as insufficient. An
  agent's `Write` would succeed and the next render would discard it silently.
- **Read-only bodies, with only frontmatter pushable.** Held briefly and
  rejected, because it is the one place two things that look alike in a file
  would behave differently: a changed field is held for you, a changed body is
  discarded. It was adopted on a mispricing. The expensive case, applying your
  edit to a document a peer already moved, never reaches the merge code, because
  concurrent edits stop at push like any other conflict. What was left is a text
  diff against a base that still matches byte for byte.
- **Rendering the row document as the body.** Carried furthest of any rejected
  option, through three shapes, and each one broke somewhere different. A plain
  `Y.Text` round-trips, so a tag naming its key works, but the codebase already
  disagrees on that key (`'body'`, `'content'`, `'draft'`) and the app that most
  wants a folder is not text at all. Honeycrisp is ProseMirror, so its document
  is a `YXmlFragment`: it serializes out through `prosemirror-markdown` and comes
  back only with a schema every app must conform to, plus a tree diff through
  `@y/prosemirror`'s unexported delta layer in a `2.0.0-6` prerelease. Supporting
  both kinds means two renderers, and supporting one means a table whose body
  renders but cannot be pushed. Refusing the document plane entirely deletes the
  text diff, the operational transform, four ProseMirror dependencies, the schema
  constraint, and the seam, and costs one honest hole an application can close
  for itself.
- **App-supplied render and parse functions on a table definition.** More
  expressive and immediately fatal: `TableDefinition` serializes to JSON, and a
  function does not cross that boundary.
- **Guessing the document's shape at runtime** by opening it and looking for a
  `Y.Text`. Rejected: `Y.Doc['get']` coerces, so guessing wrong on a
  `YXmlFragment` corrupts rather than fails, and it would make what appears on
  disk a function of runtime state rather than the schema.
- **Detecting conflicts by comparing against the row as it stands now.** Built,
  then cut. It answered a question nothing else in the system asks: `replica.ts`
  has no conflict concept, only a SQL upsert clause, because per-field patches
  sequenced by the authority make one unnecessary. Keeping it would have made the
  folder the single place that stops and demands a human, contradicting both the
  rest of the data plane and the premise that a folder is another device. The
  case it covered, you and a peer changing one field while your edit is unpushed,
  now resolves by order exactly as it would between two applications.
- **Keeping the base body, a minimal diff, and a `stat` fast path.** All three
  were written and then cut, and they share a shape: each pays real, permanent
  complexity for a cost nobody has measured. The base body doubled every byte of
  prose on disk to answer two questions a hash answers. The minimal diff was 100
  lines producing identical text. The fast path bought scan latency at the price
  of git's racy-index edge case. Each is a contained change to add back, behind a
  measurement.
- **A CLI or MCP server as the only write path.** Rejected: it is the difference
  between "point your agent at this folder" and "install our integration," and it
  gives up every external editor for a guarantee `patch` already enforces.
- **`git clone epicenter://` via a remote helper.** Attractive and genuinely
  supported by git, but redundant. The folder is a real directory, so `git init`
  in it gives you log, diff, and branches today with no code from us, and your
  other machines already have the folder because they sync. Cloning only serves a
  machine that will never run Epicenter, which `git push` to any host solves.
- **Mounting the replica as a filesystem (FUSE or FSKit).** The correct idea at
  the wrong cost: a different implementation per platform, kernel-extension
  territory on macOS, and a category of failure this team cannot absorb. Worth
  reopening if that changes.
- **Materializing into the app data root.** Rejected by ADR-0010 already, for the
  reason that record gives.
