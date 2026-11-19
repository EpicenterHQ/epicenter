# 0213. A lens is arktype JSON, and an application queries only its own projection

- **Status:** Accepted
- **Date:** 2026-08-07
- **Amended by:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md)
  at the noun only: the artifact is a workspace declaration
  (`defineWorkspace`, `parseWorkspace`, `workspace.json`). Everything decided
  here about the declaration itself stands verbatim.
  digest for a cell store that no longer exists. That draft was `Proposed` and is
  rewritten in place.
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md)
  (the store), [ADR-0214](0214-one-sqlite-file-holds-the-update-log-and-the-projection-and-history-lives-outside-the-crdt.md)
  (where the projection lives).
- **Amends:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md)
  at one clause. Withdrawn: that application-facing APIs "expose no `sql()`
  method". An application may run read-only SQL over **its own** projection. What
  survives is everything else: no raw connection, no cross-namespace reach, and
  Epicenter Home keeps relational inspection across applications as a trusted
  host capability. The reason the clause can go is ADR-0214's one-file-per-app
  layout: an application's file is the boundary, so the refusal no longer buys
  isolation that the filesystem does not already give.
- **Amended by:** [ADR-0216](0216-a-name-addressed-location-is-the-only-safe-place-for-a-write-two-devices-both-make.md)
  at two verbs and one claim. Withdrawn: `ensure(id, fields)`, the chosen-id door
  `create(rowId, fields)`, and "a singleton is a row whose id you chose". A row
  is created at a minted id, always, and a lens declares a `kv` section for what
  it keeps one of. Also
  ADR-0215,
  which makes the surface synchronous and turns `document.open` into
  `document(id)`.
- **Confirms:** [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md) and
  [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md). Neither is
  amended. An earlier reading held that ADR-0125 forbade validation; it does not,
  and the misreading is corrected below.

## Context

A lens has three jobs and only three: give an application types, tell the
projection what columns to build, and tell the folder which field is the body. It
has never had the job of gating what may be stored, because ADR-0125 requires a
release to preserve values it cannot read.

The earlier lens implementation carried two bugs that both come from treating the
schema as something to *build* rather than something to *be*:

- `compiledTables` is a `WeakMap` keyed on object identity
<!-- doc-path-check: ignore-next-line (names a file the superseded stack carried; ADR-0227 deleted it) -->
  (`packages/lens/src/definitions.ts:187-188`), and compilation throws
  `'Unknown table definition'` for anything it did not itself mint (`:331-333`).
  A lens loaded from disk is therefore uncompilable, which contradicts
  ADR-0168:86 outright.
- `optional` never survives serialization: `cloneSchema` runs a JSON round trip
  at `:226` and the optionality marker is read off the pre-clone schema into a
  side `Set` at `:233`. A serialized lens reports every optional field as
  required.

Both disappear if the lens *is* the JSON rather than being compiled into it.

## Decision

### A lens is arktype syntax, and arktype syntax is JSON

```ts
export const lens = defineLens({
  namespace: 'so.epicenter.honeycrisp',
  tables: {
    notes: { title: 'string', tags: 'string[]', date: 'string|null' },
    // A singleton is a row whose id you chose. Not a second kind of thing.
    settings: { theme: "'light'|'dark'", fontSize: 'number' },
  },
});
```

That object serializes to `{"title":"string","tags":"string[]","date":"string|null"}`
and round-trips byte-identically. A hand-written `lens.json` and a TypeScript
lens are the same artifact. arktype is already a catalog dependency across the
repo.

**There is no `kv` section.** ADR-0206 (`Accepted`, commit `d5e53cca24`,
+1303/-6422 across 130 files) already deleted singleton values after measuring
that exactly one was declared across every shipped lens in the repository. A
draft of this record reintroduced the concept three days later; that is
withdrawn. A singleton is a row at a chosen id, which gets a real SQL relation
and a real `settings/app.md` for free, where a reserved root gets neither and
costs a second read shape, a second write verb and a collision rule. One verb
serves it: `ensure(id, fields)`, get-or-create in one transaction, which replaces
the two-await dance ADR-0206 itself writes and that two shipped apps reimplement.

`defineLens` is inference and validation, not construction:

```ts
export function defineLens<const L>(lens: L & ValidateLens<L>): L { return lens as L }
```

