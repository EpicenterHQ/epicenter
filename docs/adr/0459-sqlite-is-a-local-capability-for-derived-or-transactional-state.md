# 0459. SQLite is a local capability for derived or transactional state

- **Status:** Proposed
- **Date:** 2026-09-29
- **Relates:** [ADR-0450](0450-current-files-own-portable-document-data.md) proposes authoritative document files; [ADR-0436](0436-stores-own-local-sqlite-namespaces.md) defines current SQL acquisition and account scoping.
- **Unbuilt:** file-backed tables and KV as the default application store, rebuildable indexes over those files, and consumer migration to this storage-selection rule.

## Context

A data folder contains tables of Markdown rows,
root `kv.json`, and ordinary media files. An application, editor, or agent
can work on the same saved data. Device-only preferences benefit from this
interface even when nobody intends to synchronize them. A pending-work table
can use it too; the application decides whether creating a row submits work.

SQLite supplies a different interface and stronger local transaction machinery.
Calling it the home of "application work" would give ordinary settings and
records a reason to leave data folders without identifying a requirement. Calling
every SQLite database disposable would lose pending user work.

<!-- doc-path-check: ignore-next-line -->
Local Mail demonstrates both uses. `apps/local-mail/src/storage.ts` separates
the downloaded `mail-<sub>` database from the durable `local` database.
Gmail owns the current mailbox facts. The local outbox owns changes Gmail has
<!-- doc-path-check: ignore-next-line -->
not yet confirmed. `apps/local-mail/src/intent-store.ts` reserves revisions and
saves assertions in one transaction, then retires only the revision a delivery
confirmed.

The current `packages/app/src/open-store.ts` still opens Yjs-backed stores with
borrowed `store.sqlite` access. The file-first application store remains unbuilt.

## Decision

**Epicenter-authored application data uses data folders by default, whether local-only or synchronized.**

Tables contain Markdown rows; `kv.json` contains settings. Media remains ordinary
file content. An application may place related files beside a row, but matching
stems do not establish ownership or authorize cascade deletion. For example:

```text
so.epicenter.whispering/
  kv.json
  recordings/
    r123.md
    r123.opus
    r124.md
```

The files own the saved values. A private database is not required to recover
those values from a complete data folder. Being local, structured, temporary, or
operational does not by itself justify a different saved representation.
Credentials remain outside data folders in the existing secrets capability.

**Application-facing SQLite is an escape hatch for derived storage or justified local transactions.**

| Use | Authority | Recovery |
| --- | --- | --- |
| Search or query index over a data folder | Markdown rows, `kv.json`, and attachments | Rebuild from the current files |
| Provider mirror, such as downloaded Gmail messages | The provider | Re-fetch the provider's currently available state |
| Transactional state, such as pending Mail edits | The local database until the work is resolved | Retain committed state; it cannot be reconstructed from the mirror |

Every derived database names its source and rebuild procedure. A large authored
collection can use an in-memory projection or a measured persistent cache while
its files remain authoritative.
Rebuilding a provider mirror requires provider access and does not recover mail
the provider no longer retains.

Every authoritative SQL use names the local invariant the data folder implementation
does not adequately provide. Examples are committing related records together
or atomically retiring an unchanged request revision. "Needs transactions" alone
is insufficient. The application also defines retention, migrations, recovery,
and explicit deletion for those durable bytes. A search index may use SQL
transactions internally without becoming authoritative.

**Private application databases stay device-local, and application-managed SQLite files do not participate in Epicenter data folder synchronization.**

Account scoping selects local ownership; it does not synchronize the database.
Private database files and their WAL/journal companions do not enter data folder sync.
[ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md)
proposes one native app/account address shared by standalone and hosted shells,
with cross-process admission. [ADR-0497](0497-browser-folders-use-scoped-opfs-directories.md)
stores browser authored folders in scoped OPFS directories, copied once from
their earlier IndexedDB databases, and keeps private OPFS SQL in a separate
namespace with captured channel and account addresses. Native address changes
require implementation and preserving migration before current storage paths
change.
Provider mirrors and retained transactional databases stay with the app/account
runtime outside authored folders. Current native databases use AppData; browser
databases use OPFS. Folder queries use transient in-memory projections under
[ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md).
No new `.epicenter/` cache subtree is reserved. Persistent caching and placement
are deferred on both runtimes until a caller and end-to-end measurements justify
them. Any future cache must remain outside authored capture and transfer; a
`.gitignore` entry alone does not establish that boundary.

