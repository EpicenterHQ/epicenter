# 0626. An app opens local data with its own schemas

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0636](0636-an-app-opens-local-files-through-one-folder-handle.md) at the public opening surface: `@epicenter/folder` exposes the planned `openFolder` and `Folder` contract, with selection supplied by the runtime independently of a remote. Local opening and caller migration are implemented; stored-data migration and app-facing sync remain separate work.
- **Amended by:** [ADR-0632](0632-a-lens-belongs-to-its-reader.md) at generic table discovery and description lifecycle: no description is required, and changing a selected schema preserves drafts and the open repository. [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at opening and identity: local data opens without a grant, has its own identity, and connects to a chosen remote later.
- **Amended by:** [ADR-0643](0643-the-folder-package-owns-its-local-engine.md) at the planned package boundary: `@epicenter/folder` owns the local engine and the finished tree has no `@epicenter/data` package.
- **Amends:** [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md) at "`openFolder({ definition })` (ADR-0586) validates every table read and write against `definition`" and "`openFolder({ id })` and `openFolder({ root, git })`": an app opens a repository with `open({ id?, tables })`, and its schemas check what it reads and refuse no write; [ADR-0608](0608-apps-never-talk-to-each-other-they-share-paths.md) at "The library resolves paths and lists folders" and "`openFolder` refuses an `id` that names no directory": the library has no `resolve` or `listFolders`, and `open` returns `undefined` when this origin holds no grant; [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) at "One opened data folder exposes `tables`, `kv`, `files`, and `git`": a repository exposes `tables` and `files`, `files` writes only text, and `kv` and `git` leave the app API.
- **Relates:** [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (tables and rows), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (grants and consent), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (text only), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge, and every save), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the clone behind `open`), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the four words).
- **Unbuilt:** public app-facing sync connection, hosted synchronization lifetime, and migration of existing browser data. Browser, Bun, and Tauri local opening and the migrated app callers now use the shared Folder contract.

- **Current edit implementation:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) records the retained-source model implemented in `bd78bfb52b`. Editors and direct file/table commands share each path's publication lane; local writes are unconditional whole-file last-write-wins. Git synchronization keeps its merge rules. Earlier draft-merge and guarded-save descriptions below are historical.

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

**The planned public open function selects local data independently of hosted access.**

The planned handle is over selected local data. Its local selection is
independent of any hosted repository ID in its optional sync destination.
The earlier planned `Repository` public type name is withdrawn: repository
names Git, while local editing can precede Git. The public handle name and
selection arguments remain undecided and require a separate API decision.
Public signatures remain unbuilt. Current applications use `openFolder`, and
the new engine exposes `openRepository` only internally. The opening and
connection lines describe responsibilities, not published call signatures.

```txt
open(local selection, tables)                                              planned
    opens existing local data or makes new local data without a grant or network.
    local selection is independent of account, remote URL, or hosted repository ID.
connect(chosen destination)                                                planned
    attaches existing local work to a remote; browser hosted sync obtains consent.
    exact public arguments remain unbuilt; a name can be suggested, never identity.
newId(): string                                                             v1
    lowercase, time-sortable, one filename segment.

Local data handle  (public type name and selection arguments remain undecided)
  local selection    reopens the same local work; no universal ID is required v1
  name               the connected repository label as of the last fetch                         later
  status             'local' | 'synced' | 'pending' | 'disconnected' | 'stuck'        v1
  subscribe(listener)  listener({ status, rows, paths }): rows maps each table
                       to the ids that changed, paths lists every path that
                       changed; returns an unsubscribe                      v1
  close()                                                                   v1
  tables.<t>         one Table per name in tables                           v1
  files              Files rooted in the opened local data         v1

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
                          name any file, table rows and schema files included

Row  { id, text, fields: Static<schema>,         body, issues: null }
   | { id, text, fields: Record<string, unknown>, body, issues: Issue[] }
     text is the file's exact source. issues says why fields are raw. Unparseable
     frontmatter gives fields {} and body the whole text; a file that is not UTF-8
     gives text and body '' and an issue saying so.
```

**`tables` maps each table name to a schema for row frontmatter.**
The app writes it with TypeBox or as a literal `as const` schema. Its typed
fields use the schema's `Static`. A row that fits has `issues: null` and typed
fields; one that does not comes back with its raw fields and the issues
that say why, never dropped. `issues` alone tells the two apart, as `error`
does in a Result. The app's schema is the only one it reads rows with, and
no save reads a schema file: a save keeps the file's key order and
appends new keys alphabetically
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**Every save names what its edit started from.** `from` is the row, or for
`files` the text, that the edit began with, and every save is one merge of
the whole file, `merge(path, { base: from, current, change })`
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)),
where `current` is what the local data holds now. A row's base is `from.text`,
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

**Every operation returns a Result, and only a call on a closed handle throws.**

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

No write is refused for not fitting a schema. The operation errors above
describe local saves; ADR-0621 owns the text-write boundary. Commit and
synchronization prerequisites are separate from local saves: ADR-0620 protects
history and ADR-0622 handles unresolved native Git content. ADR-0624 owns
synchronization state and the requirement for actionable recovery.
The case rule keeps a disk clone on a file system that folds case from
holding two paths as one file.

**`files` reaches every path, and a row is a file.** Writing `<t>/<id>.md`
through `files` saves that row, and a row whose frontmatter does not parse
comes back with issues. `open` and `set` publish no schema files. An app can
write ordinary JSON explicitly through `files`, as a person or an agent does
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

**One subscription per open local dataset.** `subscribe` reports the status, the
rows that changed, by table and id, and the paths that changed; no table
has a subscription of its own.

**The app API has no `create`, no sync, commit, or history, no list of
issues, and no revoking of a grant.** A table named in `tables` whose
directory is absent lists no rows; the first `set` in it writes
`<t>/<id>.md`. Generic CLI table views name that directory through an
root epicenter.json in v1. A grant is
revoked on the consent page
([ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md)).

## Consequences

- An app opens local data without a grant. Connecting a service is an
  explicit later action; opening data never navigates to consent.
- An app opens offline and shows its saved local data. Connecting a remote
  preserves that work and incorporates incoming files under ADR-0633.
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
- Opening local data publishes no schema file, so readers do not race to
  describe the tables they use.
- An app reads and writes paths within its opened local data,
  such as `docs/` or another app's table, as an agent can.
- A malformed row written through `files` retains its issues and source.
  Schema-based CLI checking reports applicable issues. Git recovery covers
  committed versions, not every overwritten intermediate save.
- A file reads as a `Blob`, so Git LFS files later need no change to
  `read`.

## Considered alternatives

- **`open` navigating to consent when there is no grant.** A page that only
  wanted to know whether it is connected would leave itself.
- **Writes validated against the app's schema.** An app one field behind
  another refuses rows the repository already holds.
- **`open` creating each table it names, with the app's schemas in a
  schema file.** An app becomes an author of schemas people and
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
- **`files` refusing a table's directory or a schema file.** One path
  then has two rules, and the list of refusals grows to stop a mistake that
  history shows and a revert repairs.
