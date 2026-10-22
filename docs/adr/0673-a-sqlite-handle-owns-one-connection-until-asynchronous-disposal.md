# 0673. A SQLite handle owns one connection until asynchronous disposal

- **Status:** Proposed
- **Date:** 2026-10-22
- **Amends:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at forbidding host access to app-private databases, allowing SQL requested through an app's scoped handle.
- **Relates:** [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) proposes the device scope and database opener; [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md) separates authored Folders from app-managed local state; historical ADR-0312 refused transactions spanning IPC calls but was superseded by ADR-0534.
- **Unbuilt:** A repository SQLite adapter, `device.openSqlite`, asynchronous disposal support, production database admission and initialization, browser cross-tab contention deadlines and worker-failure cleanup, and portable renderer-crash cleanup; adapters remain fictional-data prototypes, with no production exports.

## Context

The scratch SQLite prototype exposes `all`, `run`, `batch`, and `close` through
both a native Tauri connection and a browser SQLite WASM worker. Native tests
compare retaining one connection per handle with opening and closing a connection
for each operation. Both pass the concurrency, crash, and atomic rollback checks.
Per-operation connections still require logical handles, serialized execution,
and document retirement, while adding opening and closing to each SQL call.

Retaining a connection gives the TypeScript handle a resource lifetime separate
from the database file's lifetime. App teardown needs an explicit closing
operation. Bounded async functions can use `await using` for the same operation.
ADR-0678 proposes opening that connection through device storage. The prototype's
top-level `openSqlite({ account })` remains fixture plumbing, not a second public
opener to preserve.

ADR-0201 forbids the host from reading inside app-private databases. Native
SQLite for hosted pages requires an exception for SQL requested through scoped
handles. ADR-0660 already permits app-managed SQLite outside the authored Folder
and explicitly defines no shared SQLite API.

## Decision

**An opened SQLite handle retains one connection until its owner closes it.**

`device.openSqlite(path)` resolves after that connection is available. Its device
handle supplies the app scope and relative-path admission defined in ADR-0678;
this handle supplies SQL operations and connection lifetime. A UI session keeps
and lends the handle to application functions; screens do not each open another
connection. Opening the same path again creates an independent connection to
the same database, not a shared closable singleton.

The proposed contract has four named methods and the standard asynchronous
disposal symbol. These are candidate signatures, not existing package exports:

```ts
type SqliteValue = null | string | number;
type SqliteStatement = {
  sql: string;
  params?: readonly SqliteValue[];
};

type SqliteDatabase = AsyncDisposable & {
  all(
    sql: string,
    params?: readonly SqliteValue[],
  ): Promise<Record<string, SqliteValue>[]>;
  run(
    sql: string,
    params?: readonly SqliteValue[],
  ): Promise<{ changes: number }>;
  batch(statements: readonly SqliteStatement[]): Promise<{ changes: number[] }>;
  close(): Promise<void>;
};
```

`all` executes one read-only statement. `run` executes one statement without
result rows and is a batch of one. `batch` commits all its statements in one
local transaction or rolls them all back. No transaction spans IPC or worker
messages, and no async transaction callback is exposed.

The initial values are null, strings, and finite numbers; integers must be
JavaScript-safe. BLOBs, BigInt, row-returning writes, caller-controlled
transactions, attached databases, and cross-call connection-local state are
outside the shared contract. Runtime checks enforce these restrictions on both
sides of IPC. The prototype bounds reads to 1,000 rows; extraction must specify
limits rather than silently truncating results.

**`close()` and `[Symbol.asyncDispose]()` invoke the same asynchronous cleanup operation.**

Repeated calls await the same cleanup outcome. Once closing begins, new calls
reject. Closing releases the connection and its resources; the database file,
committed records, and indexes remain. It closes neither another handle to that
file nor the containing device handle. Cleanup failures remain observable.

The owner stops submitting work and awaits started operations before closing.
The shared contract promises neither cancellation nor draining of unawaited
operations. Garbage collection and asynchronous page-unload handlers do not own
cleanup.

For a bounded task, `await using` awaits disposal when control leaves the scope,
including after a throw:

```ts
async function inspectFictionalMessages() {
  await using device = await openDeviceStorage();
  await using db = await device.openSqlite('messages-demo-a.sqlite');
  return await db.all('SELECT id, text FROM fictional_messages LIMIT 50');
}
```

The query settles before scope cleanup. The database closes before the device;
the device's subsequent cleanup does not close that connection twice. A UI
session instead retains its handles and explicitly awaits `device.close()` at
teardown. An `await using` inside a setup function would close at the end of
setup, before the UI's lifetime ends.

Borrowing functions take dependencies in the first destructured argument and do
not close them:

```ts
async function searchMessages(
  { db }: { db: SqliteDatabase },
  { term }: { term: string },
) {
  return db.all(
    'SELECT id, text FROM fictional_messages WHERE text LIKE ? LIMIT 50',
    [`%${term}%`],
  );
}
```

