# The store, and what it replaced

What changed between the superseded data stack and the store, and why. Written
for someone about to migrate an application, so it is organised by the DECISION
each change came from rather than by API surface.

The old stack is gone (ADR-0227), so nothing here is a compatibility guide.
It is an explanation of intent.

---

## The one change everything else follows from

**An application has ONE Yjs document, replayed in full before any handle
exists, and the surface over it is synchronous.** Each row owns one nested live
content node at `row.content`; every other field holds an ordinary value.

The old stack was many documents behind a process boundary: a replica owned by a
worker or a desktop host, reached over a message port or HTTP. Every read was a
round trip, so every read was `async`, so every consumer was `async`, so every
consumer needed cache invalidation and race protection.

Once the whole application is one document in memory, none of that is true. A
read is a property access. That single fact deletes more code than any other
decision here, and most of the entries below are consequences of it rather than
independent changes.

---

## Reads

| | old | new |
| --- | --- | --- |
| one row | `await table.get(id)` | `data.tables.notes.get(id)` |
| all rows | `await table.scan()` | `data.tables.notes.rows` |
| unreadable rows | (dropped silently) | `data.tables.notes.nonconforming` |
| ids | (part of scan) | `data.tables.notes.ids()` |
| SQL | a separate inspection surface | a composed follower, and nothing composes one: reading data outside the app is reading the export (ADR-0241, ADR-0268, ADR-0269) |

`rows` and `nonconforming` are two reads over the same table, plainly: a row the
current declaration cannot read is REPORTED, never dropped and never repaired
(ADR-0125), and
nothing in a read can fail, so there is no `Result` to unwrap. A disposed
store throws `StoreUnusableError` instead of dressing up as a read outcome
(ADR-0237); storage falling behind is neither, and reports through
`store.persistence` (ADR-0238).

A point read's one error is the nonconformance diagnostic, plain data with
`conforming` carried so a caller composes its own recovery:

```ts
const { data: noteData, error } = data.tables.notes.get(id);
const note = noteData ?? { ...applicationRecovery, ...error?.conforming };
```

Use `??`, never a destructuring default. An `Err` sets `data` to `null`, and
`= fallback` fires only on `undefined`.

---

## Reactivity, and why `fromTable` is gone

**Old:** a table had `subscribe`, but a subscription only said "something in
this table moved". To know what, you re-scanned. Because scans were async and
could overlap, every consumer grew a generation counter to discard the results
of races:

```ts
let refreshGeneration = 0;
async function refresh() {
  const generation = ++refreshGeneration;
  const { rows } = await honeycrisp.notes.scan();
  if (generation !== refreshGeneration) return;   // a newer refresh won
  ...
}
```

Every mutation had to remember to call `refresh()`, and forgetting was silent.

`packages/svelte-utils`'s `fromTable` existed to hide exactly this. It was a
Svelte adapter that owned the scan, the `whenReady` promise, the `refresh()`,
and the point-reads driven by an invalidation payload. It was good code solving
a problem that no longer exists.

**New:** `db.notes.subscribe(listener)` fires once per commit with the ROW IDS
that commit touched (ADR-0221), for a local write and for bytes that arrived
from another device alike. Text typed inside a row's content node is NOT a
table commit: it has its own signal, `watch(node, listener)`, because routing
it here would wake every list in the application at typing frequency.
It fires after every `onCommitted` listener has run, so a composed follower
(like the SQL projection) is already marked dirty by the time a subscriber
reads through it (ADR-0241).

The whole consumer is now:

```ts
let rows = $state.raw<Note[]>([]);
let unreadable = $state.raw<NonconformingRow[]>([]);

function read() {
  rows = db.notes.rows;
  unreadable = db.notes.nonconforming;   // not dropped
}
read();
const stop = db.notes.subscribe(read);
```

The line people are tempted to skip is the one that matters: discard
`nonconforming` and rows a person wrote are simply missing from the screen
with nothing to explain why. The read used to return a `Result` too, and
`.data?.rows ?? []` turned an operational failure into "you have never
written one of these"; a disposed store now throws `StoreUnusableError`
instead, so that mistake is no longer expressible (ADR-0237).