The intersection is load-bearing: `L` infers from the literal, and
`ValidateLens<L>` applies `type.validate` per field. Verified by typechecking a
mock. Correct usage compiles with zero errors and infers `title: string`,
`tags: string[]`, `date: string | null`, `theme: 'light' | 'dark'`. Four
deliberate mistakes are all caught: a non-keyword (`'strng'`), reading a field at
the wrong type, treating a content field as a string, and a malformed union.
Autocomplete inside the quotes comes from arktype's own `type.validate`, which is
exported; nothing about its type-level machinery is reimplemented.

### A field may declare a default, in the string

```ts
settings: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' }
```

arktype expresses a default inside the expression, so the lens is still JSON and
introspection reads it back (`prop theme: default="light"`). It is not a
migration and not backfill, which ADR-0125 refuses: nothing is written, the value
is supplied at read time when the key is absent.

**A default fills an absent key. It does not rescue a present but invalid one.**
Measured: `{}` yields `light`, and `{ theme: 'purple' }` is still an error.

There is **one** read verb. Recovery is composed at the call site out of two
pieces of data, because a second verb would only be a fixed composition of them:

```ts
const { data, error } = await db.settings.get('app');

const cfg = data ?? db.settings.defaults;
const cfg = { ...db.settings.defaults, ...(data ?? error.conforming) };
```

`defaults` is the table's declared defaults, which arktype yields directly by
validating an empty object. `conforming` is the subset of a nonconforming row's
fields that did pass, carried on the error so a partial failure does not cost the
fields that were fine. That per-field case is the one that matters in practice:
it is what happens when a release narrows a field and one stored value no longer
validates, which is the situation ADR-0125 exists for.

**Use `??`, never a destructuring default.** `Err` sets `data: null`
(`wellcrafted/dist/result`), and a destructuring default fires only on
`undefined`, so `const { data: cfg = defaults }` silently yields `null` on
failure. `??` fires on both.

A draft of this record added a `getOrDefault` verb. It is withdrawn: it is
`{ ...defaults, ...(data ?? error.conforming) }` with the composition frozen, and
freezing it hides which of the two behaviours a call site wanted.

With defaults declared, an unwritten key simply reads as its default:
`db.kv.get()` on a fresh store already returns every declared value. The verb an
earlier draft invented for this, `ensure(id, fields)`, is withdrawn along with
the singleton-as-row model it served (ADR-0216).

### A field is one type through every door

A field's arktype expression may not transform its value. `'string.date.iso'`
is admitted and `'string.date.parse'` is refused, with
`Err(LensParseError.TransformingField)` naming the field and the fix.

A field is reachable through three doors, and they have to agree: the Yjs
attribute, the projection column, and the row a read hands back. A morph breaks
that. `'string.date.parse'` takes a string on write and yields a `Date` on read,
so `update(id, { when: row.when })` cannot round-trip, and `db.query` reports a
string for the same field the row reports as a `Date`. One field, two types,
depending on how it was reached.

**Nothing expressive is lost, which is why the refusal is cheap.** arktype ships
a validation-only form of every rich string type, and each keeps the stored
value: `string.date.iso`, `string.uuid`, `string.email`, `string.numeric` all
pass unchanged. The cost is `new Date(row.when)` at the point of display. It is
also the rule this codebase already chose, back when the vocabulary was
`InstantString`, `CalendarDateString` and `DateTimeString`: a date is a branded
string, never a `Date`. The gate enforces that existing decision with one rule
instead of a bespoke `recognize()` vocabulary.

**The check asks the property's value, not the property.** Filling an absent key
is itself a transformation in arktype's terms, so the wrapper reports
`includesTransform: true` for every defaulted field. Measured:

| expression | wrapper | value |
| --- | --- | --- |
| `"'light'\|'dark' = 'light'"` | `true` | **`false`** |
| `'string.date.parse'` | `true` | `true` |
| `"string.date.parse = '2020-01-01'"` | `true` | `true` |

Asking the wrapper would ban every default, which is the mechanism the section
above is built on.

### Fields are nullable, never optional

`'string|null'`, not `'date?'`. Every field is always present, so the projection
is one column per field with no exceptions and no marker to lose. The frontmatter
renderer omits nulls, which is a rendering rule rather than a schema fact.