No action registry or runtime context injection is required. The build must
support the syntax and provide `Symbol.asyncDispose` before handle construction.
For the language semantics, see [TypeScript's asynchronous disposal reference](https://www.typescriptlang.org/docs/handbook/variable-declarations.html#await-using-declarations).

**The runtime owns the physical connection and cleanup after UI failure.**

| Caller | Connection owner | Database location | Ordinary cleanup |
| --- | --- | --- | --- |
| Standalone Tauri page | Native SQLite in Rust | This app's device scope under the configured Epicenter AppData root | Session closes its device or database handle |
| Page hosted in Epicenter | Native SQLite in Rust | The same app device scope as standalone in the same storage environment | Session closes its device or database handle |
| Browser page | SQLite WASM in a worker | The literal path under this origin's device OPFS root | Session closes its device or database handle and associated workers |
| Native CLI command | That command's native connection | Explicitly resolved app device scope and path | Command closes its connection and exits |

The native backend binds each handle to its admitted app, relative path, window,
and document generation. An app can name separate databases for different
accounts; an account does not select the device storage root. The page receives
an opaque handle without arbitrary path authority. The host executes requested
SQL within that binding, without
independently enumerating, inspecting, reclaiming, or migrating app databases.
Schema, initialization, retention, migrations, and recovery remain app-owned.
This is the bounded exception to ADR-0201.

Native document/window retirement rejects received-but-queued work, discards
late connection opens, and releases resources after already executing SQL
finishes. Executing SQL may commit or roll back after renderer death. Replacement
documents cannot reuse retired handles. `Symbol.asyncDispose` does not execute
after a renderer crash; native cleanup remains necessary. The tested termination
hook is macOS-specific; other desktop targets need validation before delivery.

A native CLI command opens the same resolved file without launching a WebView
or requiring the app to be running. WAL and SQLite file locking coordinate
app/CLI access. Desktop apps need no Bun sidecar. A Bun tool may use its own
SQLite implementation without requiring the app to share its runtime.

Browser OPFS is separate from native AppData and does not provide direct native
CLI access. ADR-0678 defines the relationship to raw device files. Earlier
browser parity checks used `opfs-sahpool`; their results do not validate an
adapter preserving literal OPFS filenames.

A later fictional-data [official OPFS prototype](../../packages/folder/evidence/device-opfs/NOTES.md)
gives each connection its own worker on the `opfs` adapter of
`@sqlite.org/sqlite-wasm` 3.54.1-build1. In headless Chromium, Firefox, and
Playwright WebKit on macOS, two tabs holding connections to one literal file
each committed 100 atomic batches with no lost or duplicated edits. A constraint
failure rolled back its whole batch, closing a page mid-transaction left the
last committed value for the other tab, and a reopened profile passed
`PRAGMA integrity_check`. Forced contention did not respect application
budgets. With a 50 ms busy timeout and a 150 ms retry budget, an update blocked
by another tab's held exclusive transaction failed after about 31.7 s with
`SQLITE_BUSY` in Chromium and Firefox and about 4.5 s with `SQLITE_IOERR_LOCK`
in WebKit. The official `opfs-wl` adapter received only short and held
contention checks.

That evidence shows browser multi-tab feasibility, not production behavior.
Contention deadlines and error handling, cancellation, worker failure cleanup,
forced renderer or browser termination, cross-origin isolation in deployment,
origin retention, mobile browsers, and production initialization still require
validation before delivery. The page closures were orderly, not crashes. Native
app/CLI concurrency checks establish none of those properties.

## Consequences

The handle reuses one connection but retains resources between SQL calls. Normal
teardown requires an explicit owner; renderer failure requires native cleanup.

On macOS 26.5.2 with SQLite 3.53.2, three paired fictional-data trials used 5,000
synthetic messages. Without an idle CLI connection, standalone mean round trips
for retained versus per-operation connections were 0.39 versus 0.92 ms for
reading 50 rows, 0.44 versus 0.86 ms for updating one row, and 0.77 versus 1.90 ms
for a batch of 50 rows plus a cursor. An idle CLI connection reduced per-operation
overhead. These are single-machine measurements, not latency guarantees.

Together, both strategies passed 436 native process launches, 16 renderer
crashes, 198 shared case runs, and 20 window lifecycle case runs. Hosted probes
used a scratch bundle, not the production host. The comparison did not implement
or test `Symbol.asyncDispose`, production initialization, or non-macOS renderer
cleanup.

SQL atomicity does not provide exactly-once IPC or worker messaging: a response
can be lost, or its caller can stop waiting, after a write commits. Apps needing
retryable effects own their idempotency policy.

Authored work stays in the window-bound Folder under ADR-0660. A draft can be
Markdown while downloaded conversations live in SQLite. Whispering audio can
stay beside its Markdown even if Git ignores the audio. Closing a SQLite handle
changes none of those storage or synchronization rules.

## Considered alternatives

- **A connection for every operation:** Correct in the tested subset, but slower
  in the interactive benchmark while retaining logical lifetime and retirement.
- **Garbage collection owns closing:** Provides no deterministic timing or
  awaited cleanup outcome.
- **Only the disposal symbol:** Bounded scopes work, but UI sessions still need
  an explicit teardown operation; `close` names it.
- **SQLite WASM and OPFS on desktop too:** Adds WebView ownership coordination to
  native CLI access with the app closed.
- **A required Bun sidecar:** Adds a backend runtime for operations already
  served by native SQLite.