No generations, no `refresh()` discipline, no adapter. `fromTable` was deleted
rather than ported because the fifteen lines above are the whole of what it did,
and a shared abstraction is worth designing when two applications on the store
want the same one.

`db.kv.subscribe(listener)` is the same idea for settings, with a void listener:
KV is one value at a name-addressed root, so there are no ids to carry.

---

## Writes

**Old:** promises that threw. **New:** synchronous, `Result`-returning.

```ts
const { error } = db.notes.update(id, { title: 'Shopping' });
if (error !== null) …
```

A write reports the write: `update` returns `Result<void, …>` rather than the
row, because a patch may legally land on a row whose OTHER fields this declaration
cannot read (that is how a nonconforming row is repaired), and what the row
now reads as is `get`'s answer. `delete` returns a plain boolean: whether
there was a row to take.

Two behaviour changes worth knowing:

- `patch` became `update`, and **an update to a row that does not exist is a
  failure**. The old verb returned `Ok(undefined)` and silently swallowed the
  write, which was a live bug.
- There is no optimistic cache to patch. The write commits, the subscription
  fires, the read re-runs. A UI that used to patch its own cache to feel fast
  now does nothing, because the write already happened in memory.

---

## Row ids

**Old:** an application could choose a row id (`create(rowId, fields)`).
**New:** ids are minted, always, 24 characters (ADR-0206).

This is a correctness decision, not ergonomics. A row is a record with one
content node, addressed by the operation that created it, so two devices
creating the same chosen id produce two records and map LWW discards one
**with every field in it**. A minted id makes that unreachable.

Consequences you will hit:

- Whispering's recipes had a `sourceId` "portable identity" purely because the
  old store allowed chosen ids. It is deleted; the minted row id IS the identity.
- **Anything an application wants to name goes in `kv`**, which lives at a
  name-addressed root where independent minting converges (ADR-0216).

---

## Settings

**Old:** one row at the chosen id `'settings'`.
**New:** the workspace's `kv` section.

Same reason as above, and it was a live data-loss shape rather than tidiness:
every device writes settings on its own boot path, so two devices both creating
the `'settings'` container lose one of them entirely.

```ts
const result = data.kv.get();       // Result: missing fields are nonconforming
const settings = result.data ?? { ...applicationRecovery, ...result.error?.conforming };
data.kv.update({ theme: 'dark' });  // merges; other keys untouched
```

---

## Nodes and row content

**Old:** rich content was opened through a separate row-document lease and
polled for remote changes.

**New:** `data.tables.notes.get(id)`, `rows`, and `create` return one flat row.
The row's `content` property is its live `Y.Type`, so an editor binds directly
to `row.content`; remote edits arrive through the store's one connection.
Creating a row always mints and persists exactly one content node, even when
the caller omits `content`.

Deleting the row removes that node with the row. There is no second document
address or document lifecycle for an editor to manage.

**Whether rich content belongs in a node at all is a per-application decision.**
Honeycrisp's notes do (a person types them a character at a time, so per-
character merging is the point). Whispering's transcripts do NOT: they are
machine-produced, replaced wholesale, and rendered in a list.

---

## The data definition

**Old:** TypeBox, `defineTable({ fields: { title: field.string() } })`.

**New:** ordinary value field descriptors at the table's top level, one
required `content` codec, pure JSON definitions, and application-owned
recovery values (ADR-0255).

```ts
import { defineData, field, plainText } from '@epicenter/data/definition';

export const definition = defineData({
  id: 'so.epicenter.honeycrisp',
  kv: { theme: field.select(['light', 'dark']) },
  tables: { notes: { title: field.string(), folderId: field.nullable(field.string()), content: plainText() } },
});
```

Three things bite immediately:

1. **There are no optional fields.** A field must be one type through the CRDT
   attribute and the row alike. `field.nullable(inner)` accepts stored null,
   while a missing field is nonconforming.
2. **Definitions do not own defaults.** Initialization and recovery values live
   in application code, and `parseData` rejects declaration defaults.
