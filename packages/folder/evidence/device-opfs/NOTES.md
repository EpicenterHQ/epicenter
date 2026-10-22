# SQLite and ordinary device files can share one OPFS namespace

On 2026-10-22, a throwaway browser prototype demonstrated that its own
`device.openSqlite('search.sqlite')` and
`device.files.read('search.sqlite')` can address the same OPFS file. The
official `opfs` adapter supplies this without a custom SQLite VFS. The
remaining difficulty is safe ownership during raw access and predictable
cross-tab contention, rather than filename transparency.

This is experiment evidence, not a production package or an implemented
`openDeviceStorage` export. The API it imitates is proposed in
[ADR-0678](../../../../docs/adr/0678-app-storage-openers-use-runtime-bound-scopes.md)
and [ADR-0673](../../../../docs/adr/0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md),
both still Proposed. The source is frozen in
[prototype-source.tar.gz](prototype-source.tar.gz) so it does not become an
active implementation inside the library.

## Scope and method

The prototype uses `@sqlite.org/sqlite-wasm@3.54.1-build1`, Bun 1.4.3,
Playwright 1.61.1, and three Playwright-installed desktop browser engines,
run headless on macOS:

| Engine | Reported version |
| --- | --- |
| Chromium | 149.0.7827.55 |
| Firefox | 151.0 |
| Playwright WebKit | 26.5 |

Playwright WebKit is not a test of the shipping Safari application or iOS.
Each browser run uses a new disposable persistent profile and a loopback
server. All records are fictional. The OPFS root is explicitly named
`PROTOTYPE-wipe-me-device-opfs`. No account, production credentials, or real
user database participates. Profiles are removed at the end of each completed
run. Results contain observations and checks, not performance guarantees.

The server serves the official package's module, WASM, and proxy worker with
COOP `same-origin` and COEP `require-corp`. Each connection uses one dedicated
SQLite worker and the official adapter's additional proxy worker. File
operations use the ordinary OPFS APIs from the page. The page supplies no app
ID; the prototype binds one fixed scratch root at its implementation boundary.

## What worked

The [full OPFS run](results-opfs-full.json) records 20 observations per engine.
All three engines completed the following checks:

- SQLite creates the literal `search.sqlite` file. After closing the
  connection, ordinary file reads return 32,768 bytes beginning with
  `SQLite format 3` and its NUL terminator.
- Tab B reads that file through `device.files`, writes those bytes to
  `copy.sqlite`, opens the copy through SQLite, and reads the original rows.
- Two tabs retain independent connections to `search.sqlite` and each execute
  100 atomic batches. Each batch increments a counter and inserts a uniquely
  identified edit. Both the final counter and row count equal 200: 600
  completed batches across the three engines, with no lost or duplicated
  edits in this scenario.
- A batch that updates the counter and then violates a unique constraint
  rolls back both statements.
- After contention ends, an existing connection can write again.
- Closing a tab after `BEGIN EXCLUSIVE` and an uncommitted update leaves the
  last committed value recoverable in the other tab. The test closes a page;
  it does not forcibly crash the renderer or kill the browser process.
- After every connection closes, ordinary byte reads work again. An adjacent
  `preferences.json` also remains readable.
- A full browser-context shutdown and reopening of the same profile preserves
  committed rows and returns `ok` from `PRAGMA integrity_check`.
- A document served without the isolation headers cannot open this adapter.
  The prototype refuses rather than falling back to transient storage.

## Raw access needs a rule beyond browser permission

Against separate disposable database copies, each engine permits an ordinary
raw byte read through the experiment-only bypass, from the tab whose SQLite
connection holds an exclusive transaction on that copy. This is not a
consistent-snapshot guarantee. Raw writes and deletions of those locked files
fail in this experiment, but their DOM exception names differ by engine.

The prototype also tries a small cooperating ownership rule. Each SQLite
connection holds a shared Web Lock on the main file path for its lifetime.
Each raw read, write, or deletion requests the same lock exclusively with
`ifAvailable`. If a connection in either tab still holds it, the operation
rejects with `FileBusy` immediately. Multiple SQLite connections can share the
lease, so it does not serialize their SQL. Closing the page releases its
lease. Browser enforcement and this additional rule are recorded separately.

This lease protects only the addressed main file among cooperating callers.
It does not protect journal paths, coordinate native processes, provide an
account boundary, or prevent arbitrary code from bypassing it through OPFS.
The experiment-only `device.unprotected` bypass exists to observe actual
browser behavior. Neither it nor the probe-only transaction commands belong
in a production API. A shipping raw-access contract must cover recovery
sidecars and all relevant connection owners, or explicitly make quiescence
the caller's responsibility.

## Contention is the material limitation

