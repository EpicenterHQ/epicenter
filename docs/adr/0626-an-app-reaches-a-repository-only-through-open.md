# 0626. An app reaches a repository only through open

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, its schemas check what it reads, and every write is accepted; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at "The library resolves paths and lists folders" and "`openFolder` refuses an `id` that names no directory": the library has no `resolve` or `listFolders`, and `open` returns `undefined` when this origin holds no grant.
- **Relates:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (tables and rows), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (grants and consent), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text only), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the four words).
- **Unbuilt:** all of it: `open`, `connect`, and the table methods in `@epicenter/data`. Which repository `open` and `connect` take when no `id` is given and the origin holds several grants, and the methods that read and write a row's files, are not decided.

## Context

An app opens a data folder with `openFolder` (`packages/folder/src/index.ts`),
which picks the desktop or the browser adapter and validates every table
read and write against the app's definition
([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)).
A table offers `set`, `create`, `delete`, and `rename`, a refused write is a
`RowWriteError`, and the folder exposes Git and Sync to the app. The
library was also to resolve paths across folders and list them
([ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md)). An
app is now an ordinary client of one repository it holds a grant for
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md),
[ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)).

## Decision

**An app reaches a repository only through `open` from `@epicenter/data`.**

```txt
open({ id?, tables }): Promise<Repository | undefined>
    undefined when this origin holds no grant for the repository
connect({ id?, name? })
    the one handoff, for a first consent and for reconnecting;
    navigates to consent, and name suggests a repository
repo.tables.<t>.list()                    every row, async
repo.tables.<t>.get(id)                   one row, or undefined, async
repo.tables.<t>.set(id, fields, body?)    sets only the fields it names, and the body when given
repo.tables.<t>.delete(id)
row                                       { id, ok: true, fields, body }
                                          | { id, ok: false, fields, body }   fields raw: they do not fit the app's schema
repo.status                               'synced' | 'pending' | 'disconnected' | 'stuck'
```

`tables` maps each table name to the app's schema for it. A row that fits
comes back `ok` with typed fields; one that does not comes back with its raw
fields, never dropped. The app's schema is the only one it reads rows with;
a table's `table.json` only orders the keys a save writes
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**`open` creates no table, and nothing in the app API writes a
`table.json`.** A table named in `tables` that the repository lacks lists no
rows. The first `set` in it writes `<t>/<id>.md`, and the table stays
untyped until a person or an agent writes its `table.json`.

**`set` and `delete` are always accepted.** Neither checks a schema. A save
sets the named fields on the row as it is now; merging two versions happens
only at sync
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).

**A row's files in `<id>/` are text only in v1**
([ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md)).

**An app has no `sync`, no commit, and no Git.** It reads `status`, one of
the four words of
[ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md).

## Consequences

- An app with no grant gets `undefined` and decides when to call `connect`;
  nothing navigates on its own.
- An app whose schema lags the repository's rows keeps working: it sees
  those rows raw and can still set fields on them.
- A field the app does not name in `set` keeps what the file holds, so two
  apps setting different fields of one row never undo each other.
- Opening a repository writes no file into it, so two clones that open
  one repository never race to describe a table.

## Considered alternatives

- **`open` navigating to consent when there is no grant.** A page that only
  wanted to know whether it is connected would leave itself.
- **Writes validated against the app's schema.** An app one field behind
  another refuses rows the repository already holds.
- **`open` creating each table it names, with the app's schema as its
  `table.json`.** An app becomes an author of the description people and
  agents own, and two clones that open at once each write one.
- **A `sync()` in the app API.** Every app then schedules sync, and two
  apps on one origin race each other's schedule.
