# Nested tables

**Date**: 2026-10-17
**Status**: Draft
**Owner**: Braden
**Branch**: `claude/nested-tables-spec`
**Relates**: ADR-0584 (the noun set, on `origin/claude/nouns-p0`), ADR-0576 (one write, one move), ADR-0503 (repairable states), ADR-0457 (a row is addressed by its stem), ADR-0480 (tables own only their row files), ADR-0583 (one opener)

## One sentence

A table may declare `nested`, so its rows live at any depth under the table's
directory, a row's stem becomes its path inside the table, and a directory
there is a real group that a row moves into with one `table.move`.

## Summary and recommendation

Honeycrisp groups notes the way a database would: a `folders` table and a
`notes.folderId` field. On disk every note sits flat in `notes/`, so the
grouping a person sees in the app is invisible in Finder, in Git, and to an
agent, and every reference can dangle. Apple Notes groups notes in nested
folders, and Obsidian and a plain file system group them by directory.
**Recommendation: option (b), nested rows in one table.** A table opts in with
`nested`; a group is a directory under the table; moving a note between groups
is one `folder.move`, which Git records as a rename and Sync already follows;
an empty group survives Sync through a hidden `.directory.md` file that also
holds the group's fields. Records (todos, recordings, runs) stay flat; nothing
changes for a table that does not opt in. The costs are real: `stem` widens
from one filename segment to a table-relative path, and renaming a group moves
every file under it one at a time. Two Sync cases merge worse than today's
field-based grouping, which merges both by field. A group renamed on one device
while a note is added to it on another leaves the note in a bare group under
the old name, visible and one move to repair. A note moved and then edited on
one device while edited on another keeps the other device's edit only in
history, as a flat rename does today. The spec accepts both under ADR-0503 and
defers the merge rules that would remove them.

```txt
Read first:          Summary, API sketch, Disk format, Open questions
Read for the engine: Sync and merge, Engine changes, Phased plan
Read for Honeycrisp: Honeycrisp migration
```

## API sketch

Every name follows ADR-0584 as it will stand after P1 to P10: `table.move`
(was `rename`), absence is `null`, `ReadError` and `WriteError` per verb,
`FieldsOf` (was `CreateRowOf`), `folder.isOwn`, and `queries` for the query
layer (was `folder$`).

### Declaring a nested table

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  title: 'Honeycrisp',
  tables: {
    notes: defineTable({
      fields: {
        title: field.string(),
        pinned: field.boolean(),
        createdAt: field.instant(),
        deletedAt: field.nullable(field.instant()),
      },
      // Rows may live in directories under notes/. Each directory may hold
      // these fields in notes/<directory>/.directory.md.
      nested: { fields: { icon: field.optional(field.string()) } },
    }),
  },
});
```

`nested: true` declares a nested table whose directories hold no fields.
`nested: { fields }` also declares the directory fields. Every directory field
must be `field.optional`, as every `settings` field must be (`definition.ts`,
`TableUnder`): a directory someone made in Finder has no `.directory.md`, and
it must still read as a directory with every field unset.

### Rows

```ts
const { data: folder, error } = await openFolder({ app: 'so.epicenter.honeycrisp', definition });
if (error !== null) return show(error.message);
const notes = folder.tables.notes;

await notes.list();                              // every row in the tree: { stem: 'Work/Ideas/plan', result }[]
await notes.children('Work');                    // rows directly in notes/Work; '' is the top level
await notes.get('Work/Ideas/plan');              // StoredRow | null
await notes.create(row, { directory: 'Work' });  // a generated name in notes/Work
await notes.create(row, { stem: 'Work/plan' });  // or a chosen one
await notes.set('Work/plan', { pinned: true });
await notes.move('Work/plan', 'Home/plan');      // one folder.move: a Git rename
await notes.delete('Home/plan');
notes.stemOf('notes/Work/plan.md');              // 'Work/plan'; null for a path that is no row
```

`list` and `children` mirror `files.list()` (the whole folder) and
`files.children(directory)` (one level) on the folder handle. `list` reads and
parses every row in the tree, which is what "All Notes", `epicenter check`, and
the SQL projection need. `children` reads one directory's rows, so a view of
one group in a large table does not read every note.

### Directories

```ts
await notes.directories.list();                  // every directory in the tree:
                                                 // { directory: 'Work/Ideas', result: Result<StoredRow<{ icon? }> | null, ReadError> }[]
