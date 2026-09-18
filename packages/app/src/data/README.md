# Application data engine

The Epicenter store: one Yjs document per database, holding every row and every
row's rich content, a synchronous surface over it, and the transport that
carries it between a person's devices. AGPL-3.0-or-later.

The main entrypoints are:

| Import | What it gives you |
| --- | --- |
| `@epicenter/app/store` | Store handle and error types |
| `@epicenter/app/data` | `openData(definition, sqlite)` and `syncEngineOf`; the caller owns SQLite |
| `@epicenter/app` | `defineApp`, `defineTable`, and `field`: the application declaration |
| `@epicenter/app/definition` | Reusable table vocabulary and schema compilation |
| `@epicenter/app/sync` | `createSyncConnection`, and the authority half a server runs |
| `@epicenter/app/artifact` | `renderArtifact` renders Markdown; `readArtifact` reads Markdown into a fresh document. Ordinary edits use checkout instead. |
| `@epicenter/app/artifact/checkout` | `createWorkingCopy` with previewed `pull` and `push`, using the checkout manifest as the three-way baseline |
| `@epicenter/app/memory` | `openMemory(definition)` and `createMemoryRecord()`, test support |

Application data persists through the App's IndexedDB backing. `openData`
opens the same document engine over a caller-owned SQLite connection, including
Worker probes. Disposing the data document leaves that connection open.
`openMemory` supplies Bun-only in-memory storage for tests. A supplied
`MemoryRecord` survives document disposal so a test can reopen the same bytes.
These entrypoints do not load the App or its platform implementations.

## Current-library startup

Applications await `openApp` from `@epicenter/app/open` for a ready App; see the
[App README](../../README.md). The App captures its account and library choice,
claims exclusive ownership, and calls `acquireAppData` for browser persistence.
Local opening needs no server. Personal and Shared opening use a cached current
library when available; otherwise they POST an initialization candidate to the
current-library route and install the canonical response.

The response contains a generation, snapshot, and every update through its
captured head. Startup applies and validates all of them before atomically
publishing a usable cache. Network failure does not establish that a library is
empty. Retirement fences retained writes and invalidates the old cache before
releasing ownership. A subsequent open downloads the replacement.

The current account cache uses this IndexedDB name:

```text
epicenter/<appId>/accounts/<authorityId>/<principalId>/data/<dataId>/<personal|shared>/current
```

The generation lives in its header. Both authority and actor scope the local
copy, including a Shared replica. Another actor's pending edits cannot be
replayed from this cache. The server owns the corresponding remote destination.

### Historical generation caches

The numbered-cache opener and its generation listing, creation, and erasure
helpers are retired. Current startup never reads, migrates, or deletes those
historical bytes. The server still refuses current Personal initialization
with HTTP 409 when historical admitted generations exist; removing client
helpers does not authorize a new empty library over that history.

Skills retains its current startup refusal. Migrating its account-taking adapter
does not choose a new auth or product model. The durable-store browser evidence
now exercises current App-owned acquisition.

Opening replays a durable log into one Yjs document. Once ready, table reads
and edits are synchronous. The App retains its ownership claim until the store
and its other resources finish closing.

## The surface

Each table the definition declares is a key on `data.tables`. The opened data
object carries both the application view and the document capabilities, so a
table can be named anything a person names it:

```ts
data.tables.notes.create(fields)                  // Row, at a minted 24-character id
data.tables.notes.get(id)                         // Row | undefined
data.tables.notes.update(id, patch)               // Result<void, RowAbsentError>; merges
data.tables.notes.delete(id)                      // void; deleting nothing is a no-op fact
data.tables.notes.rows                            // Row[], read through the declaration
data.tables.notes.nonconforming                   // rows this release cannot read
data.tables.notes.ids()                           // string[], sorted, unconformed
data.tables.notes.subscribe(listener)             // this table's SHAPE changed
data.tables.notes.watch(type, listener)           // one live type's content changed
data.transact(() => { ... })                      // several writes, one commit
```

Settings live on `data.kv`, which has `get(key)`, `update(patch)`,
`nonconforming`, and `subscribe`. There is no id and no `create`, because there
is exactly one and it always exists.

Reads are per KEY and the signal is not: `get('theme')` returns that one value
and `undefined` covers both "never written" and "written as something this
declaration cannot read", while `subscribe` fires when ANY declared key
changes. The invalidation is deliberately a superset of what moved (ADR-0187),
so a reader re-reads and finds the same answer rather than missing one. A
default belongs to the application, not the declaration:
`kv.get('theme') ?? APPLICATION_DEFAULTS.theme`.

The row owns its content node, and the database document owns its lifetime.
`data.transact(() => { ... })` groups direct table and KV operations into one
accepted transaction. Persistence is a separate best-effort step exposed by
`data.persistence` (ADR-0300).

