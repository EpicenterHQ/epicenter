---
name: data-lens
description: 'Epicenter universal-record Lens patterns in `@epicenter/data/record`: `defineLens`, `defineTable`, `defineValues`, typed binding, classified reads, row documents, and record-owned blobs. Use when defining or changing an app Lens, choosing scalar versus document or blob storage, reading or mutating Lens collections, handling nonconforming records, or binding Honeycrisp, Whispering, or another app to a record Epicenter.'
metadata:
  author: epicenter
  version: '1.0'
---

# Data Lens

A Lens is inert, pure-JSON interpretation. It gives typed meaning to records in
one durable namespace without creating a storage, synchronization, identity, or
lifecycle scope.

```txt
one record Epicenter
  +-- app Lens: namespace + release-local collection schemas
  +-- app Lens: namespace + release-local collection schemas
  `-- canonical records: scalar lane + optional document + optional blob
```

Use `@epicenter/data/record` for the universal-record API. Do not add new code
against the older top-level `@epicenter/data` row/value API.

## Define A Lens

Keep the definition isomorphic and free of runtime objects:

```ts
import {
	defineLens,
	defineTable,
	defineValues,
	type RowFor,
} from '@epicenter/data/record';
import { field } from '@epicenter/field';

export const notesTable = defineTable({
	title: 'Notes',
	fields: {
		title: field.string(),
		pinned: field.boolean(),
		deletedAt: field.instant(),
	},
	optional: ['deletedAt'],
});
export type Note = RowFor<typeof notesTable>;

const settings = defineValues({
	title: 'Settings',
	values: { compact: field.boolean() },
});

export const notesLens = defineLens({
	namespace: 'com.example.notes',
	title: 'Notes',
	description: 'Notes and their settings.',
	collections: { notes: notesTable, settings },
});
```

- Use one stable qualified namespace per app. Collection and value keys are
  local keys within it.
- Use `field.*` schemas. Lens fields cannot contain reference schemas or
  reserve structural `id` or `key` metadata.
- A table's row `id` is runtime-minted and structural. Never declare it in
  `fields`, cast a replacement id into a create input, or duplicate it in the
  payload.
- List every optional table field in `optional`. Setting an optional field to
  `undefined` unsets it; required fields cannot be unset.
- Derive row and value types from the definition. Do not relay hand-written
  copies through application state modules.

## Choose The Record Lane

Use the smallest replacement boundary that preserves the operation's intent:

| Need | Model |
| --- | --- |
| Independently changing bounded properties | Ordinary top-level table fields |
| One bounded object that replaces coherently | One `field.json(...)` field |
| Named singleton scalars | `defineValues(...)` |
| Concurrent edits inside one value | The row-owned document |
| Large immutable bytes | The blob at the same record address |

Top-level scalar patches compose by field after authority ordering. Two writes
to the same field do not compose. A JSON field replaces as one value. Do not put
large bytes into JSON or add a document when scalar replacement is honest.

## Bind And Use

Bind definitions to an already-open owner, once at the composition boundary:

```ts
const data = epicenter.bind({ notes: notesLens }).notes;

const created = await data.notes.create({ title: 'Draft', pinned: false });
const result = await data.notes.update(created.id, { title: 'Final' });
await data.settings.compact.set(true);
```

Table surfaces are `create`, `createWithBlob`, `get`, `update`, `delete`,
`scan`, `entries`, `subscribe`, `openDocument`, and `blob`. Value surfaces are
`get`, `set`, `unset`, and `subscribe`.

- `get` and `update` return `Result` because stored data can fail the current
  Lens. Handle `NonconformingRowError`; do not hide it with a cast or default.
- `entries()` visits live rows in stable record-key order using bounded pages.
  It is not a snapshot. `scan()` consumes the same traversal and groups rows
  from nonconforming records.
- Treat subscriptions as invalidation. Re-read the changed ids; the callback
  does not carry authoritative row values.
- Use `openDocument(id)` only for interior collaborative state and dispose the
  returned document. Record deletion or tombstoning revokes open documents.
- Use `createWithBlob(fields, source)` when scalar admission and the first blob
  belong to one creation. Otherwise use `table.blob.put/get/inspect(id)`.
  A blob is addressed by the same namespace, collection, and record id as its
  scalar and document lanes.

## Evolution

Lens schemas describe the current product, not a permanent migration chain.
A union is correct only when every variant remains a valid current state.

When an old physical shape is no longer current, keep it out of the Lens and
run one explicit, idempotent application-owned repair that recognizes the old
shape and writes an ordinary current update. Keep that repair only while a
supported writer can recreate the old shape. There is no Lens action or
read-time migration layer.

## Composition Boundaries

- The Lens owns names and interpretation only.
- The adapter owns the replica, blob store, synchronization, attachment, and
  disposal.
- The application layer owns multi-record workflows and product-specific
  recovery. Honeycrisp's folder deletion is an application function, not a
  Lens action.
- Bind one owner's app Lenses together when the host needs a shared typed view.
  Epicenter desktop binds Chat, Honeycrisp, and Whispering to its single Bun
  record owner.
- Browser and desktop adapters expose typed record operations. Do not send
  functions, database paths, or a Lens-owned lifecycle across the boundary.

Current grounded examples:

- `apps/honeycrisp/src/lib/data/index.ts`: tables, Lens, and a multi-row
  application operation.
- `apps/whispering/src/lib/data/lens.ts`: tables, values, and a
  record-owned audio blob.
- `apps/whispering/src/lib/whispering/app.ts`: binding and domain facades.
- `apps/epicenter/src/main.ts`: one Bun owner binding several app Lenses.