await notes.directories.get('Work');             // StoredRow | null: null for a directory with no .directory.md
await notes.directories.create('Work/Ideas', { icon: 'lightbulb' }); // writes notes/Work/Ideas/.directory.md
await notes.directories.set('Work', { icon: 'briefcase' });
await notes.directories.move('Work', 'Projects');  // every file under it, one folder.move each
await notes.directories.delete('Projects');        // NotEmpty while a row or other file is under it
```

A directory is addressed by its path inside the table, `'Work/Ideas'`; the
top level is `''`. The verbs are the row verbs: `create` writes the
`.directory.md` file from nothing and makes the parents; `set` sets fields of a
`.directory.md` that is there and writes nothing when there is none, as a row
`set` does; `move` and `delete` are below.

`directories.move(directory, next)` moves the `.directory.md` first, then
every other file under `directory`, rows, other files, and subdirectories
alike, each with one `folder.move` to the same relative path under `next`,
then removes the directories it emptied. It is not one step. It stops at the
first failure and returns it; what moved stays moved, and both directories
show, each with what it holds. Running it again moves what is left, so a
person repairs a stopped move by doing it again. Moving a directory into itself
or under itself is `InvalidPath`. A file already at a destination path is that
move's `Occupied`. The engine does not refuse a `next` that already exists, so
a rerun can finish; an app that wants to refuse merging two groups checks
`directories.get(next)` and `children(next)` first.

`directories.delete(directory)` removes every `.directory.md` under
`directory` and the directories that leaves empty, deepest first. While any
other file is under it, it writes nothing and fails `NotEmpty`, a new
`WriteError` member naming the first paths that remain. The caller moves or
deletes the rows first, each a visible write. A row another writer adds
between the check and the last `rmdir` makes that `rmdir` fail; the directory
stays, holding the row, with no fields.

### Queries

```ts
const queries = folderQueries(folder);  // ADR-0584 names the handle `queries`; the constructor's name lands with P1 to P10
createQuery(() => queries.notes.list.queryOptions());               // All Notes
createQuery(() => queries.notes.children.queryOptions('Work'));     // notes in Work
createQuery(() => queries.notes.directories.list.queryOptions());   // the folder tree
const moveNote = createMutation(() => queries.notes.move.mutationOptions());
moveNote.mutate({ stem: 'Work/plan', next: 'Home/plan' });
const moveDirectory = createMutation(() => queries.notes.directories.move.mutationOptions());
```

Cache keys under the folder's root key:

```txt
[...root, 'tables', 'notes', 'list']                  the whole tree
[...root, 'tables', 'notes', 'children', 'Work']      one directory ('' for the top level)
[...root, 'tables', 'notes', 'row', 'Work/plan']      one row
[...root, 'tables', 'notes', 'directories']           every directory and its fields
```

`children` is a sibling key of `list`, not a longer `list` key, so TanStack's
prefix match on the tree's key does not sweep every directory's listing.

Invalidation, in `matches` (`query.ts`), for a changed path
`notes/<directory>/<name>`:

| Query | Stale when |
| --- | --- |
| `list` | any path under `notes/` changed (today's rule: the first segment names the table) |
| `directories` | any path under `notes/` changed: a new path can mean a new directory, and the paths alone do not say which |
| `children(d)` | a changed path's directory inside the table is `d` |
| `row(stem)` | the changed path is `rowPath('notes', stem)` |

A `move` sets its result where it can, as `set` does today: it drops the row
from the source's `children` and the tree, and adds it to the destination's.
`directories.move` and `directories.delete` mark the table's queries stale,
since they touch many paths.

### How Honeycrisp reads

| Honeycrisp needs | Read |
| --- | --- |
| All Notes, Recently Deleted, per-folder counts | `queries.notes.list`, filtered by `deletedAt` and grouped by the stem's directory |
| Notes in Work | `queries.notes.children('Work')`, or the tree listing filtered by directory, since Honeycrisp already reads the tree for counts |
| The folder tree, with icons | `queries.notes.directories.list`, split on `/` |
| Move a note to Home | `queries.notes.move` with `{ stem, next: joinPath('Home', basename(stem)) }` |

## Current state

- A table is one flat directory. `rowAddressProblem` refuses a stem with `/`
  (`packages/folder/src/paths.ts`), and `list()` reads the `.md` names that
  `storage.children(name)` returns directly in the table directory, skipping
  the rest (`table.ts`, `filenamesOf`). A directory inside a table is ignored
  by `list`; a file in it is an ordinary file.
- The merge kind of a path is decided by `tableAt` in `merge-file.ts`, which
  makes a file a row only at exactly `<table>/<name>.md`, one slash. Every
  write, Sync's merge (`git/history.ts`, `kindOf`), and Git's merge driver
  (`merge-driver.ts`, `gitMergeKind`) use it.
- A row moves through `table.rename`, which is `folder.move` between two row
  paths (`write.ts`, `movePath`). Sync follows a rename when one side deleted
  a path and created exactly one other path holding the same blob
  (`git/merge.ts`, `followRenames`), so the other side's edit merges at the
  new path.
- The storage port already has what nesting needs: `children(directory)`,
  `list()` over the whole folder, `mkdir`, `rmdir`, and a `put` that makes the
  parent directories it needs (`boundary.ts`, `opfs-store.ts`,
  `directory-store.ts`).
- Honeycrisp declares `folders` (`name`, `icon`) and `notes.folderId`
  (`apps/honeycrisp/src/lib/data.ts`). Deleting a folder sets `folderId: null`
  on each member note, rereads every note, and refuses while any note cannot
  be read well enough to say which folder it is in
  (`notes.svelte.ts`, `deleteFolder`, about 60 lines). ADR-0503 lists "simpler
  folder-deletion behavior in Honeycrisp" as unbuilt. A note whose folder is
  gone shows a "(missing)" option in `NoteDetail.svelte`.

## Alternatives considered

| Option | Shape | For | Against |
| --- | --- | --- | --- |
| (a) Table plus reference field (today) | `folders/<id>.md`, `notes/<id>.md` with `folderId` | Moving a note is a field set, so a concurrent move and edit merge by field; renaming a group is one row write; no engine change | The grouping is invisible on disk and to Git, Finder, Obsidian, and agents; references dangle; deleting a group is an orchestrated multi-file refusal; ADR-0584 left the names `folders` and `folderId` unresolved because they collide with Folder |
| **(b) Nested rows in one table** | `notes/Work/Ideas/plan.md` | The directory is the group, so what a person sees in Finder is what the app shows; no reference to dangle; moving a note is a Git rename; one table, one schema, one listing; other Markdown tools read the same structure | `stem` widens to a path; group rename is N moves; two Sync cases leave repairable states (below); a marker file for empty groups and group fields |
| (c) Each group its own table | `defineTable` per group, created at run time | Reuses flat tables | A table name must be a bare SQL identifier (`packages/definition/src/table-name.ts`), so "Work Projects" cannot be one; every new group rewrites `epicenter.json`, which only the app's own handle publishes (ADR-0583), so another opener's containment check breaks; a note moving between groups changes tables; no nesting |
| (d) No table: plain files with frontmatter | `notes/**/*.md` read through `files` | Maximum freedom; what Obsidian does | Loses the one read pipeline, field validation and Needs repair, field-level merge (a file merges by field only as a row of a declared table), the query layer's typed rows, and `epicenter query`; Honeycrisp would rebuild all of it |

(b) wins because Epicenter's premise is that the files are the data a person
owns. A grouping that exists only as a field is a database idea stored in
files. (a)'s one real advantage is Sync: a field merges where a rename can
lose the race. The cases are narrow (see Sync and merge), visible, and
repairable, and ADR-0503 says to accept that over adding machinery.

## Disk format

```text
so.epicenter.honeycrisp/
├── epicenter.json
└── notes/
    ├── k3j9x0a1b2.md            a note in no folder
    ├── Work/
    │   ├── .directory.md        the folder's fields; keeps the folder when it is empty
    │   ├── 7f2c9d1e0a.md
    │   └── Ideas/
    │       ├── .directory.md
    │       └── plan.md
    └── Home/
        └── .directory.md        an empty folder
