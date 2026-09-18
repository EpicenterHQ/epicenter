# 0296. Rich content is a declared field and a table owns its file codec

- **Status:** Superseded by [ADR-0299](0299-a-row-is-its-scalars-and-one-content-node.md) at the codec's signature and at how rich content is declared. Its file layout stands: one `<table>/<rowId>.md` per row, scalars as frontmatter, codec output as the body, `kv.json` beside them.
- **Date:** 2026-08-29
- **Supersedes:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at the codec's signature and placement. Its content rules are retained: one `<table>/<rowId>.md` per row, scalars as frontmatter, codec output as the body, `kv.json` beside them.
- **Amends:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md) by naming how a rich field is declared and serialized.
- **Relates:** [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md), [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md), [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md)
- **Unbuilt:** the "must declare `file`" rule is enforced at `defineTable`'s
  parameter type and again at `defineData`, which is the authoring boundary. It
  is deliberately NOT enforced in `parseData`: that same function reads an app
  bundle's `database.json`, and JSON cannot carry a function, so a codec's
  absence there says nothing. What a missing codec costs is paid at the
  artifact boundary, where an uncoded body is a refusal in both directions.

## Context

Once a row's rich content lives in the row (ADR-0295), the separate `document`
declaration block has nothing left to point at. It existed because the body was
a different Yjs document with its own address, handle, and lifecycle.

Yjs 14 removed the type classes. There is no `Y.XmlFragment`, `Y.Text`, or
`Y.Map`: one `YType` is simultaneously map, list, and rich text
(`@y/y@14.0.0-rc.24`, `ytype.js:681`), and `Doc.get(key, name)`'s second
argument is an optional node name rather than a constructor. So "prose" is a
fact about a codec and an editor binding, not about storage, and a field
declaration that names a concrete rich-text class would be inventing a
distinction the engine no longer makes.

Separately, the artifact needs an owner for two different problems. Frontmatter
is fully described by the declaration and the platform can guarantee its
round-trip. The body is not: the same `Y.Type` becomes different Markdown under
different ProseMirror schemas, and a folder written by another tool carries
frontmatter that only the application knows how to coerce.

## Decision

**A rich field is declared like any other field, and the table declares one
codec for its file.**

```ts
notes: defineTable({
  fields: {
    title:  field.string(),
    pinned: field.boolean(),
    body:   field.type(),
    agenda: field.type(),
  },
  file: { serialize, deserialize },
})
```

`field.type()` declares that the attribute holds a nested `Y.Type`. It surfaces
in `RowOf<T>` as `Y.Type` where a scalar field surfaces as its JSON type. There
is no reserved key, no `document` block, and no limit on how many a table
declares.

**The platform owns the file format; the table owns the mapping.** The platform
splits the fence, parses the frontmatter into a record, and joins it back. The
codec maps that record and the body text to and from a row:

```ts
type RowFile = {
  data:    Record<string, JsonValue>   // frontmatter, parsed
  content: string                      // everything below the fence
}

file: {
  serialize: (row: Row) => RowFile

  deserialize: (
    file:  RowFile,
    types: { body: Y.Type; agenda: Y.Type },   // minted, attached, empty
  ) => Result<{ title: string; pinned: boolean }, RowFileError>
}
```

**Scalars are returned; rich fields are filled in place.** ~~The asymmetry is
forced by the engine, not by taste.~~ **AMENDED 2026-08-30: this is wrong. See
the amendment below.** The original reasoning was: a detached `Y.Type`
accumulates its edits in a single prelim delta replayed at `_integrate`
(`ytype.js:922-928`), and a delta is positional, so measured on `14.0.0-rc.24`
one operation survives and more than one does not.

**The platform validates what `deserialize` returns against the declaration**
before writing it. The codec decides how to read a file; the declaration still
decides what a row is, and a returned value of the wrong type is reported through
the existing nonconforming machinery.

**A table that declares any `field.type()` must declare `file`.** A table with no
rich field may omit it and exports its scalars as frontmatter with an empty body.

**The codec must be idempotent after the first pass.**
`serialize(deserialize(x)) === x` for anything the codec itself produced. Losses
on foreign Markdown are accepted (ADR-0268); losses on the codec's own output
are not, because every generation is born from an import and a lossy round trip
degrades a database each time it is minted.