3. **No transforming fields.** Date, instant, and datetime descriptors preserve
   their string representation, so values round-trip through storage.
   `update(id, { when: row.when })` would break.

Objects have no STRING expression, so `'{ status: ... }'` does not parse and
`'object|null'` validates nothing. Today that means flattening a
`{ status, completedAt, error }` shape into separate fields.

`parseData` is the runtime parser for this closed descriptor vocabulary. It
accepts storage-valid JSON facts and leaves conformance to reads; it does not
apply defaults or transform stored values. Flattening a value into several
fields is an application choice, not a migration requirement.

---

## Sync

**Old:** an HTTP `Exchange`, a `sync-supervisor`, and a connect loop each host
wrote for itself — including the reconnect rules, one of which (reconnect when
the client reports `needsResync`) is a CORRECTNESS requirement that a fuzz
proved wedges a device permanently when omitted.

**New:** the host writes a `dial` and nothing else (ADR-0222).

```ts
createSyncConnection({ store, dial: ({ cursor, opened, received, closed }) => { … } });
```

The library owns the cursor, attach/detach, reconnect on close, reconnect on
`needsResync`, and a watchdog for a submission nobody answers. The store
announces its own durable local work to the transport internally, so
**nothing calls `nudge`**; forgetting to was the same class of silent wedge.

Server side: one Durable Object per (principal, application id),
addressed by a principal resolved from the bearer (ADR-0225). **Being signed in
on two devices is the entire sharing model** — nothing to pair, invite or
approve, and no identifier a client can supply that reaches another partition.

---

## Where the store runs

**Old:** a worker owned the replica and the page was its asynchronous client,
which is why every read in an application on that stack was awaited.

**New:** the store runs in the page, and the durable facts (`updates`,
`outbox`, `tombstones`, `meta`) live directly in IndexedDB, one atomic
transaction per flush (ADR-0238). The page is the only runtime an application
opens (ADR-0269). SQL, when an application wants it, is a follower it composes
over the public surface (ADR-0241).

The measured fact behind it: a page cannot take a synchronous handle to durable
storage. That decides where the LOG lives, not where the store runs: the store
needs a synchronous HANDLE, not synchronous durability, because reads come from
the `Y.Doc` already in memory.

The durability gap is surfaced rather than hidden, on every runtime alike:
`store.persistence` reports `saved`, `pending`, or `blocked`, and a blocked
store keeps serving and accepting. Nothing is lost while the client is open;
what `blocked` puts at risk is only what a RESTART would recover, and a later
edit or `flush()` retries.

---

## The host

**Old:** the desktop host owned a replica, and served applications wrote into it,
which is how Home's tools could read another application's rows.

**New:** a host serves bundles and brokers credentials, and owns no application
data (ADR-0226, widened by ADR-0227). Neither Bun entrypoint constructs a
database at all.

A reader that wants an application's rows becomes a replica of the same
authority that application uses, which is the shape every other reader already
has rather than a privileged local one.

---

## Blobs have independent local and remote lifetimes

Rows store ordinary blob keys or URLs. The blob store does not know which rows
reference them. Keys are minted opaque identities, not content hashes.

`app.blobs.local` saves immutable bytes in the app's device-local namespace.
`app.blobs.remote` exposes explicit account-scoped hosting. Upload creates a
remote object and returns its URL; it does not move or delete the local object.
The application decides whether to store that URL in a row. Row synchronization
never schedules byte transfers, and deleting a row does not delete either object.

Local-only bytes remain on that device. Materialized Markdown preserves their
keys and remote URLs as values, without copying or fetching the bytes. Copying
or zipping that folder does not back up its referenced audio. See ADR-0393,
ADR-0394, and ADR-0395 for references, materialization, and content recovery.

---

## What granularity an edit actually has

Worth knowing exactly, because it decides how a field should be shaped and it
is not uniform. Measured, not assumed.

**A row is not replaced. A field is.** A row is an attribute map and `writeRow`
sets only the attributes handed to it, so two devices editing DIFFERENT fields
of one row offline both keep their edit:

