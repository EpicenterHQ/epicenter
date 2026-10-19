# 0626. An app reaches a repository only through open

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at generic table discovery and description lifecycle: no description is required, and changing a reader lens preserves drafts and the open repository. [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at opening and identity: local data opens without a grant, has its own identity, and connects to a chosen remote later.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, and its schemas check what it reads and refuse no write; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at "The library resolves paths and lists folders" and "`openFolder` refuses an `id` that names no directory": the library has no `resolve` or `listFolders`, and `open` returns `undefined` when this origin holds no grant; [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) at "One opened data folder exposes `tables`, `kv`, `files`, and `git`": a repository exposes `tables` and `files`, `files` writes only text, and `kv` and `git` leave the app API.
- **Relates:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (tables and rows), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (grants and consent), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text only), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge, and every save), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the clone behind `open`), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the four words).
- **Unbuilt:** the public `open`, `connect`, `newId`, subscriptions, auth and synchronization lifetime, and application migration onto the internal local file and table operations in `@epicenter/data`.

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
  subscribe(listener)  listener({ status, rows, paths }): rows maps each table
                       to the ids that changed, paths lists every path that
                       changed; returns an unsubscribe                      v1
  close()                                                                   v1
  tables.<t>         one Table per name in tables                           v1
  files              Files with the repository's root as their root         v1

Table
  list()                  Result<Row[]>, sorted by id                       v1
  get(id)                 Result<Row | undefined>                           v1
  set(id, from, change)   Result<{ sent: Row }>                             v1
                          from: Row | null; change: { fields?, body? };
                          creates a missing row; a field set to undefined is removed
  delete(id, from)        Result<{ deleted: boolean }>                      v1
                          removes the row and its folder <id>/
  files(id)               Files with <t>/<id>/ as their root                v1
  rename(id, next)                                                          later

Files
  list(prefix?)           Result<string[]>, every path under prefix         v1
  read(path)              Result<{ path, content: Blob } | undefined>       v1
  write(path, from, text) Result<void>; from: string | null; text only      v1
  delete(path, from)      Result<{ deleted: boolean }>                      v1
                          a path is relative to the root, may contain '/', and may
                          name any file, a table's rows and its table.json included

Row  { id, text, fields: Static<schema>,         body, issues: null }
   | { id, text, fields: Record<string, unknown>, body, issues: Issue[] }
     text is the file's exact source. issues says why fields are raw. Unparseable
     frontmatter gives fields {} and body the whole text; a file that is not UTF-8
     gives text and body '' and an issue saying so.
```

**`tables` maps each table name to the app's JSON Schema for its rows**,
written with TypeBox or as a literal `as const` schema, and a row's type is
its `Static`. A row that fits comes back with `issues: null` and typed
fields; one that does not comes back with its raw fields and the issues
that say why, never dropped. `issues` alone tells the two apart, as `error`
does in a Result. The app's schema is the only one it reads rows with, and
no save reads a table's `table.json`: a save keeps the file's key order and
appends new keys alphabetically
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**Every save names what its edit started from.** `from` is the row, or for
`files` the text, that the edit began with, and every save is one merge of
the whole file, `merge(path, { base: from, current, change })`
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)),
where `current` is what the clone holds now. A row's base is `from.text`,
its exact source. A field or region only another writer changed keeps their
change: a thought the phone added while the laptop types survives the
laptop's next save. `from: null` means the file did not exist for this
edit, a create or a deliberate overwrite, and the save wins every unit it
changes. `set` returns `sent`, the row as this save sent it, which is the
`from` of the next save of the same draft; the row that lands can hold
another writer's change the draft never showed, and a draft based on it
would undo that change. A delete is a save of nothing: an edit made since
`from` beats it, and it returns `deleted: false`. A row and its folder
`<id>/` are deleted together or not at all.

**Every operation returns a Result, and only a call on a closed repository
throws.**

```txt
ReadError   StorageFailed
SaveError   InvalidId       an id that is not one filename segment
            InvalidPath     a path with an empty, '.', '..', or '.git' segment, or a leading '/'
            CaseTwin        a new id or path that differs from an existing one only by case
            NotText         content that is not text (ADR-0621)
            Unparseable     fields set on a row whose frontmatter does not parse; its text
                            is repaired through files
            StorageFailed
```

No write is refused for not fitting a schema: the only refusals are a
non-text write from the library, a push that would rewrite history, and
what Git cannot represent
([ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md)).
The case rule keeps a disk clone on a file system that folds case from
holding two paths as one file.

**`files` reaches every path, and a row is a file.** Writing `<t>/<id>.md`
through `files` saves that row, and a row whose frontmatter does not parse
comes back with issues. `open` and `set` never write a `table.json`; an app
that writes one through `files` authors it, as a person or an agent does
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
- An app keeps the row or text an edit started from and passes it to each
  save of that edit, advancing it to `sent`. Two tabs or two devices
  editing different fields or paragraphs of one row both keep their edits.
- A delete of a row someone edited since leaves the row and its folder in
  place, returns `deleted: false`, and the row stays in `list()`.
- An app handles a failed save as a value, as it handles any Result.
- Opening a repository writes no file into it, so two clones that open
  one repository never race to describe a table.
- An app reads and writes any path of a repository it holds a grant for,
  such as `docs/` or another app's table, as an agent can.
- A malformed row an app writes through `files` is a row with issues and
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
- **A save whose body always replaces, or that writes what the app holds
  now.** A draft that never showed the phone's new thought erases it at
  its next save, and the commit that records the loss names nothing.
- **A row's blob id as the base (`version`).** An id read from an unsent
  edit names bytes no store keeps once the next save replaces them, and an
  id of an old commit's blob names bytes the clone no longer keeps
  ([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md));
  keeping them takes a blob per save or memory in every tab.
- **The library remembering what each tab last read as the base.** After a
  sync the tab has read the copy with the phone's thought, so the draft's
  save still erases it.
- **`ok: true | false` on a row, or a Result per row.** `ok` reads as a
  Result's success flag though both kinds of row carry the row, and a Result
  per row puts a row that does not fit, which
  [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)
  accepts, inside an error.
- **Operations that throw.** An app catches a storage failure or a
  case-twin id that it would otherwise handle as a value.
- **Files only inside a row's folder.** An app cannot read or write the
  documents people and agents keep beside tables, and an app whose notes
  nest in directories cannot exist.
- **`files` refusing a table's directory or its `table.json`.** One path
  then has two rules, and the list of refusals grows to stop a mistake that
  history shows and a revert repairs.
