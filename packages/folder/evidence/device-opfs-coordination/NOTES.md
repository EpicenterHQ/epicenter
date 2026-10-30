# OPFS SQLite with a short cross-tab SQL lock

Throwaway experiment, 2026-10-22. Fictional messages, disposable browser
profiles, no Beeper SDK, credentials, provider calls, or sends. No production
API, app, or ADR changed. Native SQLite is outside this experiment.

The archived `device.openSqlite`, `device.sqlite`, and `device.files` spellings
belong to the retired shared-device namespace proposal.
[ADR-0678](../../../../docs/adr/0678-app-storage-openers-use-runtime-bound-scopes.md)
instead defines installation-bound `openDeviceDatabase(name)` and
`deleteDeviceDatabase(name)`, with separate hosted and standalone native roots.
There is no parent device handle or generic device-file API. The frozen source
and raw-file observations remain historical evidence; literal file identity is
not a requirement of the database contract. Both that ADR and
[ADR-0673](../../../../docs/adr/0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md)
are Accepted as a design, with production SQLite exports unbuilt.

**Result:** a per-database Web Lock before worker dispatch gives cooperating
tabs a useful refusal: `DatabaseBusy`, with proof that the request was never
sent. Combined with the official adapter's `opfs-unlock-asap=1` option, it
also removed the roughly 300 ms contention tails in this small workload.
The database remains an ordinary OPFS file. This is evidence for a mechanism,
not a finished handle lifecycle or a guarantee about every SQL operation.

## Evidence and reproduction

- [Corrected reference run](results/run-2026-10-22T07-50-19.557Z.json): all nine
  candidate/engine combinations completed all seven cases. Strict standalone
  typecheck passed. The coordinator ran the browsers outside the helper's
  server-binding sandbox.
- [Initial run](results/run-2026-10-22T07-41-30.835Z.json), preserved unchanged:
  seven combinations completed. Both later WebKit cases encountered an existing
  table despite separate persistent contexts. Cause unestablished. The corrected
  harness uses a unique OPFS root per run/candidate/engine, shared by both tabs.
  It also asserts refusal and absence of late writes, rather than only recording
  them. Its neutral `over250ms` field replaces the initial run's speculative
  `over250msLikelyAdapterRetry` name.
- [Runnable source](prototype-source.tar.gz): pinned package, lockfile,
  standalone TypeScript config, and four sources, under `prototype/`.
  Archived so experimental dependencies and globals do not enter the Folder
  package's evidence typecheck. No dependencies or browser binaries included.
- Versions: `@sqlite.org/sqlite-wasm@3.54.1-build1`, Playwright 1.61.1,
  Bun 1.4.3, macOS arm64; Chromium 149.0.7827.55, Firefox 151.0, Playwright
  WebKit 26.5. Headless WebKit is not validation on Safari or iOS.

Extract into a disposable directory outside the repository, then run:

```sh
cd prototype
bun install --frozen-lockfile
bun x playwright install chromium firefox webkit
bun run typecheck
bun run probe
# Optional filtered repeat:
bun run.ts --candidate=weblock-asap --engine=webkit
```

The server binds loopback with COOP/COEP headers. Each run writes a new
timestamped JSON under the extracted `results/`; existing evidence is never
overwritten. Browser profiles are temporary. `bun run.ts --manual` prints a
console-driven experiment URL, using a separate disposable root.

## What changes

Each tab retains its own worker and SQLite connection to `messages.sqlite`.
Transactions begin and finish within one worker request. There is no async
transaction callback spanning requests.

| Candidate | Additional rule |
| --- | --- |
| `none` | Dispatch directly to the worker. |
| `weblock` | Acquire an exclusive Web Lock for the database's canonical path before dispatch; hold it until the worker reply settles. Abort pending acquisition after an active-time budget, or use `ifAvailable` to refuse immediately. |
| `weblock-asap` | Same lock, plus SQLite's `opfs-unlock-asap=1` URI option. |

The new SQL guard is 13 lines, 15 with marker comments, at archived
`prototype/device.ts:89-103`. It adds no leader, forwarding channel, shared
connection, or additional worker. The existing worker, RPC, and file-lease
machinery remains necessary: all four TypeScript files total 511 lines,
including 294 lines of controller and test harness. This line count does not
represent production implementation cost.

The archived fixture uses two locks with different lifetimes. The file lease
serves its historical raw-file interface; the named opener does not
inherit that interface or lease requirement.

1. **File lease, unchanged from the earlier prototype:** shared for every
   connection's lifetime. Cooperating raw file reads, writes, and deletes take
   it exclusively with `ifAvailable`, returning `FileBusy` while connections
   exist. It protects raw bytes versus open connections.
2. **SQL lock, new:** exclusive only for one worker request, including open.
   Connections share the file lease but take turns executing SQL. A waiter
   can leave this queue before any SQL is posted.

Open takes a nonwaiting file lease, then waits for the SQL lock. Raw access
takes only a nonwaiting file lease. These two acquisition rules do not wait
on each other. The fixture deliberately accepts only one basename under its
disposable root; production app binding and path validation are not implemented.

## Measurements

Times below are milliseconds, rounded, in Chromium / Firefox / WebKit order.
These are individual synthetic runs, not throughput benchmarks.

The normal workload runs two overlapping fictional page fetchers and two read
loops: 40 atomic page batches plus 80 reads per combination. Every combination
finished with 750 distinct messages, cursor 30, no request errors, and
`integrity_check = ok`. Fetches happen outside SQL, including ten deliberately
duplicated pages.