This collapses "cleared" and "never set" into one state. That distinction is
deliberately given up.

### The lens says nothing about prose

Every row inherently owns a document (ADR-0212, adopting ADR-0130), so there is
no field to mark, no sentinel, and no prose-versus-scalar split in the field
types. Two drafts of this record carried one, first `content` as a `unique
symbol` and then `TEXT = '!text'`; both are withdrawn.

The symbol was also a bug worth recording, because the same mistake is easy to
repeat: `JSON.stringify({ body: Symbol() })` is `{}`, so a symbol-valued key
vanishes and a lens declaring prose did not round-trip byte-identically, which is
this record's central claim.

Every field a lens declares is an arktype expression, with no exceptions.

### Validation happens three times and never gates storage

The reading that ADR-0125 forbids validation is wrong. ADR-0125:33, verbatim:
*"A release validates values it understands and preserves everything else. Typed
patches modify only explicit keys, validate only supplied values, and may modify
a row whose complete payload does not pass the current lens."* Per-supplied-value
validation is mandated. What is forbidden is whole-row admission gating,
aliases, `fallbackFrom`, automatic rename, schema versions, migration chains, and
default backfill. ADR-0168:84-86 blesses compiling validators at bind time.

| | checks | on failure |
| --- | --- | --- |
| **legitimacy** | the lens JSON is well formed and every field is recognized vocabulary | `Err(LensParseError)`; the lens is a visible broken artifact |
| **write** | each **supplied** value against its field | `Err(NonconformingWrite)`; refuse the call, touch no other field |
| **read** | the **stored** payload against the current lens | `Err(NonconformingRow)` carrying the raw payload unmodified; report, never repair |

Validator compilation is memoised on the content hash of the canonical JSON, not
on object identity.

### The application surface

**You never hold a row. You hold a table.**

```ts
const { data: store } = await openBunStore({ directory });   // the open file
const { data: db } = store.bind(lens);                       // the typed view

const { data: note } = db.notes.create({ title: 'Groceries', tags: ['food'] });
note.title                                   // a property on a FROZEN plain object
db.notes.update(note.id, { title: 'Shopping' });
db.notes.delete(note.id);

// what this application keeps one of. Not a row (ADR-0216).
const { data: settings, error } = db.kv.get();
const applied = settings ?? { ...db.kv.defaults, ...error?.conforming };
db.kv.update({ theme: 'dark' });

// the document. The lens never mentioned it; every row has one (ADR-0130).
db.notes.document(note.id)?.get('editor', 'text');

const rows = db.query`
  SELECT id, title FROM notes
  WHERE EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ${'food'})`;
```

**Nothing here is awaited except opening the file.** An application is one
in-memory document (ADR-0215) over a synchronous SQLite boundary, so there is no
I/O for a verb to wait on. An earlier draft awaited every verb to keep one shape
across runtimes; the runtime that would have needed it, the browser, is deferred
(ADR-0214), so that was ceremony paid to something out of scope.

**A read returns a frozen plain object with no methods.** That matters because on
a live handle `note.title === undefined` means three things at once: the field is
null, the row was tombstoned by a peer, or the value fails the current lens
(ADR-0125). A property getter is the one syntax in JavaScript that can report
none of them. On a snapshot returned by an awaited verb, the validation already
happened, so the property cannot lie. It also survives a template, a `sort`
comparator, `structuredClone` and `postMessage`, which a `Result` per field does
not.

**Every verb is on the table and takes the id.** Presence and the write then
happen in one Yjs transaction, which a handle cannot guarantee: `Doc.get` mints,
so a write through a stale handle would leave a row with fields and no
`!presence`. A row has no methods, so no field name is reserved except `id`, and
field names come from users. Jazz shipped methods on the row, hit exactly this,
and moved everything under `$jazz` in 0.18.0.

**`document.open(id)` is asynchronous and disposable**, which is ADR-0130's own
shape. Opening is a load, and a round trip to another process on two of three
shipped surfaces. A document is opened, never assigned, so it cannot be replaced
behind an editor that still holds one.

**`bind` is synchronous and returns a `Result`.** Synchronous because it does no
I/O. Result-returning because a lens may arrive as data from an installed app
folder, and `compileTableDefinition` throws for exactly that case today
(`definitions.ts:331-333`).