SQLite query export is deferred under
[ADR-0463](0463-queryable-exports-contain-completed-sqlite-snapshots.md).
Internal querying reserves no filename or destination and introduces no exporter.
An intentionally saved SQLite dataset can remain an authored attachment; its
format alone does not make it an application cache.

This is Epicenter's contract, not a claim that SQLite can never be replicated.
A local transaction supplies no cross-device commit or ordering guarantee.
Data that must converge between devices needs an explicit synchronization
design; choosing SQL does not supply one. Backup is a separate recovery operation.
The rule covers application-facing SQL, not the internal byte storage of a
platform adapter.

**Mail keeps durable pending edits separate from its rebuildable mailbox mirror.**

Keep `label_intents` and `intent_counters` in the durable `local` database.
Preserve atomic revision allocation and assertion, revision-checked retirement,
and one coordinated delivery owner per outbox. Resetting `mail-<sub>` must leave
pending edits intact. Store portable authored searches, notes, or rules in
data folders as those features use the file-first model.

The executor commits pending intent before calling Gmail. After confirmation it
updates the mirror and retires only matching intent. These steps are recoverable
operations, not one transaction spanning SQLite and Gmail. Retries and stale
responses remain application concerns. Independent clients do not acquire a
global delivery order by using SQLite.

## Execution

1. Adopt the data folder table/KV engine with current files as authority. Prove
   that editing a device preference in `kv.json` while the app is closed is
   observed on reopening. Table operations affect only the selected Markdown
   row; media operations use explicit file paths.
2. Add captured in-memory query projections where consumers need SQL. Several
   queries may share one immutable capture. Add persistent reuse only when
   measurements justify it. Verify equivalent results after rebuilding, with
   source files preserved and readable even when optional cache storage fails.
3. Classify application SQL consumers by the table above. Keep Mail's existing
   mirror/outbox separation. Move ordinary authored records and settings into
   data folders as their consumers migrate; locality alone cannot exempt them.
4. Verify that account-scoped SQL is excluded from data folder sync and that mirror
   reset preserves pending edits. Retain Mail's archive/undo race coverage and
   exercise restart recovery after durable assertion and after provider success
   before local retirement.

Public opener names and lifetime ownership are a separate API decision. Current
`openLocal`, `openPersonal`, and borrowed `store.sqlite` remain the implemented
surface; selecting these storage roles does not introduce an `openSqlite` export
or relocate existing data.

## Consequences

Most applications use one editable table/KV model for local and synchronized
data. SQLite remains available without making every application maintain a
second authoritative representation of its records.

An authored-folder copy includes its selected authored data and attachment bytes.
No directory is omitted merely because it is named `.epicenter`; old
manifest files remain on disk after the store checkout workflow is removed. Mail's app/account
databases require a separate backup. Erasing the pending-work database loses undelivered work.
Copying or restoring those obligations does not authorize execution; transfer
or restore needs an explicit activation contract regardless of database location.

File editing, conflict handling, and save publication still need defined
behavior. A SQL index cannot repair missing guarantees in authoritative file
writes. Likewise, SQL transactions cannot make provider calls atomic with local
commits.

## Considered alternatives

- Put all local state in SQLite. Device-only settings lose the common file
  interface even when they require no transactional exception.
- Store every dataset in Markdown. Large provider mirrors incur file management
  costs without making those files the provider's authority; transactional
  workflows must recreate guarantees already supplied by SQLite.
- Treat every SQL database as a cache. Resetting it can destroy undelivered
  user intent.
- Switch authored data to SQL at a row-count threshold. Growth silently changes
  the saved format and removes direct file editing; an index preserves both.
- Synchronize private SQLite files with data folders. File replication does not
  establish shared transaction ordering or safe ownership of executable work.