| Candidate | Slowest normal request | Requests over 250 ms | Write immediately after peer opens |
| --- | --- | --- | --- |
| `none` | 913 / 918 / 313 | 2 / 2 / 4 | 309 / 332 / 313 |
| `weblock` | 320 / 366 / 346 | 4 / 4 / 4 | 312 / 323 / 316 |
| `weblock-asap` | 21 / 57 / 20 | 0 / 0 / 0 | 1.7 / 4.1 / 2.4 |

The plain lock does not remove all adapter waiting. Installed adapter source
shows that implicitly acquired sync handles can remain until an idle interval;
the unlock-asap option changes that behavior. Its benefit here supports using
it alongside the SQL lock, with throughput on larger workloads still unmeasured.
See [SQLite's persistence documentation](https://sqlite.org/wasm/doc/tip/persistence.md#unlock-asap-mode).

**Held peer:** a probe-only synchronous fault gate holds one transaction in
tab A for six seconds. Tab B attempts a write and read with a 1000 ms
acquisition budget, plus an immediate refusal probe.

| Candidate | B's write outcome | Rows present before explicit retry |
| --- | --- | --- |
| `none` | Chromium/Firefox commit at 6361 / 6386 ms, after the caller stops waiting at 1500 ms. WebKit returns `SQLITE_IOERR_LOCK` at 4523 ms. | 25 / 25 / 0 |
| `weblock` | `DatabaseBusy`, `dispatched: false`, at 1006 / 1023 / 1002 ms | 0 / 0 / 0 |
| `weblock-asap` | Same refusal at 1001 / 1030 / 1002 ms | 0 / 0 / 0 |

All coordinated bounded reads also refused before dispatch. Immediate probes
refused in under 1 ms. After the owner completed, explicit retries committed
all 25 rows. WebKit's retry still took about one second under both coordinated
candidates; the experiment does not attribute that delay or promise a bound
on dispatched SQL.

The earlier [OPFS experiment](../device-opfs/NOTES.md) measured roughly 32 s
before `SQLITE_BUSY` under a deliberately held transaction. This experiment
uses a whole-request six-second hold; it demonstrates refusing before that
uncancellable adapter wait, rather than reproducing a 32-second wait again.

Other hard checks passed in every combination:

- A NOT NULL failure rolls back both message writes and cursor advancement.
- Closing the owner tab mid-transaction lets the other tab commit; the owner's
  uncommitted marker disappears. With `weblock-asap`, settlement after page
  closure took 324 / 92 / 10 ms. Orderly page closure is not a forced crash.
- Raw file access returns `FileBusy` while connections exist. After both close,
  `device.files` reads 106,496 ordinary SQLite bytes, copies them, and SQLite
  opens the copy with all 800 final rows. This is a quiescent copy, not a live
  backup or snapshot guarantee.

## Composition with a Beeper wrapper

The referenced Messages investigation and app keep fetched history in
memory; drafts and send recovery are Folder-backed. There is no existing SQL
mirror to migrate. Native SQLite remains the desktop route.

If a future cache needs SQLite, the shape stays small:

```ts
// Accepted app contract, not an implemented export.
{
  await using db = await openDeviceDatabase('messages');
  const page = await provider.fetchPage(cursor);
  await db.batch([...upserts(page), advanceCursor(page.cursor)]);
}
```

The frozen fixture instead calls `device.openSqlite('messages.sqlite')`;
its raw-copy checks are not part of this app-facing example. The SQL lock can
be internal to a selected browser adapter. Optional `acquireMs` arguments
in the fixture allow measurement; they do not settle the public API. A refusal
before dispatch means the request did not run. A lost reply after dispatch
requires reconciliation because the write might have committed.

This fictional provider has numeric page cursors and immutable message bodies,
so upserts plus `max(cursor, incomingCursor)` converge. That is not a generic
Beeper cursor policy. Real opaque cursors, stale edits, deletions, and tombstones
need their own rules. SQL coordination does not elect a provider fetcher or
provide exactly-once sends. No extra architecture is needed for those concerns
unless a real consumer establishes the requirement.

## Limits before production

- **Handle cleanup:** `close()` bypasses the SQL lock and does not cancel calls
  still waiting for it. Such a call can later post to a terminated worker and
  retain the SQL lock indefinitely. This is a source-review finding, not an
  exercised case. Production disposal must cancel pending acquisition and
  settle queued calls; worker-failure cleanup also remains unfinished.
- **Suspension and post-dispatch waits:** a frozen lock holder can delay peers.
  The acquisition timer follows active time, not a hard wall-clock deadline;
  see [AbortSignal timeout semantics](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static).
  The guard cannot interrupt running SQL, and noncooperating openers can still
  cause waits inside the VFS after dispatch.
- **Deletion admission:** the SQL lock adds no deletion protection.
  `deleteDeviceDatabase(name)` needs maintenance admission for the selected
  backend; other tabs remain the caller's quiescence responsibility. The separate
  [deletion experiment](../sqlite-delete/NOTES.md) tests native and literal-OPFS
  cleanup within one host process or browser tab. It was not combined with this
  request lock and does not validate pooled-browser deletion. The retired raw
  interface does not create a requirement to ship raw copy, replace, or import.
- **Coverage:** no real provider, native-process concurrency, forced renderer
  crash, mobile Safari, background/frozen tab, large database, more than two
  tabs, fairness, or starvation guarantee was tested.

Recommendation: keep this mechanism available for a real multi-tab browser SQL
consumer. Preserve whole-request transactions and choose the browser backend
separately. Ordinary file identity and the raw-file lease are properties of this
fixture, not requirements of the named opener. Do not add SQL persistence to
Messages just to use this experiment, and resolve the handle lifecycle before
building a production adapter.