SQL, when an application wants it, is a follower it composes over this
surface: hydrate from `rows`, follow commits through `data.onCommitted`,
and rebuild whole at the next read, so an index can never serve rows the live
document has moved past (ADR-0241). The package shipped one such follower and
no application ever composed it, so it was deleted; a person who wants to look
at their data outside the app reads the export (ADR-0268), which is files.

`data` carries the document itself: `pressure()` (how much of it is dead
weight), `stored()` and `rowFile()` (what is there, before the declaration reads
it, which is the export's read and not an application's), `onCommitted`
(anything committed, whoever wrote it), `persistence` (whether accepted work has
reached durable storage, ADR-0238), and `sync`, the value that tells the two
store kinds apart (ADR-0239): `undefined` on a local document and
`{ replicates: true }` on an account replica. They live under one key rather than
beside the tables so that no table name is reserved: `kv` is the only one a
definition refuses, so a follower may project KV as a relation of that name
without colliding with a table.
The delivery machinery underneath sync (the outbox, cursors,
acknowledgements) is internal; only the transport drives it.

### Reading

`rows` and `nonconforming` are two getters, not one call: the rows this
release could read, and the ones it could not.

```ts
const rows = data.tables.notes.rows;
const unreadable = data.tables.notes.nonconforming;
```

Neither is a `Result`, because nothing in it can fail: reads come from a
document already in memory. A disposed store throws `StoreUnusableError`
instead of dressing that up as a read outcome (ADR-0237). The old shape
returned a `Result` here, and `.data?.rows ?? []` quietly rendered an
operational failure as "you have never written one of these"; the throw makes
that unwritable. Storage falling behind is not a read outcome either: the
store keeps serving the live document and reports through
`store.persistence` (ADR-0238). Discarding `nonconforming` is still the trap
it always was: rows a person wrote are simply missing from the screen with
nothing to explain why.

`get(id)` returns the row or `undefined`. A row this declaration cannot fully
read is not returned as an error arm here: it is absent from `rows` and present
in `nonconforming`, as plain diagnostic data (`{ id, raw, conforming, issues }`)
with no `name` and no `message`, because there is nothing else in the arm to
tell it apart from.

```ts
const note = data.tables.notes.get(id);
```

### Reacting

`subscribe` fires once per commit and means this table's SHAPE changed: a row
added, a row removed, or a row's values edited. It fires for a local write and
for bytes from another device alike, and after every `onCommitted` listener has
run, so a composed follower is already marked dirty by the time a subscriber
reads through it.

It hands the listener the row ids the commit touched. A caller may ignore
them: re-reading with `rows` walks a document already in memory and is always
correct. What they buy is the caller holding a projection of the rows, which
rebuilds only what moved instead of everything.

It deliberately does NOT fire for an edit inside a row's content node. The
node is nested on its row, so counting it here would wake every list in the
application at typing frequency. `data.tables.notes.watch(node, listener)` is the signal for
that, scoped to the one node, and it is delivered last so a listener that writes
is writing against a settled commit.

Registration is synchronous, does no I/O, and never fires initially, so a
caller that subscribes and then reads has already seen everything. There is no
generation counter to keep and no `refresh()` to remember:

```ts
function read() { /* the read above */ }
read();
const stop = data.tables.notes.subscribe(() => read());

// or, holding a projection keyed by row id:
const stop = data.tables.notes.subscribe((rowIds) => {
	for (const id of rowIds) rebuild(id);
});
```

`data.kv.subscribe` takes a listener with no arguments. KV is one value at a
name-addressed root holding a handful of keys, so naming which one moved would
save a caller a handful of property reads and cost machinery to do it.

## The shape of the data

One `Y.Doc` per application is persisted under the application log name
`app`. Its current top-level roots are the bare named root `kv` and one
`tables:<name>` root for each declared table. This is the physical storage
grammar; it is not a promise that an older or unknown writer could not have
left another root behind. The current model mints no other root kind, so
dumping `doc.share` reads as a description of the application's whole current
state.

```txt
Y.Doc "app"
├── get("kv")
│   ├── <field>        one KV attribute
│   └── ...
├── get("tables:notes")
│   ├── <rowId>        a nested Y.Type: the row
│   │   ├── title      an attribute: a field
│   │   └── folderId
│   └── <rowId>
└── get("tables:folders")
```

**A row is an attribute on its table root, not a root of its own.** That is a
measured decision: `Item.write` calls `findRootTypeKey`, a linear scan of
`doc.share`, so one root per row makes encoding quadratic in rows, at 5,417 ms
for 20,000 rows against 13 ms nested. Deletion takes the row's attribute off the
root, and the whole subtree goes with it.

