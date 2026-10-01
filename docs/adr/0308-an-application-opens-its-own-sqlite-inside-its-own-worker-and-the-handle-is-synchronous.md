# 0308. An application opens its own SQLite inside its own worker, and the handle is synchronous

- **Status:** Superseded
- **Superseded by:** [ADR-0312](0312-a-sqlite-handle-is-all-run-and-batch-and-a-transaction-never-crosses-a-process-boundary.md). Tauri's IPC has no blocking path, so the synchronous handle this record decided is unreachable on the desktop target. Its reasoning about shipping work to the data survives there as `batch`.
- **Date:** 2026-08-31
- **Unbuilt:** the browser opener, its OPFS VFS installation, and the first application worker. The Bun path already exists inside each app.
- **Amends:** [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) at the application handle. Withdrawn: `AppSqliteDatabase` and its asynchronous `run`, `all`, and `transaction`. `openSqlite(name)`, its scoping, its refusal to accept a schema, and its refusal to migrate all stand.
- **Amends:** [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) at two bounded points. Its citation of [ADR-0275](0275-a-browser-stores-durable-record-is-sqlite-over-opfs-in-a-worker.md) as "the intended browser SQLite medium" is withdrawn: ADR-0275 is superseded, and Epicenter Data's browser medium is IndexedDB (ADR-0280, ADR-0298). Its "the platform can use SQLite WASM over OPFS" clause is narrowed to opening only. Its address layout is unchanged.
- **Relates:** [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (the app owns the lifecycle), [ADR-0223](0223-a-page-holds-the-store-and-only-three-small-relations-have-to-survive.md) (where a synchronous handle is reachable), and [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (why this database needs no recovery code)

## Context

Local Mail becomes a browser SPA holding roughly 40,000 Gmail messages that must
survive a reload. In a browser the only durable backing for SQLite is the origin
private file system, and taking a synchronous access handle to it is available
only in a dedicated worker. Re-measured on 2026-08-31 in real Chromium, with the
worker arm as the control that must succeed
(`packages/app/evidence/data/browser/sync-access-handle.ts`):

```txt
context           available  detail
main thread       false      createSyncAccessHandle is not a function
dedicated worker  true       9 bytes written
```

ADR-0303 read that constraint as "the application handle must be asynchronous."
That follows only if the application's code stays on the main thread while its
database is behind the wall. Local Mail's own write path shows the opposite is
available: `applyHistoryBatch` takes every message, deletion, label patch, and
cursor as an argument, awaits nothing, and returns one small object. It reads
and branches mid-transaction, so it is not expressible as a list of statements
shipped across a boundary, but every read it makes is local and synchronous.

## Decision

**The application owns the worker. Epicenter opens the database inside it and
stops.**

`openSqlite(name)` is called from the application's own dedicated worker and
resolves to the existing synchronous `SqliteDatabase`. Opening is the only
asynchronous step, because installing the OPFS VFS is asynchronous; every
statement and every transaction afterwards is synchronous, exactly as on Bun.

```txt
main thread                        the application's worker
  UI                                 the application's data module
  await mail.applyHistoryBatch({…}) ── one message ──▶ database.transaction(…)
                                                        SqliteDatabase (sync)
                                                        OPFS
```

The application therefore owns its worker, its provider authentication, its
synchronization protocol, its schema, its versioning, its readiness, its
deletion policy, and any SQL it wants to run. The platform contributes one
thing: a durable SQLite handle at a scoped address.

There is no asynchronous SQLite type anywhere in the tree.

## Consequences

- `AppSqliteDatabase` is never written. With it go asynchronous `run` and `all`,
  the transaction callback that could `await` a network call while holding a
  transaction open, and the question of what happens when it does.
- `close()` belongs to the application, which opened the handle and owns the
  worker's lifetime. There is no second owner and no platform disposer.
- One fat message crosses the worker boundary per operation instead of one thin
  message per statement, because the application's API is already at that
  granularity.
- Local Mail's `src/db.ts` ports to the browser close to unchanged. Its Bun and
  browser builds differ at the opener, not through the data layer.
- ADR-0303's scoped client stands, but its constructor name is unavailable:
  `createEpicenterClient` already exists in `packages/client` as the typed HTTP
  client, imported by `packages/app-shell`, `apps/epicenter`, `apps/vocab`, and
  `apps/whispering`. Implementing ADR-0303 requires choosing a different name or
  moving that one; this record does not choose.
- Nothing here applies to Epicenter Data. Its browser durability is IndexedDB on
  the main thread and it opens no worker (ADR-0280, ADR-0298).
- The measurement is a browser fact and can change. If a main thread gains
  synchronous access handles, the worker becomes optional and the handle stays
  synchronous either way, so that change would simplify this record rather than
  supersede it.

## Considered alternatives

- **An asynchronous handle on the main thread (ADR-0303 as written).** Rejected:
  it makes every statement a round trip, and its `transaction` hands a caller an
  open transaction across a message boundary with an unbounded `await` inside.
  `store/browser.ts` and ADR-0280 already record the same failure class costing
  three data-loss bugs on the IndexedDB side.
- **A batch API: ship an array of statements and run them atomically.** Rejected
  because `applyHistoryBatch` reads a row and branches on it inside its
  transaction, which no statement list can express.
- **Epicenter owns the worker and loads the application's data module into it.**
  Rejected for now: it makes the platform a code loader, which is an admission
  and trust decision ADR-0305 leaves unbuilt. An application spawning its own
  worker needs none of that.