```txt
phone:  update(id, { title: 'phone renamed it' })
laptop: update(id, { pinned: true })
after sync -> title: 'phone renamed it', pinned: true
```

That is the same property that makes an old release safe to write with: it
cannot clobber a field it does not know, because it never touches that
attribute.

**Inside one field there is no merging at all.** Two devices writing the same
field converge on one winner (last write wins by client id), and the other
value is gone. That is correct for a title and it is the whole story for every
value.

**An array or object field is ONE value, so it is replaced wholesale. This is
kept on purpose.** It surprises people, so it is worth being explicit that it is
a refusal rather than an omission:

```txt
phone:  update(id, { tags: ['a', 'from-phone'] })
laptop: update(id, { tags: ['a', 'from-laptop'] })
after sync -> tags: ['a', 'from-phone']      // 'from-laptop' is gone
```

Both devices agree, nothing is corrupt, and one person's addition vanished. A
JSON value in an attribute is atomic; it is not a CRDT list.

**What this buys is the whole model in one sentence: a field is one value.**
The alternative is a per-field CRDT type system — array fields that merge,
counters that add, maps that deep-merge, and a declaration syntax rich enough to
say which. Every one of those is a second merge semantics an author has to learn
and a reader has to hold, and each is a place two releases can disagree about
what a field even is. Refusing all of it means there is exactly one rule for
every value a workspace can declare, whatever its shape, and the rule fits on a line.

The price is bounded and nameable: **a set that several devices append to
concurrently will lose an addition.** That is a real cost and it is paid by a
narrow class of field. The escape hatch needs no new machinery, because the
store already has a per-element merge primitive — rows in a table. A collection
whose elements are written independently wants to BE a table, where each element
is its own row, nothing collides, and deletion is a real operation rather than
an array splice that races.

So the guidance is a question rather than a warning. **Who writes this
collection?** One device at a time, or one place in the UI: an array field is
right. Several devices, concurrently, each adding their own element: it is a
table.

**Per-character merging exists in exactly one place: the row's content node.**
`row.content` is a live `Y.Type`, so two people typing in it merge at the
character. That is the whole reason a node lives there rather than in a
`string` field, and the reason a machine-produced transcript does not need to.

**The projection has different granularity, and it does not matter.** The
composed SQL projection rebuilds whole at the next read (ADR-0241). It is a
cache derived from the CRDT, so it never affects what merges with what.

| where | granularity |
| --- | --- |
| two fields of one row | independent, both survive |
| one value field | last write wins, converged |
| one array or object field | last write wins on the WHOLE value (kept, see above) |
| a row's content node | per character |
| the SQL projection | a composed cache; rebuilt whole at the next read |

---

## How a row evolves

Two devices on two releases hold two declarations over one workspace id, and rows written
by either arrive at the other in any order. There is no migration step to
sequence, no schema version, and no compatibility classifier: ADR-0125 decided
that, and the behaviour below is that decision verified against the store rather
than restated.

**Fields are independent, and that is the load-bearing invariant.** A row is an
attribute map, a write sets only the attributes handed to it, and a read
interprets only the fields the declaration declares. Everything else follows.

| what changed | what the other release sees |
| --- | --- |
| a field was ADDED, with a default | old rows read, the default fills in |
| a field was ADDED, no default | **old rows go `Nonconforming`** |
| a row has a field this declaration never heard of | ignored on read, **preserved on write** |
| a field's TYPE changed | `Nonconforming`, with `conforming` carrying what survived |
| a field was REMOVED | the attribute lingers, unread, costing only `pressure()` |

The third row is the one that makes mixed-version fleets safe, and it is worth
stating as a property rather than a footnote: **an old release updating a row
does not clobber the fields it cannot see.** Verified — a v1 release editing a
`title` left a v2 `tags` array untouched.

The fourth row has an escape hatch that is easy to miss: a nonconforming row is
not a dead row. A patch validates only the values it supplies, so it can repair
the offending key even though the whole payload does not currently pass:

```ts
db.notes.update(id, { n: 7 });   // succeeds; the row conforms afterwards
```

