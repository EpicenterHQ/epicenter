# 0494. File-folder queries use transient captured projections

- **Status:** Superseded
- **Date:** 2026-10-03
- **Superseded by:** [ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md): `.epicenter/` is reserved for unfinished writes only, and one layout module per language owns it.
- **Relates:** [ADR-0436](0436-stores-own-local-sqlite-namespaces.md) defines current store-owned SQL; [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) separates authored files from application SQL; [ADR-0463](0463-queryable-exports-contain-completed-sqlite-snapshots.md) records the deferred query export proposal. [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) supplies the first caller: queries over a data folder inside a host repository.
- **Unbuilt:** browser folder query sessions, the capture contract, managed-folder ignore initialization and file-first Mail resource composition. Persistent folder caches and their locations are deferred, not implementation tasks.

## Context

A file-authoritative folder saves Markdown rows, `kv.json`, and attachments.
SQL can query an interpretation of those files without becoming their saved
representation. No generic file-folder query caller or SQL export generator
is implemented. The existing synthetic index benchmark measures a Yjs walk
and Bun SQLite insertion, not file capture, Markdown parsing, browser SQL,
or peak memory in a folder containing recordings.

The earlier `.epicenter/cache/` and `.epicenter/state/` proposal put unrelated
lifetimes under an authored folder. A later `.epicenter/query.sqlite3` cache
removed pending work from that tree but still selected a persistent location
before any caller demonstrated a need. It required source exclusions,
cache validation, publication, and legacy adoption rules for an unbuilt cache.
The root `index.sqlite3` exclusion has since been removed from the folder engine.

The removed Yjs checkout used `.epicenter/manifest.json` as its reconciliation
baseline. Existing files are left on disk; the new design assigns them no cache
meaning or execution behavior. ADR-0501 records the removal.

## Decision

**Folder queries start with transient in-memory projections. No new `.epicenter/` directory, reserved subtree, or live database filename is part of this design.**

A query captures selected source and its definition interpretation, builds an
in-memory SQLite projection, executes, and releases its resources. An explicit
query session may execute several queries against the same immutable projection
until refresh or closure. It amortizes capture, parsing, and insertion without
adding durable cache ownership. It never claims that live files remain unchanged.

Refresh builds a replacement capture and projection. In-flight queries retain
their original capture. A failed refresh reports failure and preserves the
previous usable session; it does not relabel old results as fresh. Closing the
session or its folder ends admission and releases its engine after admitted
operations settle. Queries after closure refuse. Change hints may mark a
session stale, but cannot prove freshness or trigger a promised continuous rebuild.

The session owns its transient engine separately from app/account SQL. It does
not borrow Mail's durable databases, acquire its execution claims, or require
its OPFS pool. Read-only execution must restrict access to the projected tables
and support cancellation and bounded results. The exact engine integration,
public API, and projection schema require a concrete caller before implementation.

**Capture reports what it read and what it could not read.**

Read only the bytes needed to interpret selected rows and settings. Media
listing does not require loading recording bytes into SQLite or memory. Do not
reuse a whole-folder Git capture that loads every attachment merely to query
text. Size or memory limits refuse with an explicit result rather than silently
truncating the selected source.

Projected source carries literal paths and hashes of the bytes actually read.
Use the folder's interpretation rules rather than introducing a competing
parser. Report unreadable or disappearing files, parse failures, and conformance
issues. The malformed-row representation remains a projection-schema decision;
silently dropping rows does not produce a complete result. Listed media metadata
must not claim a content hash when its bytes were not read.

Capture orders admitted owner operations but does not freeze external desktop
editors. Browser enumeration and later reads may also use separate transactions.
Neither runtime promises an atomic whole-folder observation without a separately
verified capture contract. Writes based on results retain conditional saves
against their source baselines. Query failure never changes authored files or
undoes a successful save.

**Persistent caching is deferred, including its location and filename.**

A concrete consumer and end-to-end measurements must establish the benefit over
retaining a projection in memory. Measure enumeration, reads, parsing, SQL
construction, repeated queries, and peak memory on native files and browser
IndexedDB source. A synthetic Yjs or insertion-only benchmark cannot settle this.

The first caller is a command that answers one SQL query over a data folder
inside a host repository (ADR-0517) and builds its projection on every call. On
2026-10-11, reading 2,615 Markdown pages (9.6 MB) from a native directory,
parsing each with `parseRow`, and inserting them into in-memory Bun SQLite took
about 0.2 seconds on an Apple silicon Mac. That measures one cold native call,
not repeated queries, peak memory, or browser source. At that size a rebuild
per query needs no persistent file.