The [measured OPFS contention run](results-opfs-contention.json) holds an
exclusive transaction in tab A while tab B tries an update. Tab B has a 50 ms
SQLite busy timeout and a 150 ms outer retry budget. The latter is checked
between calls; it cannot interrupt an executing SQLite/VFS call.

| Engine | Short hold, released after 100 ms | Held until adapter error |
| --- | --- | --- |
| Chromium | Completes in about 315 ms | `SQLITE_BUSY` after about 31.7 s |
| Firefox | Completes in about 333 ms | `SQLITE_BUSY` after about 31.7 s |
| WebKit | Completes in about 316 ms | `SQLITE_IOERR_LOCK` after about 4.5 s |

The full-run JSON came from an earlier revision of the archived harness. It
names this case `bounded-contention-and-recovery`. That name describes eventual
settlement, not an application-level deadline; the follow-up timing measurement
exposes this distinction. That full-run record holds the error without an
elapsed time, and the JSON lacks a top-level `vfs` field. The archived source
names the case `contention-error-and-recovery`, adds `ms` to each such record,
and writes `vfs`.

The installed official proxy's `getSyncHandle` retries synchronous-handle
acquisition, and documents that failures may reach clients as either an I/O
error or `SQLITE_BUSY`. Its own waiting occurs below our retry check. These
observations do not justify retrying every I/O error or timing out a write
and assuming it did not commit.

The [official opfs-wl comparison](results-opfs-wl-contention.json) repeats
file transparency and short/held contention checks. It does not repeat the
entire full-run matrix. All engines complete the short hold in about
265-278 ms. During a sustained hold, none settles within a three-second
observation window despite the same budgets. Releasing the owner then lets
the waiting update complete, after about 3.2 s total. This supports recovery
and cooperative queuing; it establishes neither a hard timeout nor indefinite
waiting behavior. The two timing experiments overlapped in execution, so
small latency differences are not a meaningful adapter benchmark.

## Consequence for the proposed API

Keep a shared path namespace: the database is a file, and ordinary cleanly
closed database files can be read, copied, and reopened. There is no need to
invent a managed database namespace or a custom VFS to achieve that.

Keep production transactions inside one worker request, such as a bounded
`batch` of statements. The deliberately held cross-request transaction in
this probe makes contention observable; it should not become a public async
transaction protocol. A single request does not by itself establish a wall
clock bound: long queries, page suspension, and adapter waits still need
deliberate handling. The caller must not confuse a lost or timed-out reply
with proof that a write did not happen.

Before shipping, resolve raw main-file and sidecar admission, cross-tab
operation ownership, deadline and cancellation semantics, worker failure
cleanup, database deletion, and cross-origin isolation for production pages.
A separate cross-tab SQL scheduler could avoid exposing the adapter to
overlapping transactions, but was not built or validated here. The small
raw-file lease should not be mistaken for one.

## Replay and inspect

Unpack the archive into an empty scratch directory, then install its pinned
dependencies with `bun install --frozen-lockfile`. If the matching browser
binaries are missing, install them with
`bun x playwright@1.61.1 install chromium firefox webkit`.

From that extracted directory, one command runs the full experiment and
writes `results.json` there, using the archived case names and fields above:

```sh
bun run.ts
```

Additional commands:

```sh
# Reproduce the long held-lock measurement with ordinary opfs.
bun run.ts --contention-only --hold-until-error --output=results-opfs-contention.json

# Observe opfs-wl for three seconds, then release the owner.
bun run.ts --contention-only --vfs=opfs-wl --output=results-opfs-wl-contention.json

# Interactive page; open the printed loopback URL in two browser tabs.
bun run.ts --manual
```

The manual page renders filenames and active Web Locks. In each tab's console,
the same scope is available as `deviceProbe.device`. For example, open
`const db = await deviceProbe.device.openSqlite('manual.sqlite')`, run SQL,
then `await db.close()` before reading `manual.sqlite` through
`deviceProbe.device.files`. The prototype accepts a single filename per
operation; nested paths and production path admission are outside its scope.

The four TypeScript source files pass strict standalone type checking.
Post-implementation inspection reviewed the worker lifetime, cross-tab lease,
raw-access bypass, scenario assertions, and evidence claims. The prototype
does not establish mobile behavior, quota/eviction handling, forced browser
termination, native/CLI coordination, WAL interoperability, large-file cost,
production SQL admission, or a completed resource-lifetime contract.

## Sources

- [Official SQLite browser persistence options](https://sqlite.org/wasm/doc/tip/persistence.md)
- [Official SQLite WASM package](https://github.com/sqlite/sqlite-wasm)
- [SQLite database corruption risks from raw file operations](https://sqlite.org/howtocorrupt.html)
- The installed package's types and `sqlite3-opfs-async-proxy.js`, version
  3.54.1-build1, inspected during the experiment.
