# 0673. A SQLite handle owns one connection until asynchronous disposal

- **Status:** Proposed
- **Date:** 2026-10-22
- **Amends:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at forbidding host access to app-private databases, allowing app-requested SQLite operations within an installation-bound capability.
- **Relates:** [ADR-0678](0678-app-storage-openers-use-runtime-bound-scopes.md) defines the installation scope and database opener; [ADR-0660](0660-native-apps-default-authored-work-to-the-epicenter-root.md) separates authored Folders from app-managed local state; historical ADR-0312 refused transactions spanning IPC calls but was superseded by ADR-0534.
- **Unbuilt:** A repository SQLite adapter, `openDeviceDatabase` and `deleteDeviceDatabase`, production open-or-create admission and interrupted-deletion recovery, asynchronous disposal, browser cross-tab contention deadlines and worker-failure cleanup, and portable renderer-crash cleanup; adapters remain fictional-data prototypes, with no production exports.
- **Evidence:** [Fictional-data deletion checks](../../packages/folder/evidence/sqlite-delete/NOTES.md) exercise an earlier path-based facade, not the installation-bound named opener.

## Context

A database connection has a lifetime separate from its stored data. The app
opens a named database within the installation scope of ADR-0678, retains its
connection for the work, and explicitly closes it. Bounded async functions can
use `await using` for the same cleanup. Fictional-data prototypes exercise this
model; their historical opener spellings create no public API to preserve.

A database file also outlives any one connection. Removing it belongs to the
installation-scoped database operation: a database may need removal when unopened or corrupt.
Repeating raw main-file deletion in each app omits SQLite's recovery companions;
generic reset and recreate methods would additionally take over schema and
rebuild policy that only the app knows.

ADR-0201 forbids the host from reading inside app-private databases. Native
SQLite for hosted pages requires an exception for database operations requested
through scoped database capabilities. ADR-0660 already permits app-managed
SQLite outside the authored Folder and explicitly defines no shared SQLite API.

## Decision

**An opened SQLite handle retains one connection until its owner closes it.**

`openDeviceDatabase(name)` resolves after that connection is available. The
runtime supplies the installation scope and admits the logical name as defined
in ADR-0678; the returned handle supplies SQL operations and connection
lifetime. A UI session keeps and lends the handle to application functions;
screens do not each open another connection. Opening the same name again
creates an independent connection to the same database, not a shared closable
singleton. An existing native main file is opened without replacement. A new
native database is created only when the main file and all supported recovery
companions are absent; the app initializes its schema. If companions exist
without the main file, opening refuses with `OrphanedCompanions` instead of
creating a new database beside them. Inspection failure is an error, not
absence. No failed open selects another name or engine.

The connection has four named methods and the standard asynchronous disposal
symbol; the top level has two database operations. These signatures define the
proposed contract; no production package exports them yet:

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

declare function openDeviceDatabase(name: string): Promise<SqliteDatabase>;
declare function deleteDeviceDatabase(name: string): Promise<void>;
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

The shared API is asynchronous: opening, SQL operations, closing, and deletion
return Promises. Native calls cross IPC; browser calls cross a worker boundary.
`async`/`await` and `await using` express those lifetimes without making either
transport synchronous.

**`deleteDeviceDatabase(name)` removes a database under caller-established
quiescence.**

For admitted name `name`, the native main path `p` is `<root>/<name>.sqlite`.
The supported native family is exactly `p`, `p-journal`, `p-wal`, and `p-shm`.
For example, `google.abc` names `google.abc.sqlite`, with companions
`google.abc.sqlite-journal`, `google.abc.sqlite-wal`, and
`google.abc.sqlite-shm`. Periods in the logical name do not select a namespace
or expand deletion to other names: deleting `google` does not delete
`google.abc`.

Calling delete authorizes removal of these exact names, even when the main
file is absent or corrupt; no header check, extension inference,
directory scan, or recursive removal establishes their ownership. Apps reserve
the companion names for that database and do not put unrelated content or
another database there. A directory at a family path fails without recursion.
The browser backend may not expose literal files; its equivalent deletion and
interrupted-cleanup rules must be defined for the selected adapter before the
browser operation ships.