A later decision must select cache ownership, placement, validation, publication,
and recovery together. There is no current commitment to a folder-local file,
AppData location, OPFS pool, IndexedDB object store, or separate cache database.
Before any cache writes bytes, its owner must keep those bytes outside authored
enumeration, capture, history, transfer, and change notifications. A Git ignore
entry alone cannot enforce that separation. Cache loss, corruption, or failed
publication must not prevent querying readable source.

**Application/account working state stays outside authored folders.**

Mail's durable `local` database holds connected accounts, pending edits,
revision counters, and delivery reports. Its `mail-<sub>` databases hold
provider mirrors and checkpoints. Their captured app/account runtime owns
migration, reset, and delivery. Selecting another saved-query folder does not
select another mailbox or outbox. Current native SQL stays in AppData and
browser SQL stays in OPFS; these paths do not change through this decision.

File-first composition must acquire the source folder and app/account SQL under
one captured account. Replacing borrowed `personal.sqlite` acquisition remains
unbuilt. Do not retain an empty Yjs store solely to acquire SQL or manufacture
a source folder for SQL-only work. No generic `folder.sqlite` capability is added.

```text
selected Mail source folder/
  kv.json
  savedQueries/query1.md
  .gitignore

query session/                       memory only; no saved directory
  captured interpretation
  transient SQLite projection

captured app/account SQL namespace/  AppData on desktop, OPFS in browser
  local.sqlite                       existing retained state and pending work
  mail-<google-sub>.sqlite            existing mailbox and checkpoints

```

SQLite query export is deferred under ADR-0463. It is not part of the query
session lifecycle or an implementation task.

**New application-managed SQLite files use `.sqlite3`; managed folders ignore SQLite and its companions by default.**

Managed creation writes these proposed defaults as source. Ordinary opening
never rewrites an existing `.gitignore`. Applying defaults to an existing folder
is explicit and preserves user rules and exceptions. Initialization is unbuilt.
No `.epicenter/` ignore entry is added by this decision.

```gitignore
*.sqlite
*.sqlite3
*.sqlite-wal
*.sqlite-shm
*.sqlite-journal
*.sqlite3-wal
*.sqlite3-shm
*.sqlite3-journal
```

`.sqlite` covers existing files. `.db` is neither the new convention nor a blanket
exclusion. Intentional SQLite datasets can use an explicit ignore exception.
Tracked files remain tracked until explicitly removed from inclusion. Ignore
rules affect Git inclusion, not source readability, backup selection, deletion
safety, or execution of imported pending work. Renaming extensions is not migration.

**No manifest or legacy store checkout is part of file-authoritative folders.**

ADR-0501 removes the old store Pull/Push workflow, baseline, and host route.
Existing `.epicenter/manifest.json` files are left untouched and have no active
checkout reader or writer. This decision adds no path exclusion or permission
to delete a directory by name. Adopting selected existing files does not restart
the old workflow or reinterpret its manifest as a query cache.

## Consequences

Folder queries need no persistent database, cache-address registry, cache
migration, reserved-path enforcement, watcher, or background projector. Related
queries can reuse a captured projection, and fresh sessions pay capture and
projection costs. Large collections may later justify persistence; that benefit
has not been established for actual file-folder queries.

Authored folders require no new `.epicenter/` subtree. Their current files remain
readable and portable. SQLite query export is deferred; there is no external
SQL file contract.

A Mail source-folder copy does not back up its offline mailbox or pending triage.
Those databases need separate backup and safe activation after restore. Mirror
reset cannot recover provider-deleted mail or pending actions. Atomic assertion,
revision-checked retirement, and execution ownership remain Mail requirements.

## Considered alternatives

- Reserve `.epicenter/query.sqlite3` now: preselects a cache owner and location
  without a consumer or measurements. It adds exclusions and adoption work and
  would reinterpret existing manifest files. A later measured cache may choose
  folder-local placement under a new, explicit contract.
- Persist an app-owned folder index with fingerprints: adds database naming,
  scope alignment, schema changes, and erasure. Native size and modification
  time cannot prove unchanged bytes; hashing still pays the source-read cost.
  Defer it until avoiding parsing and insertion has a measured benefit.
- Rebuild for every statement: avoids session ownership but repeats capture and
  construction and gives related queries different source images. Allow an
  explicitly owned in-memory session instead.
- Put pending work under `.epicenter/state/` or private Git state: copies or
  history resets can duplicate or destroy the only undelivered user intent.
- Require a root `index.sqlite3`: adds a discovery promise and source exception
  without a caller. SQL export also remains deferred until a consumer needs it.
