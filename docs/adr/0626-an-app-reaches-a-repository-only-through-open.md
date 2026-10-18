# 0626. An app reaches a repository only through open

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, and its schemas check what it reads and refuse no write; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at "The library resolves paths and lists folders" and "`openFolder` refuses an `id` that names no directory": the library has no `resolve` or `listFolders`, and `open` returns `undefined` when this origin holds no grant; [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) at "One opened data folder exposes `tables`, `kv`, `files`, and `git`": a repository exposes `tables` and `files`, `files` writes only text, and `kv` and `git` leave the app API.
- **Relates:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (tables and rows), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (grants and consent), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text only), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge, and every save), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the clone behind `open`), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the four words).
- **Unbuilt:** all of it: `open`, `connect`, `newId`, `subscribe`, the table methods, a row's `version`, and the repository's and each table's `files` in `@epicenter/data`.

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
open({ id?, tables }): Promise<Repository | undefined>                     v1
    undefined: this origin holds no grant. Never waits on the network.
    no id: the origin's most recently consented grant.
    offline before any clone exists: resolves with status 'pending'; list() shows
    local rows, and the server's rows arrive through subscribe.
connect({ id?, name? }): Promise<never>                                     v1
    first consent and reconnect: navigates to consent; name suggests a repository.
newId(): string                                                             v1
    lowercase, time-sortable, one filename segment.

Repository
  id                                                                        v1
  name               the label as of the last fetch                         later
  status             'synced' | 'pending' | 'disconnected' | 'stuck'        v1
  subscribe(listener)  the event carries status, the changed rows, each
                       by table and id, and the changed paths; returns
                       an unsubscribe                                       v1
  close()                                                                   v1
  tables.<t>         one Table per name in tables                           v1
  files              list(prefix?) · read(path): Blob | undefined ·
                     write(path, text) · delete(path)                       v1
                     text only; path is relative to the repository's root,
                     may contain '/', and may name any file, a table's rows
                     and its table.json included

Table
  list()             every row, sorted by id                                v1
  get(id)            one row, or undefined                                  v1
  set(id, { fields?, body?, version? })                                     v1
                     creates a missing row; a field set to undefined is removed;
                     one merge of the whole file, with version as its base
  delete(id)         removes the row and its folder <id>/                   v1
  files(id)          the repository's files with <t>/<id>/ as their root   v1
  rename(id, next)                                                          later

Row  { id, version, ok: true,  fields, body }    fields typed by the app's schema
   | { id, version, ok: false, fields, body }    fields raw; unparseable frontmatter
                                                 gives fields {} and body the raw text
```

**`tables` maps each table name to the app's JSON Schema for its rows**,
written with TypeBox or as a literal `as const` schema, and a row's type is
its `Static`. A row that fits comes back `ok` with typed fields; one that
does not comes back with its raw fields, never dropped. The app's schema is
the only one it reads rows with, and no save reads a table's `table.json`:
a save keeps the file's key order and appends new keys alphabetically
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**A row's `version` is opaque: the blob id the row was read at.** Every
`set` is one merge of the whole file,
`merge(path, { base: version ?? current, current, change })`
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
Given `version`, two tabs editing different paragraphs or different fields
both keep their edits; without it, the save's fields and body win every
unit they change.

**Only these throw:**

```txt
an id that is not one filename segment
a path with an empty, '.', '..', or '.git' segment, or a leading '/'
a new id or path that differs from an existing one only by case
content that is not text (ADR-0621)
a storage failure, or a call on a closed repository
```

Everything else is a `status` or an `ok: false` row. No write is refused
for not fitting a schema: the only refusals are a non-text write from the
library, a push that would rewrite history, and what Git cannot represent
([ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md)).
The case rule keeps a disk clone on a file system that folds case from
holding two paths as one file.

**`files` reaches every path, and a row is a file.** A write through
`files` is one merge of the whole file with the file's current blob as its
base, as a `set` without `version` is
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
Writing `<t>/<id>.md` saves that row, and a row whose frontmatter does not
parse comes back `ok: false`. `open` and `set` never write a `table.json`;
an app that writes one through `files` authors it, as a person or an agent
does
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**One subscription per repository.** `subscribe` reports the status, the
rows that changed, by table and id, and the paths that changed; no table
has a subscription of its own.

**The app API has no `create`, no sync, commit, or history, no list of
issues, and no revoking of a grant.** A table named in `tables` that the
repository lacks lists no rows; the first `set` in it writes
`<t>/<id>.md`, and the directory is a table to `check` and `query` once
someone writes its `table.json`. A grant is
revoked on the consent page
([ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)).

## Consequences

- An app with no grant gets `undefined` and decides when to call `connect`;
  nothing navigates on its own.
- An app opens offline and shows what its clone holds; a first open with no
  clone shows nothing until the server's rows arrive.
- An app whose schema lags the repository's rows keeps working: it sees
  those rows raw and can still set fields on them.
- A field the app does not name in `set` keeps what the file holds, so two
  apps setting different fields of one row never undo each other.
- Opening a repository writes no file into it, so two clones that open
  one repository never race to describe a table.
- An app reads and writes any path of a repository it holds a grant for,
  such as `docs/` or another app's table, as an agent can.
- A malformed row an app writes through `files` is an `ok: false` row and
  a `check` line; a `table.json` it overwrites is a commit in history that
  a revert repairs.
- A file reads as a `Blob`, so Git LFS files later need no change to
  `read`.

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
- **A subscription per table.** An app watching three tables holds three
  listeners for one sync's changes.
- **A save whose body always replaces.** Two tabs editing different
  paragraphs of one row lose one tab's edit.
- **Files only inside a row's folder.** An app cannot read or write the
  documents people and agents keep beside tables, and an app whose notes
  nest in directories cannot exist.
- **`files` refusing a table's directory or its `table.json`.** One path
  then has two rules, and the list of refusals grows to stop a mistake that
  history shows and a revert repairs.