The caller stops producers, awaits their work, closes owned connections, and
excludes other SQL and raw-file clients for the entire maintenance operation.
`Busy` refusal covers tracked opening, live, closing, and retiring resources
until physical release: across windows in the calling native host process, or
across database handles in the calling browser tab. Same-name managed
open/delete admission excludes competing operations within that domain. Delete
refuses tracked owners before mutation and never forcibly closes them. Opening while
deletion is admitted refuses. Other tabs, native shells, CLI processes, and
direct filesystem clients are outside that tracking domain; their quiescence
remains the caller's obligation. A SQLite transaction lock alone does not prove
file-lifetime exclusion.

The native deletion order makes interrupted cleanup discoverable without a catalog:

1. Remove the main file. If absent, continue. If removal fails, stop before
   touching companions and report the failure.
2. Remove each exact companion, treating absence as success and attempting the
   remaining companions even if one removal fails.
3. Report success only when the whole family is absent. On failure, identify
   failed or uninspectable family members relative to the bound root, not native
   absolute paths; absence of the main file alone is not success.

After main-file removal, remaining companions make the next managed open
refuse. Retrying delete finishes cleanup. The guard detects orphaned state; it
does not establish that another client stayed away. Raw replacement can bypass
it. This ordering establishes neither power-loss durability nor an atomic
multi-file operation.

An app that needs deletion intent to survive restart records that intent in
its own account or maintenance state before deletion. Account disconnection
stops reopening/re-pulling before removing the device copy; a failure keeps the
account inactive until cleanup is retried. Device storage may contain pending
user work, so deciding what may be discarded is app policy. Delete promises
neither secure erasure nor removal of provider data or backups.

**Clearing, rebuilding, and initializing a database remain application operations.**

| Intent | Operation |
| --- | --- |
| Clear selected records | App-selected SQL in `db.batch` |
| Rebuild an index or provider mirror | App-owned SQL or separately named replacement with app-owned readiness |
| Recreate a database | Quiesce, `deleteDeviceDatabase`, `openDeviceDatabase`, then app schema initialization; not atomic |
| Export a consistent live database | Deferred; requires a database-aware snapshot, not a raw byte read |

No generic reset, recreate, create, exists, list-databases, rename, migration, or
export method is added. Open-or-create covers creation. Native CLI tools retain
their own existing/read-only opening modes.

**`close()` and `[Symbol.asyncDispose]()` invoke the same asynchronous cleanup operation.**

Repeated calls await the same cleanup outcome. Once closing begins, new calls
reject. Closing releases the connection and its resources; the database file,
committed records, and indexes remain. It does not close other handles.
Cleanup failures remain observable.

Each handle owns one cleanup operation and caches its Promise, including a
rejection. Both `close` and `[Symbol.asyncDispose]` call that operation; neither
starts another physical close. An adapter rejects new work once cleanup begins.

The owner stops submitting work and awaits started operations before closing.
The shared contract promises neither cancellation nor draining of unawaited
operations. Garbage collection and asynchronous page-unload handlers do not own
cleanup.

For a bounded task, `await using` awaits disposal when control leaves the scope,
including after a throw:

```ts
async function inspectFictionalMessages() {
  await using db = await openDeviceDatabase('messages-demo-a');
  return await db.all('SELECT id, text FROM fictional_messages LIMIT 50');
}
```

The query settles before scope cleanup. A UI session instead retains its
database handles and explicitly awaits each `db.close()` at teardown. An
`await using` inside a setup function would close at the end of setup, before
the UI's lifetime ends.

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
| Standalone Tauri page | Native SQLite in Rust | This installed product's own AppData root | Session closes its database handle |
| Page hosted in Epicenter | Native SQLite in Rust | This app's partition beneath Epicenter's AppData root, separate from standalone | Session closes its database handle |
| Browser page | SQLite WASM in a worker | This app's origin-local database storage; backend undecided | Session closes its database handle and associated worker |
| Native CLI command | That command's native connection | Explicitly resolved root for the intended installation | Command closes its connection and exits |