```

### The directory file

`<table>/<directory>/.directory.md` is a Markdown file with frontmatter and an
optional body, read and written through `parseRow` and `formatRow` against the
directory fields, so it merges by field like any row. With `nested: true` it
holds empty frontmatter:

```md
---
icon: briefcase
---
```

It exists for two reasons. Git tracks no empty directory, so without a file a
group emptied on one device vanishes on the next device's Sync (Sync's publish
removes the directories its removals emptied); and Honeycrisp's `icon` needs a
home. It is optional: a directory without one is still a directory of the
table, with every field unset. The engine writes one whenever it creates a
directory; a person or agent who runs `mkdir` gets a directory without one.

The name is a choice for the owner (open question 2). The table:

| Name | Hidden in Finder, `ls`, Obsidian | Merges by field | Cost |
| --- | --- | --- | --- |
| `.directory.md` (recommended) | yes (Obsidian: unverified) | yes, as a row of the directory fields | reserves one row name in nested tables |
| `_group.md` | no: shows in every folder | yes | reserves one row name; clutter in other tools |
| `.epicenter-group` | yes | no: a non-row file merges by line or whole | a second merge kind |
| `index.md` | no | yes | a plausible note name; Hugo and Obsidian folder-note plugins read it as content |

In a nested table, the file name `.directory.md` at any depth is never a row:
`get('Work/.directory')` is `InvalidPath`, `list` skips it, and `stemOf` returns
`null` for it. Today `notes/.directory.md` would be a note (Honeycrisp's README
says a leading dot is ordinary), so this reserves one name, in nested tables
only. A flat table reserves nothing.

### Names

- A stem in a nested table is one or more segments joined by `/`. The whole
  row path must pass `pathProblem` (`paths.ts`), which already checks every
  segment: no empty or relative segment, no `.git` or `HEAD`, no trailing dot
  or space, reserved character, device name, or short name. So a directory
  named `Work.` or `con` is refused, as a file of that name is today.
- The last segment may not be `.directory`. No other name is reserved.
- A directory segment is always a directory: in a nested table `list` walks
  into a directory named `x.md`; it does not report it as a row that is
  `NotAFile`, as a flat table does today.
- The stem is unique per table, because it is a path; a file name is unique
  per directory. `Work/plan` and `Home/plan` are two rows.
- Case: the engine keeps its rule that a local write is refused only by what
  its own storage does, and `collisionKey` is never applied to a local save
  (`paths.ts`). So `Work` and `work` can both be created in a browser folder,
  whose storage keeps names exactly, and Sync then refuses the tree as
  `Unrepresentable` (`git/history.ts`, where every ancestor directory is
  folded too). Honeycrisp refuses a folder name that differs from a sibling's
  only by case, at the app level (open question 6).

### `epicenter.json`

The table's object schema gains one annotation, `x-nested`, beside the
existing `x-field` convention. A JSON Schema validator ignores an unknown
keyword, so a row validates against the table's schema exactly as before.

```json
"notes": {
  "type": "object",
  "properties": {
    "title": { "type": "string", "x-field": { "kind": "string" } },
    "pinned": { "type": "boolean", "x-field": { "kind": "boolean" } }
  },
  "required": ["title", "pinned"],
  "x-nested": {
    "type": "object",
    "properties": { "icon": { "type": "string", "x-field": { "kind": "string" } } },
    "required": []
  }
}
```

`nested: true` publishes `"x-nested": true`. `parseDeclaration` accepts
`x-nested` as `true` or an object schema whose `required` is empty, and
refuses anything else (`declaration.ts`, `objectSchema`'s allowlist).

### `local` inside a nested table

`local` patterns apply by path, as now. A pattern such as `notes/Private/`
keeps that group, its `.directory.md` included, on the machine that wrote it:
its rows list and edit like any others there and never reach history. Nothing
new is needed. Per-group `local` chosen at run time is out of scope: `local` is
part of the definition.

## Sync and merge

Every case below runs on today's Sync code once `fileKindOf` knows nested
rows. Nothing here adds a transaction or a new merge rule.

| Case | What happens | Result | Repair |
| --- | --- | --- | --- |
| Both devices edit one note | field and body-line merge, as now | merged | none |
| A moves `Work/plan` to `Home/plan`; B edits `Work/plan` | `followRenames` sees A delete one path and create one with the same blob, moves B's version and the base there, and merges by field | merged at `Home/plan` | none |
| A moves `Work/plan` and then edits it, before syncing; B edits it | the blob changed, so no rename is seen; A's delete beats B's edit, which stays in history as the merge's parent with an `Overrode` trailer | B's edit is not in the tree | recover from history; open question 5 |
| A renames group `Work` to `Projects`; B edits `Work/a.md` | each file moved byte for byte, so each rename is followed | B's edit lands in `Projects/a.md` | none |
| A renames `Work` to `Projects`; B adds `Work/new.md` | B's new path is not a rename; it stays where B put it | a bare `Work` group holding one note, beside `Projects` | move the note; open question 4 |
| A renames `Work`; B sets `Work`'s icon | the `.directory.md` moved byte for byte, so the rename is followed | the icon lands in `Projects/.directory.md` | none |
| Both create group `Work` | both create `notes/Work/.directory.md` from no file, which merges by field (the merge driver's "two rows added under one name merge field by field") | one group | none |
| A creates `Work`, B creates `work` | the merged tree holds two paths that fold together | Sync stops as `Unrepresentable`, naming both, and writes nothing | rename one; Honeycrisp prevents it locally |
| A deletes group `Work` (moving notes to the top level); B edits `Work/a.md` | A's move is a rename, followed | B's edit lands in `a.md` at the top level | none |
| A deletes group `Work`; B adds `Work/new.md` | B's file stays; A's `.directory.md` is gone | a bare `Work` group holding one note | move or delete the note |
| A empties a group with no `.directory.md` | A keeps the empty directory; B's publish removes the directories its removals emptied | the group shows on A, not on B | the engine writes `.directory.md` for every directory it makes, so only hand-made directories hit this |
| A makes a file `notes/Work` (no extension); B makes group `notes/Work/` | file against directory, as now: the directory stays and the file moves beside it as `notes/Work~local` or `~remote` | both kept | rename the file |

Two caveats on `followRenames`, both inference from `git/merge.ts`. It follows
a deleted path only when no other deleted path holds the same blob, and only
when exactly one created path holds it. Two `.directory.md` files with
identical bytes (two groups with no fields, both moved in one rename of their
parent) are not followed; that matters only if the other device edited one of
them in the same window. Two notes with identical bytes are unlikely, since
`createdAt` differs.

A Sync whose publish stops partway already leaves each file whole, old or new,
and the next Sync finishes from `refs/epicenter/publishing` (ADR-0545). A group
rename received partway shows as two groups until then. Nothing about that
changes.

Plain `git merge` and `git pull` with the merge driver use Git's own rename
detection, not `followRenames`, so they can follow a moved-and-edited note by
similarity and may place a file added under a renamed directory in the new one
(`merge.directoryRenames`; not checked here). Epicenter's Sync is stricter.
That asymmetry exists today for row renames.

## Engine changes

Sizes are rough estimates of added source lines, excluding tests.

| Area | Files | Change | Size |
| --- | --- | --- | --- |
| Declaration vocabulary | `packages/definition/src/declaration.ts`, `define.ts`, `prepare.ts` | `nested?: true \| { fields }` on the table declaration; preparation checks directory fields as it checks fields, and refuses a required one; `FieldsOf` reads `nested` too | ~80 |
| Containment (ADR-0538) | `packages/definition/src/shape.ts` | a definition's `nested` must match the folder's, else `incompatibleTable` ("the folder keeps `notes` in directories; this definition reads only the top level", or the reverse); directory fields contained like fields | ~40 |
| `epicenter.json` | `packages/folder/src/declaration.ts` | format and parse `x-nested`; add it to `objectSchema`'s allowlist | ~40 |
| Definition | `packages/folder/src/definition.ts` | `publicationProblem` over the directory fields; the prepared mark on the directory table | ~20 |
| Addresses | `packages/folder/src/paths.ts` | `DIRECTORY_FILE`; nested forms of `rowAddressProblem` and the stem inverse; `directoryAddressProblem` | ~50 |
| Table | `packages/folder/src/table.ts` | `list` walks with `storage.children`, one call per directory; `children(directory)`; `create` with `{ directory }`; `stemOf`; the `directories` handle with `list`, `get`, `create`, `set`, `move`, `delete`; `NotEmpty` | ~220 |
| Merge kind | `packages/folder/src/merge-file.ts` | `tableAt` accepts any depth for a nested table, and returns the directory table for `.directory.md` | ~20 |
| Query layer | `packages/folder/src/query.ts` | `children`, `directories`, and `move` options; the keys and `matches` rules above; cache updates for a move | ~170 |
| Check and projection | `packages/folder/src/check-folder.ts`, `projection.ts` | `check` reads `.directory.md` files and reports one that does not conform; the projection's `stem` column holds the path, so `WHERE stem LIKE 'Work/%'` selects a group; directory fields are not projected | ~30 |
| CLI | `packages/cli/src/folder-commands.ts` | none beyond what `checkFolder` reports | ~5 |
| Merge driver | `packages/folder/src/merge-driver.ts`, `packages/cli/src/merge-driver.ts` | none: `* merge=epicenter` already covers every path, and the kind comes from `fileKindOf` | 0 |
| Sync | `git/merge.ts`, `git/history.ts` | none in this design | 0 |
| Storage port and desktop shell | `boundary.ts`, `tauri-plugin-epicenter-folder` | none: `children`, `mkdir`, `rmdir`, and parent-making `put` exist; the Rust crate does not read table declarations (a grep finds only the `epicenter.json` file name, in `page_files.rs`) | 0 |
| README | `packages/folder/README.md` | Names, Tables own only their row files (the directory file is the one other file a nested table owns, amending ADR-0480), Reading a row, Writing a row, Queries, Sync | ~150 lines of prose |

Tests, roughly 500 lines: row addresses at depth and the reserved name;
`list` and `children` over a tree with bare directories, `.directory.md`
files, ordinary files, and a directory named `x.md`; `directories.move`
stopped partway and rerun; `directories.delete` refusing `NotEmpty`; Sync
following a row moved between directories, a group rename with a concurrent
edit, and a concurrent add left in the old directory; `x-nested` round trip
and refusals; containment both ways; query invalidation per directory.

The generic Folders window (`apps/epicenter/src/folders/FolderView.svelte`)
renders stems as they come, so a nested table shows `Work/plan`. It needs no
change to work.

Listing cost, an inference: on the desktop each `children` call is one shell
command, so `list` on a nested table costs one call per directory plus one
read per row, where a flat table costs one call plus one read per row.

## Honeycrisp migration

A clean break: no released build reads these folders (ADR-0584 makes the same
call for renamed fields).

- `data.ts`: delete the `folders` table, `FolderFields`, `FolderEntry`, and
  `folderLabel`; delete `notes.folderId`; declare
  `nested: { fields: { icon: field.optional(field.string()) } }`. The UI keeps
  the word "Folder"; code says `directory`.
- `notes.svelte.ts`: `view.folderId` becomes `view.directory: string | null`
  (`null` is All Notes). `createNote` creates with `{ directory }`. Moving a
  note to a folder is the existing rename flow, which already waits for the
  file's saves and moves its bytes, with `next` in the chosen directory; the
  open editor follows the new stem as it does after a rename. `createFolder`,
  `patchFolder`, and `deleteFolder` become `directories.create`, `set`, and a
  short sequence: move each note in the subtree to the top level, then
  `directories.delete`. The refusal for unreadable notes goes away: membership
  is the path, and a move carries bytes whether or not they read.
- `FolderNav.svelte` becomes a tree: All Notes, Recently Deleted, then
  `directories.list()` split on `/`, each row indented with its icon and the
  count of its non-deleted notes from the tree listing. New Folder creates
  under the selected folder or at the top. Rename is `directories.move` to a
  sibling path. Delete confirms "Its notes move to Notes." Dropping a note on
  a folder is `notes.move`; dropping a folder on a folder is
  `directories.move`.
- `NoteDetail.svelte` and `NoteList.svelte`: the folder select and the
  "Move to" menu list directories and call the move; the "(missing)" option
  goes, since a note cannot point at a folder that is gone.
- Recently Deleted stays the `deletedAt` field. A deleted note stays in its
  folder, so restoring it puts it back with no bookkeeping.
- Files (`FileBrowser.svelte`): a directory made there under `notes/` is a
  folder at once, with no icon. Files and the sidebar agree because they read
  the same directories.
- Development folders: an old `folders/` directory becomes undeclared
  ordinary files, and each note keeps `folderId` as an unknown key, which
  open tables keep on write. Delete both by hand; nothing maps them.
- README "Where notes live" and the folder paragraphs: rewrite to the tree
  above.

Rough size: about 150 lines removed from `notes.svelte.ts` and `data.ts`;
`FolderNav.svelte` grows by the tree, perhaps 60 lines; tests in
`notes.test.ts`, `folder.test-support.ts`, and the platform tests change
their fixtures from `folderId` to paths.

## Open questions

1. **The code noun for a group.** `directory`, already in ADR-0584's noun set
   ("a directory inside a folder is `directory`"), or a new noun `group`?
   Recommend `directory`: no new noun, and the address is literally a
   directory path. Amend ADR-0584's Row row to say a stem is the row's path
   in its table without `.md`, one segment in a flat table.
2. **The directory file's name.** Recommend `.directory.md`: hidden in the
   tools people browse with, merges by field as a row, and its name says what
   it is. Second choice `.group.md` if the noun is `group`.
3. **Is the directory's name its display name?** Recommend yes, with no
   `name` field: what Finder shows is what the app shows, and an Apple Notes
   folder has one name too. The cost is that renaming a group moves every file under
   it. The alternative, a stable directory and a `name` field, makes rename
   one write but brings back a second name that drifts from the disk.
4. **Follow directory renames in Sync** (a note added under `Work` while
   another device renamed it to `Projects` lands in `Projects`)? Recommend
   not in the engine PR. The state it fixes is visible and one drag to
   repair, and the rule puts a file where its writer never put it. Revisit if
   it happens in use.
5. **Follow a note moved and edited before one Sync**, by similarity rather
   than identical bytes? Recommend not now. Today's flat rename has the same
   gap; similarity matching is a new merge rule with its own false positives.
   The edit is kept in history with a trailer.
6. **Case-only folder names.** Recommend Honeycrisp refuses a folder name
   that a sibling already holds in another case, and the engine keeps "the
   storage decides" for local writes. Sync's refusal remains the backstop.
7. **Deleting a folder: notes to Notes, or to Recently Deleted?** Apple Notes
   sends them to Recently Deleted (from memory; unverified). Recommend keeping today's behavior, notes
   move to the top level, because it loses nothing and the dialog already
   says so; switch if the owner wants Apple's behavior, which is the same
   loop with a `deletedAt` set.
8. **Folder order.** Recommend alphabetical, as Apple Notes sorts folders (from
   memory; unverified), and no `order` field. A manual order would add a field every device can
   change, which merges per directory file but needs a rule for ties.
9. **Which tables nest.** Recommend `notes` only. Todos, Whispering
   recordings and runs, and Vocab entries stay flat; a later table opts in by
   changing its definition, and its existing rows stay valid, except a row
   named `.directory`, which becomes that table's directory file.

## Phased plan

Placed after ADR-0584's P1 to P10, because the engine work uses `table.move`
(P2), the per-verb errors (P4), `null` absence (P9), and `queries`, and the
Honeycrisp work uses the app stem forms (P7).

- [ ] **N0, this spec.** Owner answers the open questions. When settled,
      record an ADR ("A table may nest its rows in directories") and amend
      ADR-0584's Row and stem definition and ADR-0480's ownership rule.
- [ ] **N1, engine.** After P1 to P10. Declaration vocabulary, `x-nested`,
      containment, addresses, `table.ts` (rows and `directories`), merge kind,
      `check`, README, tests. Standalone commits in that order.
- [ ] **N2, query layer.** After N1, or as its last commit. `children`,
      `directories`, `move`, keys, and invalidation.
- [ ] **N3, Honeycrisp.** After N2 and P7. The migration above. Delete this
      spec when it lands, once the ADR holds the decision.
- [ ] **Later, only if use shows the need.** Directory-rename following in
      Sync (question 4); similarity rename following (question 5).

## Verification

- N1: `bun run test` and `bun run typecheck` in `packages/definition` and
  `packages/folder`; `epicenter check` and `epicenter query "SELECT stem FROM
  notes WHERE stem LIKE 'Work/%'"` over a fixture folder with nested rows; a
  Sync test with two devices covering each row of the Sync table.
- N3: `bun run test` and `bun run typecheck` in `apps/honeycrisp`; by hand,
  create, rename, nest, and delete folders, move notes by drag and by menu,
  and confirm Finder shows the same tree; Sync two browser profiles through
  the Git demo server (`bun dev:git`) with a group renamed on one and edited
  on the other.
- Both: `bun run lint:ci`, `bun run check:structure`, and
  `bun scripts/check-doc-hygiene.ts`.