Row ids are always minted, never chosen. A row is a nested container addressed
by the operation that created it, so two devices creating one chosen id produce
two containers and map LWW discards one **with every field in it**. Anything an
application wants to name by hand goes in `kv`, where independent minting
converges (ADR-0216).

### Rich content

A row's rich content is a nested `Y.Type` on the row, declared like any other
field (ADR-0295, ADR-0296). It is in the same document as the values, so there
is nothing to open, nothing to await, and nothing to dispose:

```ts
const note = data.tables.notes.get(id);
const body = note?.content;                  // the live node, read off the row
const stop = body && data.tables.notes.watch(body, onEdit);
```

`watch` takes the type rather than an address, because a caller holding one has
already done that lookup: rendering the field needs the type anyway.

The node is minted in the transaction that mints its row and never again. That
is what makes it safe: a nested type is addressed by the struct that created it,
so two devices minting one at the same key would lose a subtree, and a minted
row id means only the creating device ever mints one.

A row holds exactly one node, because one file has one region below the fence
(ADR-0299). Every table declares how its node becomes that text and back:

```ts
type ContentCodec = {
  encode: (node: Y.Type) => string;
  decode: (text: string) => Result<Y.Type, ContentError>;
  rewrite: (node: Y.Type, text: string) => Result<void, ContentError>;
};
```

The platform owns the file, writing the values as frontmatter under their own
field names and joining the encoded node beneath the fence, and reversing both.
The table owns what its node MEANS, and there is no default: a node carries a
sequence and attributes at once, so rendering one as text round-trips a keyed
log into one literal string that prints identically. `plainText()` is a codec a
table opts into, not a fallback. Epicenter picks no content format and never
looks inside. A table may omit `content` for fields-only artifacts. Every row
still owns a node; exporting a populated node or importing a nonempty body
without a codec is refused.

## What merges with what

Not uniform, and worth knowing exactly, because it decides how a field should be
shaped.

| Where | Granularity |
| --- | --- |
| two fields of one row | independent, both survive |
| one value field | last write wins, converged |
| one array or object field | last write wins on the WHOLE value |
| the content node | per character |
| any composed index | a cache derived from the CRDT |

A row is an attribute map and a write sets only the attributes handed to it, so
two devices editing different fields of one row offline both keep their edit.
That is also what makes an old release safe to write with: it cannot clobber a
field it does not know.

**An array or object field is one value, and replacing it wholesale is kept on
purpose** (ADR-0228). The alternative is a per-field CRDT type system, and every
entry in it is a second merge semantics an author has to learn and two releases
can disagree about. The price is bounded and nameable: a collection several
devices append to concurrently will lose an addition. The escape hatch needs no
new machinery, because the store already has a per-element merge primitive.
**A collection several devices write independently wants to be a table**, where
each element is its own row, nothing collides, and deletion is a real operation
rather than an array splice that races.

## The data definition

A data definition is one durable data domain's complete declaration: closed JSON
field descriptors, with no storage or lifecycle
(ADR-0213, ADR-0240). It never migrates user data (ADR-0125). A newer release
ships a newer definition and reads the same durable data through it.

The definition's `id` is the data domain's stable reverse-domain identifier.
An application commonly uses its own application identifier for this value when
it owns one default data domain, but the two identities are not required to be
equal. One application may open several data domains, and a data domain may be
opened by several applications or tools.

```ts
import { defineApp, defineTable, field, plainText } from '@epicenter/app';

export const notesDefinition = defineApp({
	id: 'com.example.notes',
	kv: { theme: field.select(['light', 'dark']) },
	tables: {
		notes: defineTable({
			title: field.string(),
			folderId: field.nullable(field.string()),
			createdAt: field.instant(),
			content: plainText(),
		}),
	},
});
```

Each `tables` property name is that table's durable name forever: it is what a
row address carries, what the export names its folder, and what a composed
SQL follower calls its relation. There is no second key to keep in step, and no
rename, because a different property name is a different address and therefore
different data.

Three rules bite immediately:

1. **There are no optional fields.** A field has to be one type through the CRDT
   attribute, the exported frontmatter value, and the row alike.
   `field.nullable(inner)`
   accepts stored JSON `null`, but a missing field remains nonconforming.
2. **Definitions do not own defaults.** Initialization and recovery values live
   in application code. `compileData` rejects a descriptor carrying `default`.
3. **No transforming fields.** Date, instant, and datetime descriptors preserve
   their string representation, so values round-trip through storage and SQL.

### Nonconforming is a view, not damage

A row this release cannot read is reported, never dropped and never silently
repaired. Prevention is impossible in principle, because a declaration is
release-local and rows arrive from the future: a release that has not shipped
yet can retype a field, and no default you declare today prevents that.