**Two names, and each says what it is.** A `store` is the open file; a `db` is
the typed view of it through one lens. An earlier draft called the bound value
`notes`, which collided with a table also called `notes`. And there is no
`epicenter.open({ path })`: three adapters already exist whose I/O has nothing in
common, Bun's being one `mkdir`, the browser's a Web Lock plus a WASM compile
plus an OPFS pool, and desktop's two round trips that never open a file. Naming
the opener for Epicenter while calling its result a store was a second name for
one thing, which ADR-0204 refuses.

`query` lives on the binding, not the store, so an application reaches only its
own namespace. Results are bounded and Result-returning; bare rows cannot say
"this was clipped".

### Names

| instead of | use | because |
| --- | --- | --- |
| `columns` | `fields` | 13% of the real vault's notes carry `subtitle`. That is a normal field and a bad column. The projection has columns; the store has fields |
| `field.string()` | `'string'` | a builder returns this same JSON, and adds a compile step plus an identity-keyed cache, which is where both existing bugs came from |
| `optional: [...]` | `'string|null'` | a marker in the key does not survive a JSON round trip; a union in the value does |
| `epicenter.open({ path })` | one adapter per runtime, each returning a `Result` | ADR-0204 says a thing has exactly one name, and the three opens share no I/O profile |
| `const app = ...` | name it for the lens | `app` already means an installed application with an authority id and a partition |
| `note.title = 'x'`, then `note.set({...})` | `notes.update(id, {...})` | assignment cannot fail or be awaited; and a handle carrying only an id does not prove the row still exists, so presence and the write must share one transaction |
| `notes.set(id, {...})` | `notes.update(id, {...})` | only the fields handed in are touched, so `set`, which promises replacement, is wrong about the verb called most often. An earlier draft of this table swapped `patch` for `set` on the assignment-versus-method argument and never examined merge versus replace |
| `note.body.insert(0, 'x')` | `await notes.prose(id, 'body')` then `.text().insert(...)` | it is a load, and a round trip on two of three shipped surfaces. A synchronous chain in front of it gives back the whole startup win |
| `body: content`, then `body: TEXT` | **nothing.** the lens says no word about prose | ADR-0130 (`Accepted`): a row owns a document inherently and "the table does not opt in, declare roots, or choose a format". Deletes the sentinel and the prose/scalar type split |
| `notes.prose(id, field)` | `notes.document.open(id)` | ADR-0130's own shape. `document` is what it is; `prose` invented a second name |
| `const { data: notes } = store.bind(lens)` | `const { data: db } = ...` | the bound value collided with a table named `notes` |
| `openBunEpicenter` returning `store` | `openBunStore` returning `store` | one thing, one name (ADR-0204) |
| `kv: { ... }` | a table with a chosen row id, plus `ensure()` | ADR-0206 already deleted the concept after measuring one declared value repo-wide |
| `bind(lens): Bound` | `Result<Bound, LensError>` | a lens loaded from disk is uncompilable today (`definitions.ts:331-333`) |

`query` is reserved as a table name, because a table becomes a key on the same
handle that carries the method.

## Consequences

- **A lens on disk and a lens in TypeScript are the same bytes**, so an
  application can ship one, an agent can read one, and neither needs a compiler.
- **Introspection is free.** arktype exposes `.props`, `.expression` and `.json`,
  which is enough to render a form or a table header with no extra metadata:
  measured, `date optional=false string | null`, `tags optional=false string[]`.
  Error messages are already legible: *"tags must be an array (was string)"*.
- **A nonconforming row is returned, never repaired and never hidden.** The
  property getter for the offending field yields `undefined`, `read()` returns
  the error, and the raw payload including uninterpretable keys stays intact.
- **`values` has no slot and no verbs.** ADR-0206 deleted the concept, the
  relations, the wire operations and the dotted grammar. A draft of this record
  claimed the slot survived in the canonical JSON; it does not, and
<!-- doc-path-check: ignore-next-line (names a file the superseded stack carried; ADR-0227 deleted it) -->
  `packages/lens/src/definitions.ts:85-99` has neither a values nor a kv slot.
- **Epicenter Home keeps cross-application SQL** and it stays a host capability
  reached through the storage owner, not a connection handed to anyone.