The native backend binds each handle to its admitted installation, database name,
window, and document generation. An app can name separate databases for different
accounts; an account does not select the private storage root. The page receives
an opaque connection resource without arbitrary path authority. Every native
request checks its window/document owner. The shell grants database commands
only to admitted windows; a resource ID alone grants no access. Before opening
SQLite, the host reserves admission keyed by the resolved installation root and
logical name across the
host process. Pending opens and closing or retiring resources retain that
reservation until physical release; unrelated app roots do not share admission
merely because both databases are named `state`.

Rust retains the connection and serializes its SQL work. Each `all`, `run`, or
`batch` crosses IPC as one request; each write transaction begins and finishes
inside that native job. A batch never sends separate transaction-control calls
from the page. The host executes requested operations within the binding, without
independently enumerating, inspecting, reclaiming, or migrating app databases.
Schema, initialization, retention, migrations, and recovery remain app-owned.
This is the bounded exception to ADR-0201.

The browser adapter retains one SQLite WASM connection in its worker and sends
each complete batch in one worker request. It awaits the worker's database-close
acknowledgment before reporting successful cleanup and releasing admission.
Unexpected worker termination is a failure, not a close acknowledgment. While
physical release is unconfirmed, the database remains Busy; page retirement is
the conservative boundary exercised by the frozen prototype. The selected browser
backend still needs its own failure and deletion verification. None of this
requires a public device-file namespace or fixes the backend's physical layout.

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

Browser storage is separate from native AppData and does not provide direct
native CLI access. ADR-0678 leaves the browser SQLite backend open. Earlier
browser parity checks used `opfs-sahpool`; their results do not establish
whether it is the right production choice.

The frozen [official OPFS measurements](../../packages/folder/evidence/device-opfs/NOTES.md)
and [cross-tab SQL coordination checks](../../packages/folder/evidence/device-opfs-coordination/NOTES.md)
record multi-tab feasibility, contention, and adapter-specific limits. They do
not select a browser backend or validate its production lifecycle. The selected
backend still needs validation of contention and cancellation, worker and
renderer failure, deployment isolation, origin retention, mobile behavior, and
initialization. Orderly page closure does not establish crash cleanup, and
native app/CLI tests establish none of those browser properties.

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

A later [fictional-data deletion prototype](../../packages/folder/evidence/sqlite-delete/NOTES.md)
passed 33 named native cases and 30 each in Chromium, Firefox, and Playwright
WebKit. It exercises interruption before and after each removal, orphan refusal,
interrupted and repeatedly failing cleanup retries, inspection/unlink failures,
directory and neighbor preservation, and local open/close/delete admission.
Native SIGKILL checks also remove actual SQLite-created WAL and rollback-journal
remnants. Browser interruption terminates a worker on the literal `opfs` VFS;
the all-companion boundary fixtures are synthetic. The simplified SQL harness
also checks repeated close, asynchronous disposal, and atomic batch rollback.

These results support the tested storage mechanisms, not an implementation of
the named opener. Logical-name admission, `name.sqlite` mapping, installation
bindings, admission keyed by installation and name, and Tauri IPC/window
retirement still need verification. Browser deletion must be defined and tested
against the selected backend; the literal-file results do not validate pooled
storage. Whole-browser crashes, power loss, and interruption inside a pending
unlink remain unverified. The archived path facade is historical and creates no
compatibility requirement.

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
- **Expose only an opener:** A named opener is enough for normal use, but
  explicit maintenance deletion also needs a database-aware operation.
- **Raw file deletion in every app:** Repeats recovery-file handling and leaves
  partial deletion semantics at each caller.
- **A generic `db.reset` or forced-close delete:** Adopts app schema policy or
  another owner's connection lifetime; neither is needed for explicit maintenance.
