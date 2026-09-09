# 0321. App-owned storage is named SQLite files an application opens and deletes, and nothing else

- **Status:** Accepted
- **Date:** 2026-09-01
- **Amended by:** [ADR-0381](0381-user-authored-sql-runs-through-a-bounded-read-only-operation.md) proposes adding restricted `query` beside the trusted SQL verbs; named file ownership and deletion remain.
- **Built.** `deleteSqlite` exists in both leaves and the host owner, and Local
  Mail is its first caller. The refusal of an app-owned key-value surface is
  built by not existing, and `cache_meta` and `intent_meta` are already the shape
  this record decides.
- **Amends:** [ADR-0312](0312-a-sqlite-handle-is-all-run-and-batch-and-a-transaction-never-crosses-a-process-boundary.md) at one refusal. It refuses a `close()` on the handle, because the connection's lifetime belongs to the process that opened it and never to the page. That refusal is narrowed rather than withdrawn: an application still cannot close a handle, and deleting a database closes it as part of deleting it. The three verbs, the absent transaction callback, and the process boundary all stand.
- **Relates:** [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (the surface this verb copies), [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md) (the first caller), and [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (why Epicenter Data is declared and this is not)

## Context

An application whose borrowed copy is one file per account needs a way to delete
one, and ADR-0312 says the owner holds every handle for the life of the
application, so unlinking behind the owner's back leaves a live connection
pointed at a path that no longer exists.

A reading of the same application says it is brute-forcing SQLite where a
key-value store belongs, because `cache_meta` and `intent_meta` are two columns
and a composite key. The reading is worth answering because Epicenter Data
declares `kv` beside `tables` and the app-owned side has no such thing, and
because both questions are really one question: what is the app-owned storage
surface, and what is not in it.

## Decision

**App-owned storage is named SQLite files an application opens and deletes.
That is the whole surface, and the delete verb completes it.**

**`epicenter.deleteSqlite(name)`, shaped exactly like `secrets.delete`.** No
list, because the application's own rows are the only thing that knows a name
exists. Deleting closes and evicts the owner's handle first, so the connection
never outlives the file. An application still cannot close a handle on its own,
because a close with no deletion is a lifecycle an application has no reason to
manage.

It sits beside `openSqlite(name)` rather than under a `sqlite` namespace,
because a namespace would rename the verb that ADR-0312, ADR-0316, and ADR-0319
each pin by name, to buy symmetry with `secrets`. "Shaped like `secrets.delete`"
is about the semantics: no enumeration, idempotent, and the thing that knows the
name is the application's own row.

**A handle held past a deletion is a name, not a connection, and what it does
next is the leaf's answer.** The browser leaf closes the connection, so every
later call on that handle fails. The desktop leaf's handle is a pair of strings
that the owner resolves per statement, so a later call opens the name again and
finds an empty database. Neither is wrong and one boundary cannot make them
agree: a message-per-statement handle has nothing to invalidate. What the
platform promises is that the file is gone and the owner holds no connection to
it. **An application that deletes a database drops what it built over it**,
which is a rule the application can keep and the platform cannot.

**The platform ships no app-owned key-value store, and none is missing.** Both
key-value shaped things this repository has are transaction participants:

```txt
  applyHistoryBatch  ->  batch([ ...row upserts, setMeta('history_id', next) ])
                         the cursor advances in the commit that earns it, so a
                         crash rolls back to the prior cursor and the next pass
                         re-reads. a separate store commits on its own, and the
                         cursor claims work that never landed.
```

`batch` is the only atomic unit and it is per-connection (ADR-0312), so a
key-value handle opened beside the tables cannot join the commit that gives it
meaning. Co-location is possible and is already how it is written: the
application's helper returns a statement rather than performing a write, so it
composes into the same array as the rows. That helper knows the table, the scope
column, and which transaction it is joining, all of which are application facts,
so it is seven lines in an application and cannot be a platform capability.

**`kv` names one thing, and it is Epicenter Data's.** A settings surface for
facts Epicenter is the authority for: small, subscribable, one value at a time,
never committed with a table. Transactional bookkeeping is a table in the file
whose commits it must join, and it is not called kv.

**App-owned SQLite stays undeclared.** ADR-0313's declaration exists because the
platform must understand a shape to synchronize, project, export, and admit it.
Nothing but the running application needs to understand its own SQLite, and a
declaration rich enough to express generated columns projecting a provider
resource, composite keys, and ordered covering indexes is SQL with extra steps,
while a poorer one forces an escape hatch and then the application maintains
both. Declared because the platform enforces meaning; undeclared because there is
no meaning to enforce.

## Consequences

- An application can delete a database it created, and only one it created,
  because the host resolves the path from the application id it already holds.
- The handle registry in `apps/epicenter/src/device.ts` gains its only
  removal path for a live handle, and it is deletion, so the registry is still
  not a cache. It already forgets an open that failed, which holds no handle.
- A borrowed copy's shape change is answered with this verb rather than with a
  compaction verb, so `VACUUM` never becomes a platform surface.
- An application that wants convenience over its own bookkeeping rows writes it,
  and the first two callers already have. A third caller hand-rolling the same
  helper is when to extract one, not before.
- An application issues `openSqlite` and `deleteSqlite` for one name in
  sequence, never concurrently. The owner holds one connection per name and an
  open arriving mid-deletion would recreate the file the deletion is unlinking.

## Considered alternatives

- **`epicenter.openKv(name)`.** Rejected. It is a second connection, so it
  manufactures the crash-consistency failure above for both existing callers and
  serves no caller that does not have it.
- **A declared app store with `kv` and `tables`, mirroring `defineData`.**
  Rejected. It is a transcription with no reader, and SQLite files already
  describe their own schema to anyone who opens one.
- **A `close` verb beside the delete.** Rejected. Nothing an application does
  needs a closed handle it can still name.
