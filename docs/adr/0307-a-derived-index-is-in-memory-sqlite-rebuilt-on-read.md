# 0307. A derived index is in-memory SQLite, rebuilt on read

- **Status:** Accepted
- **Date:** 2026-08-31
- **Unbuilt:** the index itself. No application composes one yet, and the first one belongs in an application rather than in `@epicenter/data`.
- **Amends:** [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) at two bounded points. Withdrawn: that `SqliteDatabase` is renamed to `SyncSqliteDatabase`; the name stands. Sharpened: the projection's medium, trigger, and owner, which ADR-0303 described but did not decide.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (which withdrew the queryable projection over a host replica; this restores a narrower, app-local one), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (which defines a projection as rebuilt whole and therefore unable to be silently wrong), [ADR-0223](0223-a-page-holds-the-store-and-only-three-small-relations-have-to-survive.md) (the store needs a synchronous handle, not synchronous durability), [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (the disposability this inherits), and [ADR-0311](0311-a-table-is-a-held-projection-and-everything-cheaper-than-rebuilding-is-read-through.md) (the held table this reads from)

## Context

Every read a person makes today is answered from the `Y.Doc` already in memory:
`store/browser.ts` loads no SQLite at all. That is correct and stays correct for
`get`, `list`, `ids`, and `document`. It is not obviously enough for a question
that ranges over a whole table, such as every note mentioning one name, sorted,
across tens of thousands of rows.

An index that is UPDATED as edits arrive can miss one and be silently wrong
forever, with nothing inside it saying so. An index that is REBUILT cannot reach
a wrong state at all. ADR-0247 already named that difference; nothing has applied
it to Epicenter Data.

## Decision

**A derived index is an in-memory SQLite database, invalidated by any commit and
rebuilt whole on the next read.**

```txt
  you edit  -> stale = true      (cost: nothing)
  you edit  -> stale = true      (already true, still nothing)
  ... 500 more edits ...

  you search -> stale? YES -> drop everything, rebuild from the
                              document, stale = false, answer
  you search -> stale? NO  -> answer            (cost: nothing)
```

One rebuild between two searches, not one per keystroke. An application
nobody searches never builds an index at all. The whole of it:

```ts
let stale = true;
store.subscribe(() => { stale = true; });

function query(sql) {
  if (stale) { rebuild(); stale = false; }
  return db.all(sql);
}

function rebuild() {
  db = new Sqlite(':memory:');            // the previous one is dropped whole
  db.transaction(() => {
    // The HELD table (ADR-0311), not `store.tables.notes.rows`. The held map
    // already has every row built and conformed, so this walk is a map
    // iteration. Reading the store directly re-conforms all of them and costs
    // four times as much, for identical rows.
    for (const row of data.notes.rows)
      db.run('INSERT ...', row);
  });
}
```

- **In memory, never durable.** It is not written to OPFS, to IndexedDB, or to a
  file. It is rebuilt from the document at every launch, which is work the store
  already does when it replays the log.
- **The trigger is a read, not a write.** A commit sets one flag. The rebuild
  happens on the next query that finds the flag set, and only then. Typing five
  hundred characters between two searches costs one rebuild, not five hundred,
  and an application nobody searches never builds an index at all.
- **No debounce and no timer.** A debounce exists to keep a costly write off the
  edit path; a flag does that for free and cannot fire late.
- **The application owns it.** `@epicenter/data` gains nothing: not a table
  derivation, not a SQL type mapping, not an entry point. The first index is
  written in the application that needs it, over the store's public surface.
- **`SqliteDatabase` keeps its name.** The synchronous contract in
  `@epicenter/sqlite` serves this, the Bun durable port, the `workerd` test
  replica, and the authority. It is not projection-only infrastructure and must
  not be renamed as though it were. `SyncSqliteDatabase` would also read as
  "synchronization" in a tree where `sync/` is the transport.

Because it survives nothing, it has no migration, no repair, no corruption
state, no persisted schema version, and nothing to close. Dropping it at any
moment is always safe.

## Consequences

- The browser needs no worker, no OPFS, and no WASM asset for this. `:memory:`
  sqlite-wasm on the main thread is measured and working
  (`packages/app/evidence/data/browser/sync-access-handle.ts`).
- The cost is one full rebuild after a burst of edits, paid by the first reader.
  **Measured** (`evidence/bench/index-rebuild.ts`, 28 samples per cell, Apple
  Silicon, `bun:sqlite`):

  ```txt
    rows     Y.Doc walk    SQLite insert    total
    10,000     36-53 ms       10-12 ms       ~60 ms
    40,000    208-251 ms      45-59 ms      ~270 ms
  ```

  Linear, and roughly 3.7x under the one-second threshold this record set for
  itself. **The browser number is an extrapolation, not a measurement:**
  sqlite-wasm is typically 2 to 4 times slower on inserts, and inserts are only
  a fifth of the cost, so 40k in a WebView is expected around 400 to 450 ms.
  The margin there is about 2x rather than 3.7x. A browser bench would settle it.
- **The walk dominates, and SQLite is not the cost.** `ids()` over the same rows
  is 13 ms at 40k, so of the ~210 ms walk only about 13 ms is touching the
  document; the rest is `conformRow` validation and materializing a row object
  and a live content handle per row.
- **So the index reads the held table, not the store.** ADR-0311 holds every
  built row in a map and patches only the rows a commit names, which is the same
  conformance work paid once instead of per read. A rebuild over that map is the
  13 ms walk plus the insert rather than the 270 ms measured here. The numbers
  above are the floor for an index built the naive way, and they are the reason
  not to build one that way.
- A working vault carries tombstones from lifetime deletions that a freshly
  built corpus does not, which would push the walk up by some unmeasured amount.
- Promotion into `@epicenter/data` requires evidence, meaning three applications
  that grew the same index, not one that might.
- ADR-0226's withdrawal stands where it was made: no host-side reader sees an
  application's live rows. This index is inside the application, over its own
  store.

## Considered alternatives

- **Rebuild on every edit.** Same correctness, unusable cost: a rebuild per
  keystroke, paid so that nobody can query.
- **Maintain the index incrementally.** Faster, and it reintroduces exactly the
  silently-wrong failure ADR-0247 isolated to copies that cannot be rebuilt.
- **Persist the index to OPFS.** Rejected because it buys nothing: an index that
  rebuilds from the document at open regardless is a file whose only achievement
  is acquiring a migration path. `store/browser.ts` records this being tried.
- **Put the index in `@epicenter/data` now.** Rejected because the platform
  cannot know which questions an application asks, and a derivation with no
  caller is a contract written against imagination.