What is possible is healing, and the primitives already exist:

```ts
for (const issue of data.tables.notes.nonconforming) {
	issue.id          // the structural row id
	issue.issues      // [{ field: 'n', message: 'n must be a number (was a string)' }]
	issue.conforming  // what survived
	issue.raw         // the stored truth, unmodified
}

data.tables.notes.update(issue.id, { n: 7 }); // an ordinary write repairs it
```

A patch validates only the values it supplies, so it can fix the offending key
even though the whole payload does not currently pass. `stored()` and the
export read the raw values regardless, so a broken row is never invisible;
`nonconforming` is the only thing that knows they failed.

Whether an application shows a person the broken row, has an agent propose a
fix, or ignores it until someone cares is a product decision this layer does not
make. Dropping it silently is the one option the store went out of its way to
prevent.

## Where it stores

The `Y.Doc` is the truth while the client is open; everything else follows it
(ADR-0238). The store keeps the ledger a crash cannot reconstruct: the update
log, with the outbox and cursor read from it, written in the same atomic act
that incurs them (ADR-0241). The document identity used to sit
beside them and is gone with the membership question: the generation is in the
address (ADR-0292). They live behind a
per-store persistence controller: every accepted edit queues its durable work
and one coalesced flush commits the whole queue atomically. Everything
derived from the document (SQL, search, exports) is a follower composed
outside the store.

In the browser the durable facts live directly in IndexedDB, one object store
(`updates`) written one atomic transaction per flush. The SQLite replica port
uses a native synchronous transaction, but its controller follows the same
asynchronous completion path. Reads observe the live edit immediately; await
`persistence.flush()` and check its status to observe the durable outcome.

There is no worker and no OPFS. The reasoning is in the module comment titled
"Why there is no worker" at the top of `packages/app/src/data/store/browser.ts`, and
it is worth reading before proposing one: opening rebuilds every projected
table unconditionally, so a restored file bought nothing, and what actually
has to survive is a handful of small facts that IndexedDB holds fine.

Persistence failing never fails a verb and never poisons the store. The debt
is observable instead:

```ts
data.persistence.get(); // 'saved' | 'pending' | 'blocked'
data.persistence.subscribe(listener);
await data.persistence.flush();
```

`blocked` means the latest flush failed and a restart would lose the retained
work; a later edit or an explicit `flush()` retries. Nothing is lost while
the client stays open: the `Y.Doc` still holds the work. The sender reads the
durable outbox, so a local edit is offered to the authority once it is durable
and a blocked device stops syncing until storage recovers (ADR-0302).

## Sync

A host supplies one thing, `dial`, and the library owns everything done with a
socket (ADR-0222):

```ts
import { createSyncConnection } from '@epicenter/app/sync';

const connection = createSyncConnection({
	store,
	dial: ({ cursor, opened, received, closed }) => { /* make a socket */ },
});
```

The cursor, attach and detach, reconnect on close, reconnect when the client is
stuck behind a gap, and a watchdog for a submission nobody answers all live
here, because every one of them is correctness rather than transport. A fuzz
proved that omitting the resync reconnect wedges a device permanently. The
store announces its own durable local work to the transport internally, so
nothing has to remember to nudge it.

The mounted authority has a stable application/library/data address resolved
from the authenticated principal. It owns the current generation and its opaque
positional log. Historical per-generation addresses are not the current mount;
the historical ledger still prevents silently initializing over old data.
`packages/server/src/store-sync/` is the mount; `@epicenter/app/sync` is where
every merge rule actually lives, so what is deployed and what the transport's
tests drive are the same object.

**Being signed in on two devices is the entire sharing model.** Nothing is
paired, invited, or approved, and there is no identifier a client can supply
that reaches another partition.

## What is not here

The row layer stores opaque blob references as ordinary values. App-local bytes
and explicit account-remote objects have independent lifetimes. Upload is an
explicit operation, not a synchronization queue, and deleting a row does not
delete either byte store.

There is no structural archive, backup coordinator, catalog, or restore-attempt
journal. The current authority still owns initialization, baseline capture,
admission, and activation with durable retry receipts. Its activation mechanism
supports retirement evidence; no restore endpoint is mounted. The Honeycrisp
retirement fixture constructs fresh replacement state independently.

The Markdown `readArtifact` reader remains a separate whole-document API with
package and app test callers. It is not ordinary Push.

The [ADR-0394 folder direction](../../../../docs/adr/0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md)
is document-only: Markdown, settings, and the checkout manifest carry readable
references without copying or fetching local or remote blob payloads. The
[ADR-0395 recovery direction](../../../../docs/adr/0395-restore-is-one-request-that-carries-its-own-safety-copy.md)
uses the current working-copy baseline rather than replacing it with an old
manifest.
