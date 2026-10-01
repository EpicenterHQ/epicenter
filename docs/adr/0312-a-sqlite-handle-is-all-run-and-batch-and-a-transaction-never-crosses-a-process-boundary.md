# 0312. A SQLite handle is all, run, and batch, and a transaction never crosses a process boundary

- **Status:** Accepted
- **Date:** 2026-08-31
- **Built.** Local Mail is the first consumer, and the absent transaction callback is what turned its cross-database `effective_labels` view into a parameterized overlay.
- **Amended by:** [ADR-0321](0321-app-owned-storage-is-named-sqlite-files-an-application-opens-and-deletes-and-nothing-else.md) at the handle lifecycle: an application still cannot close a handle, and deleting a database closes it as part of deleting it; [ADR-0381](0381-user-authored-sql-runs-through-a-bounded-read-only-operation.md) proposes adding restricted `query` beside the trusted SQL verbs.
- **Supersedes:** [ADR-0308](0308-an-application-opens-its-own-sqlite-inside-its-own-worker-and-the-handle-is-synchronous.md) entirely. Its conclusion, a synchronous handle opened inside the application's own worker, is false for the desktop target: Tauri's IPC has no blocking path and `invoke()` always returns a promise, so a WebView cannot reach a native file synchronously. Its reasoning survives and is restated below, because shipping work to the data rather than statement by statement is what this record's `batch` exists to do.
- **Amends:** [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) at the application handle, carrying forward what ADR-0308 held. Withdrawn: `AppSqliteDatabase`'s `transaction(run: (db) => Promise<T>)` and its `close()`. Its asynchronous `run` and `all` are restored. `openSqlite(name)`, its scoping, its refusal to accept a schema, and its refusal to migrate all stand.
- **Amends:** [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) at two bounded points, carrying forward what ADR-0308 held. Its citation of [ADR-0275](0275-a-browser-stores-durable-record-is-sqlite-over-opfs-in-a-worker.md) as "the intended browser SQLite medium" is withdrawn: ADR-0275 is superseded and Epicenter Data's browser medium is IndexedDB (ADR-0280, ADR-0298). Its "the platform can use SQLite WASM over OPFS" clause is narrowed to opening only. Its address layout is unchanged.
- **Relates:** [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (one handle, the same shape in every runtime), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (the app owns its copy's lifecycle), [ADR-0305](0305-the-third-party-app-catalog-is-a-future-epicenter-deployment-plane.md) (a provider engine is not part of the catalog), and [ADR-0306](0306-borrowed-data-is-disposable-and-a-persons-own-data-is-not.md) (what that copy is)

## Context

A transaction is a lock held while a caller thinks. That is the whole reason it
exists; otherwise a caller would just send statements.

```txt
  BEGIN   [locked]  nobody else may touch this data
    read
    think           the point: decide from what was read
    write
  COMMIT  [open]
```

Thinking is free when the caller and the database share a process, and it is a
liability when they do not. Every design that put a database on the far side of
a boundary ran into the same wall:

```txt
  NEAR (same process)          FAR (across a boundary)
  BEGIN   [locked]             BEGIN   [locked] ---------->|
    read                         read ---------------------->|
    think   microseconds         <---------------- result    |  lock
    write                        think                       |  still
  COMMIT  [open]                 write --------------------->|  held
                               COMMIT  [open] ------------->|

                               a caller that never returns holds
                               the lock forever
```

Two measurements closed off the alternatives. Tauri's IPC is asynchronous with
no blocking bridge, so a WebView cannot hold a synchronous handle on a native
file. And whether a browser's SQLite is synchronous depends on which OPFS VFS a
build chooses (`opfs-sahpool` takes synchronous access handles;
the older `opfs` VFS needs `SharedArrayBuffer` and cross-origin isolation; other
builds are asynchronous at the JavaScript boundary), so synchrony is a
reversible implementation choice rather than a platform fact worth encoding in a
contract.

## Decision

**Code that writes to a database lives next to that database. A lock is never
held across a process boundary.**

An application's SQLite handle has three verbs and no transaction callback:

```ts
const mail = await epicenter.openSqlite('mail');

// READ anything you like. no lock involved.
const inbox = await mail.all(
  'SELECT id, subject FROM messages WHERE read = 0 ORDER BY at DESC LIMIT 50'
);

// ONE write. SQLite wraps a bare statement in its own transaction,
// so this is already atomic by itself.
await mail.run('UPDATE messages SET read = 1 WHERE id = ?', [id]);

// MANY writes, all-or-nothing.
await mail.batch([
  { sql: 'UPDATE messages SET read = 1 WHERE id = ?', params: [id] },
  { sql: 'UPDATE _meta SET v = ? WHERE k = ?', params: [now, 'touched'] },
]);
// -> { changes: [1, 1] }

// there is no mail.transaction(). see above.
```

`batch` is the primitive; `run` is a batch of one, and SQLite already wraps a
bare statement in an implicit transaction, so nothing is added by naming it
separately. `batch` returns per-statement change counts, not rows: rows come
from `all`.

**The transaction still exists. It stops crossing the boundary.**

```txt
  THE PAGE                      THE OWNER
  batch([a, b, c]) ---------->  BEGIN   [locked]
                                  a
                                  b        local, microseconds
                                  c
                                COMMIT  [open]
                   <----------  { changes: [...] }
```

Both runtimes already provide a synchronous transaction callback where the
database is, so neither emulates anything:

```txt
  Tauri WebView                  standalone browser
  HTTP -> the Bun sidecar        postMessage -> a worker
  bun:sqlite, a real file        sqlite-wasm over OPFS
```

The desktop file stays at ADR-0304's address, so a person, the CLI, an MCP
server, and a coding agent can all point `sqlite3` at the same bytes the
application is using.

**Work that must read, think, and write atomically is a verb on the owner, not
a query from the page.** Local Mail's `applyHistoryBatch` reads a row, parses
its JSON in JavaScript, compares two label sets, and writes, all inside one
lock. That is not expressible as a list of statements and must not be forced
into one. It stays in `db.ts`, in the process that owns the file.

**The three roles are fixed.** Rust owns windows and touches no database. Bun
owns files, locks, and SQLite. The WebView owns pixels and asks for things.

```txt
  Tauri (Rust) ....... a shell. windows, menus, tray. NO DATABASE.
   |
   +-- WebView ....... the UI. asks for things. holds no lock.
   |     mail.all(...) / mail.run(...) / mail.batch([...])
   |            |
   |          HTTP
   |            v
   +-- Bun sidecar ... the backend. owns files, locks, SQLite.
         bun:sqlite  [locked] ---- ~/.../mail.sqlite
                                         ^
                    sqlite3 ------------ |
                    the CLI ------------ |  the same bytes,
                    MCP ---------------- |  one mailbox
                    a coding agent ----- +
```

## Consequences

- No `transaction` verb, so there is no lease, no timeout, no orphaned lock, and
  no question of whether a caller's transaction is still alive.
- No `close()` on the handle. The connection's lifetime belongs to the process
  that opened it, which is never the page.
- Application code is identical in both runtimes and does not learn which
  binding it received. That satisfies ADR-0181 by having one shape rather than
  by reporting a difference as a typed failure.
- `bun:sqlite` and sqlite-wasm both keep their synchronous transaction
  callbacks, used by the owner. `@epicenter/sqlite`'s synchronous
  `SqliteDatabase` is what an owner holds; the three verbs above are what a page
  is handed. They are different contracts for different sides of a boundary.
- **The page can send arbitrary SQL to the owner, and this is accepted.** A
  cross-site scripting bug in an application's own SPA becomes arbitrary SQL
  against that application's own database. It is the same authority the
  application already has over its own file, this is source a person downloaded
  and chose to run, and the alternative is a fixed statement allowlist that
  would make the ad-hoc query surface useless.
- Local Mail's SPA reaches its engine, which keeps the file and does the
  transactional work, exactly as ADR-0305 already implies and as Local Books
  already runs.
- A single-page application with no engine still gets the same three verbs over
  a worker, and its writes are single statements or batches like anyone else's.

## Considered alternatives

- **A synchronous handle (ADR-0308).** Refuted by measurement: Tauri IPC has no
  blocking path, so the desktop arm cannot honor it.
- **An asynchronous `transaction(cb)` (ADR-0303).** Rejected because the
  callback runs where the caller is and the lock is taken where the data is,
  which is the failure this record is named after.
- **A lease and a timeout on an interactive transaction.** Rejected as the
  machinery the refusal exists to delete, and it still costs a round trip per
  statement.
- **Rewriting read-think-write logic as SQL** (`json_set`, set comparison in
  SQL) so a batch could carry it. Rejected: it trades readable application logic
  for SQL strings, and the logic already has a correct home.
- **sqlite-wasm over OPFS on the desktop too**, giving one synchronous engine
  everywhere. Rejected because Local Mail already ships a file-backed Bun engine
  with CLI and MCP access, so a second copy in a WebView partition would mean
  two mailboxes, two full pulls, and two metered quotas for one account.
