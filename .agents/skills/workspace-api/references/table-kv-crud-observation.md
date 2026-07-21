# Table and KV CRUD + Observation

## When to Read This

Read when implementing table/KV read-write operations, observation callbacks, or reactive integration guidance.

## Reading & Observing Data

### Table CRUD

Read methods return wellcrafted `Result<T, TableParseError>`. "Not found" on `get()` / `update()` is **not** an error: it surfaces as `data: null`. Parse failures (unknown `_v`, schema mismatch, migration throw) surface as `error: TableParseError`.

```typescript
import { TableParseError } from '@epicenter/workspace';

const { data: note, error } = tables.notes.get(id);
if (error) {
  // TableParseError: UnknownVersion | ValidationFailed | MigrationFailed
  logger.warn(error);
  return;
}
if (note === null) {
  // legitimate absence
  return;
}
// note is the user-facing row (no _v)
```

Full surface:

```typescript
table.get(id)                       // Result<TRow | null, TableReadError>  : Ok(null) = absent
table.scan()                        // TableScan<TRow>     : the one classified bulk read
table.findValid(predicate)          // TRow | undefined    : first conforming match, short-circuits
table.has(id)                       // boolean             : a stored entry exists (any of the three states)
table.storedCount()                 // number              : count of every stored entry, O(1)

table.set(row)                      // Result<void, TableWriteError>  : upsert, refuses newer-writer rows
table.bulkSet(rows, { chunkSize?, onProgress? })   // Promise<{ refused: TableWriteError[] }>
table.update(id, partial)           // Result<TRow | null, TableReadError>
table.delete(id)                    // remove row (unguarded)
table.bulkDelete(ids, { chunkSize?, onProgress? }) // Promise<void>
table.clear()                       // { refused: TableWriteError[] }  : skips rows it cannot read
```

`set` and `update` accept the user-facing row shape: no `_v`. The library stamps the current version onto storage. `update`'s partial may not contain `id`.

### The classified scan

There is one bulk read, and it never silently drops data. `scan()` walks every
stored entry and resolves each into exactly one of three buckets whose lengths
sum to `storedCount()`:

```typescript
const { rows, nonconforming, newerWriter } = table.scan();

rows           // TRow[]                    : parse and validate to the latest schema
nonconforming  // TableParseError[]         : this binary should parse them but cannot
newerWriter    // TableNewerWriterError[]   : a newer binary wrote them (update the app)

// storedCount() === rows.length + nonconforming.length + newerWriter.length
```

`scan().rows` is the conforming payload almost every caller wants; the two
issue buckets ride along so a caller can log, surface, or deliberately ignore
them rather than hiding them by default. For "the first row matching p" without
building all three buckets, use `findValid(p)` (it short-circuits). For an
"N items" count, read `scan().rows.length`, not `storedCount()` (which counts
the issue buckets too). There is no valid-only bulk read: that was the
silent-drop footgun, and it is gone.

### KV CRUD

```typescript
kv.get('key')              // returns Static<S>; falls back to defaultValue() on miss or invalid
kv.set('key', value)       // upsert
kv.delete('key')           // remove (subsequent get returns defaultValue())
kv.getAll()                // { [key]: Static<S> }  : uses defaultValue() for unset keys
```

### Observation

Tables and KV stores support change observation for reactive updates:

```typescript
// Table: callback receives changed row IDs per Y.Transaction
const unsub = tables.notes.observe((changedIds) => {
  for (const id of changedIds) {
    const { data: note, error } = tables.notes.get(id);
    if (error || note === null) continue;
    // ...
  }
});

// KV: per-key observation
const unsub = kv.observe('theme.mode', (change) => {
  if (change.type === 'set') { /* change.value */ }
  if (change.type === 'delete') { /* fell back to default */ }
});

// KV: observe every registered key in one callback
const unsub = kv.observeAll((changes) => {
  for (const [key, change] of changes) { /* ... */ }
});
```

**In Svelte apps**, prefer `fromTable`/`fromKv` from `@epicenter/svelte` instead of raw observers. See the `svelte` skill for the reactive table state pattern.
