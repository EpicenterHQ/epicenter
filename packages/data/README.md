# @epicenter/data

Portable scalar convergence protocol and SQLite-backed local replica for
Epicenter data.

## Physical storage is not the merge boundary

Each table row is stored as one JSON payload in SQLite:

```txt
state row
└── json_payload TEXT
    └── { "title": "Draft", "status": "open" }
```

That does not make the complete row the logical conflict unit. `update` lowers
the supplied top-level fields into a patch:

```txt
update(id, { title: "Final" })
              |
              v
{ set: { title: "Final" }, unset: [] }
```

The authority accepts changes in one sequence and applies each patch to its
current row. Patches to different top-level fields compose:

```txt
accepted #41: { title: "Final" }
accepted #42: { status: "closed" }

result: { title: "Final", status: "closed" }
```

Two assignments to the same top-level field do not compose. The later accepted
assignment wins. This is server-ordered, per-field last-accepted-wins, not
timestamp last-write-wins.

## Choose the replacement boundary

The schema already provides four useful choices. Keep the boundary as small as
possible while still preserving the intent of one operation.

```txt
Need a collection?
|
+-- Independent bounded properties should compose
|   `-- defineTable with ordinary top-level fields
|
+-- One bounded object should replace coherently
|   `-- defineTable with one value: field.json(schema) field
|
+-- One singleton should replace coherently
|   `-- defineValue with field.json(schema)
|
`-- Independent edits inside the value must survive
    `-- the row-owned Yjs document
```

Use ordinary top-level fields by default:

```ts
const tasks = defineTable({
	key: 'com.example.tasks',
	fields: {
		title: field.string(),
		status: field.string(),
	},
});
```

This lets title and status patches compose. Table traversal is complete and
classified; applications sort or filter the returned rows locally.

## Read complete tables

Use `scan()` when the classified traversal belongs in memory:

```ts
const { rows, nonconforming } = await tasks.scan();
```

Use `entries()` when work can proceed one classified row at a time:

```ts
for await (const entry of tasks.entries()) {
	if (entry.error !== null) {
		report(entry.error);
		continue;
	}
	await exportTask(entry.data);
}
```

Both traverse live rows in stable row ID order. `entries()` fetches bounded
batches internally, so callers can stop early or keep memory bounded without
constructing cursors. `scan()` consumes that traversal to completion and groups
the same `Result` values. Traversal observes live state, not a snapshot.
Per-row Lens projection failures use those `Result` values. Storage or transport
failures throw from iteration or reject `scan()` instead.

Use one JSON field when the complete bounded object is the honest replacement
unit:

```ts
const profilesDefinition = defineTable({
	key: 'com.example.profiles',
	fields: {
		value: field.json(ProfileSchema),
	},
});

const profiles = epicenter.bind({
	tables: { profiles: profilesDefinition },
	values: {},
}).tables.profiles;

await profiles.update(id, { value: nextProfile });
```

The row ID remains structural. The `value` assignment replaces the complete
nested object:

```txt
row
|-- id                  structural identity
`-- value               one replacement boundary
    |-- name
    |-- status
    `-- preferences
```

This pattern is useful for a coherent state machine outcome, a bounded config
object, or another value whose inner properties should never merge
independently. It has one important cost:

A small inner edit sends the complete `value` in the local change. Atomic JSON
is almost free in steady-state storage, but its edit cost is proportional to
the whole payload.

For one named singleton, use `defineValue` instead of inventing a one-row
table:

```ts
const shortcut = defineValue({
	key: 'com.example.settings.shortcut',
	value: field.json(ShortcutSchema),
});
```

Use the row-owned Yjs document only when replacement would erase independent
interior edits. Collaborative prose is the usual example. A document earns its
CRDT metadata, hydration, and separate query limitations by preserving edits
that scalar replacement cannot.

Large immutable bytes are a different concern. Keep them in a blob or file
plane rather than turning a scalar JSON value into an opaque byte container.

## Unions are not migrations

A discriminated union inside one JSON field keeps the discriminant and its
associated properties in the same replacement boundary:

```ts
const Outcome = Type.Union([
	Type.Object({ kind: Type.Literal('pending') }),
	Type.Object({
		kind: Type.Literal('complete'),
		text: Type.String(),
	}),
]);

const jobs = defineTable({
	key: 'com.example.jobs',
	fields: { outcome: field.json(Outcome) },
});
```

Use a union when every variant remains a legitimate current product state.
Every reader must handle every variant, and an older release may write an older
variant again.

A historical representation is different. Keep it out of the current row type
and repair it explicitly:

```txt
current definition rejects old raw value
                 |
                 v
one application repair recognizes the old schema
                 |
                 v
an ordinary idempotent update writes the current value
```

Reads remain pure. Repair belongs in one explicit application-owned pass or
registry, not in feature reads and not in the Lens. Keep the recognizer
rerunnable while a supported writer may reintroduce the old shape. Delete it
only after the application has ended that writer compatibility and separately
established that the old shape cannot reappear; live traversal alone does not
prove absence. This keeps repair history bounded without pretending every
repair needs a permanent `.migrate()` chain.

## Self-description and UI

`field.json(schema)` retains its inner JSON Schema. A generic viewer can inspect
the object, render supported properties or discriminated variants, and fall
back to raw JSON without executing application code.

The editing UX must also tell the truth about the write boundary. A form for a
JSON field should commit the complete object on save and explain that its inner
properties replace together. It must not present independently autosaved nested
cells unless the data is modeled as top-level table fields instead.

## Why there is no second table mode

The one-field pattern changes the meaningful merge boundary without adding a
second table definition, parser branch, query family, or Home capability.

A first-class atomic collection API would earn its place only if all of these
become true:

1. At least two concrete tables intentionally store keyed atomic values.
2. The runtime contract changes to honest `create(value)` and
   `replace(id, value)` operations rather than saving `{ value }` syntax.
3. The nested query limitation has an explicit answer.
4. Home needs a distinct semantic capability that cannot be derived from the
   one-field JSON schema.

If that evidence appears, prefer a clearly separate atomic collection noun over
a hidden `writes: 'row'` flag or atomic field groups. Until then, one canonical
table implementation is the smaller and more legible API.

## Storage format

Scalar payloads remain JSON `TEXT`. Wrapping a row in a `value` field does not
compress it. Application-compressed blobs would lose native JSON queries,
constraints, inspection, and schema-aware UI while requiring decompression on
every read.

[SQLite JSONB](https://www.sqlite.org/json1.html#jsonb) is queryable, slightly
smaller, and can avoid parsing for some SQL JSON operations, but it is an
internal binary representation rather than general compression. It does not
change merge semantics or whole-value write amplification, and adapter support
is not yet uniform. Revisit it only after profiling shows JSON parsing or
extraction dominates across the supported engines. If transport bytes become
the measured bottleneck, compress the transport envelope before making
application values opaque.