**Order does not matter, by construction.** Because fields are independent and
defaults apply at read time, there is no interleaving of v1 and v2 writes that
produces a state neither can read. That is the whole reason there is no
migration chain to run in sequence.

### Nonconforming is a view, not damage

The instinct on first meeting a `Nonconforming` row is to prevent it: default
every field, require every field at `create`, make the schema watertight.

**That cannot work, and it is worth understanding why before designing around
it.** A declaration is release-local, and rows arrive from the future. A release that
has not shipped yet can retype a field and write it, and your release will not
be able to read the result — no default you declare today prevents that, because
the change is not yours. Verified: a v1 declaration reading a row a v3 declaration wrote is
`Nonconforming`, and nothing in v1 could have avoided it.

So prevention is impossible in principle, and a discipline aimed at it buys a
tax on every author for a guarantee it cannot deliver. What is possible is
HEALING, and the primitives for it already exist.

A failed read is not an absence. It carries everything an app, a person, or an
agent needs to act:

```ts
for (const issue of db.notes.nonconforming) {
  issue.id          // the structural row id
  issue.issues      // [{ field: 'n', message: 'n must be a number (was a string)' }]
  issue.conforming  // { id, title }              what survived
  issue.raw         // { title, n: 'seven' }      the stored truth, unmodified
}
```

`issues` names the field and says what is wrong with it in a sentence, which is
the whole input an agent or a repair screen needs. `raw` is never modified, so
nothing is lost while the row is unreadable. And repair is an ordinary write,
because a patch validates only the values it supplies:

```ts
db.notes.update(issue.id, { n: 7 });
```

A derived index built over the store (ADR-0307) can SHOW nonconforming rows,
because it reads what is stored. It cannot FIND them: an index carries the
declared fields and no conformance marker, and it cannot re-run the
declaration's checks. The typed read is the only thing that knows which rows
failed, so a repair surface identifies them with `nonconforming` and may
then use an index to display or group them.

One thing the projection does NOT promise, worth knowing before building on
it: it is a cache, derived from the CRDT rather than authoritative over it,
and it can always be discarded and rebuilt.

**So the answer here is to add nothing.** No schema version, no migration chain,
no repair API, no alias, no compatibility classifier — ADR-0125 refused all of
those, and the reason it could is that these five primitives (`nonconforming`,
`issues`, `conforming`, `raw`, and a validating patch) already make healing an
ordinary application concern. Whether an app shows a person the broken row, has
an agent propose a fix, or ignores it until someone cares is a product decision
this layer should not make.

What survives is a preference rather than a rule: **adding a field is cheaper
than retyping one**, because adding leaves every existing row readable and
retyping hands them all to a healer.

It is a preference and not a rule because retyping is a legitimate thing to do.
Sometimes a field was simply the wrong type, and living with the wrong one
forever to avoid a heal is the worse trade. Retype it, know that existing rows
go `Nonconforming` until something fixes them, and decide whether anything
needs to. Often nothing does: a row nobody looks at can stay unreadable
indefinitely without hurting anyone, and `raw` still holds it.

---

## A migration checklist

1. Rewrite the workspace: arktype strings, nullable-with-default, no optionals, no
   objects, defaults inline. Settings to `kv`.
2. Decide whether the value belongs in the row's `content` node or in an ordinary
   value field.
3. Replace `openEpicenter` with `openLocal(workspace)` (and `openAccount(workspace,
   { principalId })` for a signed-in replica, per ADR-0233).
4. Replace `scan` + `refresh` + generations with `read()` + `subscribe(read)`.
5. Drop `await` from every read and every mutation; destructure `{ data, error }`.
6. Delete chosen-id machinery; move anything that needed a stable name to `kv`.
7. Bind editors to the flat row's `content` node. Do not create a second row
   document or content address.
8. Add a `dial` if the application syncs, and delete every `nudge`.
9. Decide what the application does with `rows().nonconforming`. Showing it,
   healing it, and ignoring it are all legitimate; dropping it silently is the
   one option the store went out of its way to prevent.