## Amendment, 2026-08-30: the codec is an inverse pair

`deserialize` takes a file and returns a whole row, rich fields included and
already built. `create` integrates them in the transaction that mints the row.
The signature this record told the reader not to simplify is simplified.

**The mechanism this record named is real; the conclusion drawn from it was too
broad.** Re-measured on the same `@y/y@14.0.0-rc.24`, and pinned in
<!-- doc-path-check: ignore-next-line (a file this superseded record described, since deleted) -->
`packages/app/evidence/data/detached-rich-field.test.ts`:

| This record claimed | Re-measured |
| --- | --- |
| `push` twice returns silently reordered content | **Correct.** A loop of appends comes back reversed, and does not throw |
| `insert(0, ['hello ']); insert(6, ['world'])` throws detached | Reproduces, **and throws attached too**, so it never argued for either design |
| therefore a codec must be handed an attached type | Too broad. It rules out a loop of positional appends, not building a type |

A delta is positional, so a sequence of independent positional writes on a
detached type is each computed against an empty state and they all land at
index 0. That is exactly the `push` finding and it stands. What it does not
rule out is **one bulk operation**, which is what `@y/prosemirror`'s
`pmToFragment` produces, or **attribute writes**, which is how a map-shaped
codec like `packages/chat` fills a message log. A 16 KB note with a heading,
task lists, an ordered list, a blockquote and inline marks, built detached by
`pmToFragment` and integrated, serialises byte-identically to one built
attached; a peer receiving either sees the same thing, from an encoded update
of the same size to the byte (28,913 B).

**The two constraints that replace the old rule**, both on `richField()`:

1. Fill it in one operation, or in attribute writes. A loop of `push` reverses,
   silently.
2. Do not read it before handing it over. Content lives in the prelim delta, so
   a read returns nothing and logs `Invalid access: Add Yjs type to a document
   before reading data`.

The trade is honest rather than free: the old signature made rule 1
unrepresentable, and this one makes it a documented, tested constraint on
whoever writes a codec. It buys an inverse pair, one write per imported row
instead of three, and a `create` that takes what `deserialize` returns.

**A new hazard the inversion creates, and its refusal.** A type handed to
`create` must not already belong to a document. Measured: setting one type at
two keys leaves both keys holding the SAME type, so two rows would share one
body and an edit to either would appear in both, silently; setting one into two
documents corrupts across them. `createRow` refuses a type whose `doc` is
non-null, which makes both unrepresentable rather than subtle.

**Concurrency is unchanged.** ADR-0295's argument is about LAZY minting, where
two devices mint at the same attribute key on first use. A pre-built type is
still integrated exactly once, in the one transaction that mints a row whose id
was minted, so no two devices ever address the same nested container.

**What this deletes.** `deserialize`'s `types` parameter; `TypesOf` as codec
vocabulary; `readRowTypes` in the import path; `ImportError.RowReturnedType`,
which inverted from an error into the requirement; `CreateInputOf` and
`CreateInputsOf`, replaced by `NewRowOf` and `NewRowsOf`; and the three writes
and a read-back that `admitRow` needed to hand the codec an attached type,
which is now one `createRow` in one transaction.

**`richField()` exists so this did not cost a dependency edge.** A codec must
now construct a type, and `packages/chat` deliberately names rich fields
through the store's vocabulary without importing `@y/y`. The store exports the
constructor beside the type alias, for the same reason the alias exists.

## Second amendment, 2026-08-30: a table declares scalars and types

`field.type()` is deleted. A table declares two buckets:

```ts
notes: defineTable({
	scalars: { folderId, title, pinned, createdAt, updatedAt, deletedAt },
	types: ['body'],
	file: noteFile,
})
```

**The descriptor described nothing.** `field.type()` returned
`Type.Unsafe<Y.Type>({ 'x-yjs-type': true })`: no schema, no check, no
nullability, no format. Every other field descriptor says something about its
value; this one said "I am not that kind of thing." What the marker smuggled
through a bag of schemas was a LIST OF NAMES, and that list is what the runtime
has always held as `ParsedTable.types`. Declaring the list directly makes the
smuggling unnecessary, so `TYjsType` and `YJS_TYPE_KEYWORD` go with it and the
keyword leaves the JSON Schema entirely.

**Why two buckets rather than one bag.** The two kinds are apart in every
operation this record and its amendment describe: `update` takes only scalars
because a type is not assignable, `watch` takes only types, `create` requires
the first and mints the second, and a table with any type field must declare a
codec. They were together in exactly two places, the declaration and the read,
and the declaration was the one encoding the distinction in a marker for the
type system to rediscover.

The read still joins them. `get(id)` returns `{ id, title, …, body }`, one row.
Declaration and read answer different questions: *what kinds of storage does
this table have* wants them apart, *what is this note* wants them together.

**What the type level loses, across this amendment and the one before it:**

| | why it existed | now |
| --- | --- | --- |
| `RichKeys` | compute the key union `Omit` subtracts | deleted |
| `IsType` | ask whether a value's `Static` is a `Y.Type` | deleted |
| `ScalarsOf<T>` | `FieldsOut<Omit<T, RichKeys<T>>>` | `FieldsOut<T['scalars']>` |
| `TypesOf<T>` | map over a computed union | `{ [K in T['types'][number]]: Y.Type }` |
| `RowOf<T>` | `{ id } & FieldsOut<T>` | `{ id } & ScalarsOf<T> & TypesOf<T>` |

No filtering anywhere, and `defineTable`'s codec rule reads as its meaning:
`[TTypes[number]] extends [never] ? { file? } : { file }`.

**Two refusals that were not previously expressible**, both now tested: a name
declared as both a scalar and a type field, and a name declared twice in
`types`. When the bag was the declaration, neither was a shape you could write.

**The vocabulary settled here too.** These were "rich fields", ninety-six
times, against fifty-one where the code immediately glossed the term as "a
nested `Y.Type`" — a name that needs its explanation attached that often is not
the name. "Rich" also carried the prose connotation this record's own
`field.type()` comment spent a paragraph refusing, and `packages/chat` keeps a
message MAP in one. They are type fields, after the bucket that declares them.
"Nested" survives where position is the point (root types converge by name and
nested ones do not; a nested edit bubbles to the table root) and "live" where
reference-versus-value is the point.

This record's title still says "rich content". Titles are dated and every
cross-reference uses this filename; the vocabulary moved, the record's name did
not.

## Consequences

- The `document: { derive, file }` block is deleted, and with it `derive`,
  `DocumentDeclaration`, `DocumentReader`, and the parse rule refusing a document
  without a file codec.
- A row may carry any number of rich fields, and the artifact layout does not
  branch: the table's codec composes them into one body and parses them back.
- `deserialize` runs once per row for every database that will ever exist, since
  import is the only way a generation comes into being. It is rare in frequency
  and absolute in role, which is an argument for testing it directly.
- A folder written by another tool can be imported, because the codec sees the
  parsed frontmatter and can coerce it. Under the previous rule those files were
  simply nonconforming.
- The platform can no longer guarantee frontmatter round-trip by construction; it
  guarantees instead that a mismatch is reported. A codec that drops a declared
  field is visible rather than silent.
- `field.type()` says what is true of storage and nothing more. An application
  that wants prose, an outline, or a table gets the same declaration and differs
  only in its codec and its editor binding.

## Considered alternatives

- **`field.prose({ file })`, one per table, platform composes the body.**
  Refused. It names a use Yjs 14 does not distinguish, and it forces a refusal
  (one rich field per table) that moving the codec to the table does not need.
- **A reserved `!document` or `content` slot.** Refused. It makes rich content
  categorically special at the moment the engine stopped treating it that way,
  and it burns a field name or reintroduces a reserved namespace with no other
  member.
- **The codec owns the whole file, including YAML.** Refused. Every application
  would reimplement frontmatter parsing and the platform could no longer tell a
  malformed file from an application-specific one, which matters more here than
  usual because import is the birth path.
- **`deserialize` constructs and returns the `Y.Type`s.** Refused on
  measurement, not principle; see the prelim-delta finding above.
- **`deserialize` returns engine-free deltas for the store to apply.** Refused
  for ergonomics. It is the purest shape and it depends on the ProseMirror
  binding being able to emit a delta with no target type, which is unverified.
