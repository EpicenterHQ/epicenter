# @epicenter/folder

A Folder mirrors the files that storage last returned or accepted. It owns a
root, a serial write queue, and table views over Markdown files at
`<table>/<id>.md`. A table schema interprets rows; it does not limit what a
file may contain. The folder does not hold typed input. A Svelte editor keeps
that input in a draft until its save lands.

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | Open this browser origin's default folder or the directory bound to this Tauri window. Apps may alias this exact specifier to one platform entry at build time. |
| `@epicenter/folder/browser` | Open the fixed IndexedDB folder in a web page. Refuses inside Tauri. |
| `@epicenter/folder/tauri` | Open the directory that the shell bound to this window. Refuses outside Tauri. |
| `@epicenter/folder/bun` | Open an existing directory with `{ directory, tables }`; also exports the CLI's declaration and Git history tools. |
| `@epicenter/folder/testing` | Construct a folder over `memoryHost` and control its storage in tests. |
| `@epicenter/folder/file-browser` | Pure path, tree, text classification, and newline helpers. |
| `@epicenter/folder/documents` | Interpret saved Markdown files for the generic editor and SQL reader. |
| `@epicenter/folder/declaration` | Portable declaration schemas and view transforms. |

The opening entries export the types and `readRow` from `contract.ts`. Importing
an entry does not open a folder.

## Opening

```ts
import { openFolder } from '@epicenter/folder';
import { Type } from 'typebox';

const tables = { notes: Type.Object({ title: Type.String() }) };
const opened = await openFolder({ tables });
if (opened.error !== null) throw opened.error;
const folder = opened.data;

const saved = await folder.tables.notes.create('milk', {
  fields: { title: 'Milk' },
  body: 'Two litres\n',
});
if (saved.error !== null) throw saved.error;
console.log(folder.tables.notes.row('milk')?.fields.title); // Milk
await folder.close();
```

A browser opens one fixed IndexedDB folder for its origin. A desktop page opens
only the directory its shell assigned before creating the window; the page
names no path. A Bun caller supplies an existing directory. Opening needs no
account, network, Git repository, or `epicenter.json`, and creates no authored
file. `openFolder` returns a refusal when storage is unavailable or the root or
table names are invalid. It never falls back to another store.

## Reads

`files()` lists every path the mirror knows, and `file(path)` reads its current
`FolderFile`. Text files are kept as strings. Other files have
`data: undefined`; use `read(path)` to fetch their bytes. A failed read leaves
`readError` on the file and retains any earlier data. The mirror reads listed
text files when opening and reconciles outside changes through `refresh()`.
Its `subscribe(listener)` method reports changes to mirrored values. Browser
tabs and native directory watchers provide change hints; focus and explicit
refresh reconcile missed hints. A hint naming a file the mirror already holds
rereads that file without a full relist. New paths, directory hints, and
unnamed hints relist the folder.

`tables.notes.rows()` returns rows sorted by ID, and `row(id)` returns one row
or `undefined`. A row with `issues === null` has schema-typed fields and a
body. An invalid or unreadable row keeps its path and diagnostics so an editor
can offer repair. `readRow(text, schema)` interprets a draft with the same row
rules without writing it. A row's exact saved source is
`folder.file(row.path)?.data`.
`describeIssue` and `describeIssues` turn row diagnostics into sentences for a
repair view.

## Writes

`write(path, data)` replaces a whole file. `update(path, patch, { schema? })`
reads the file from storage at its queue turn, then sets fields or body on
those fresh bytes.
A table has `create(id, { fields, body? })`, `update(id, patch)`, and
`delete(id)`; the folder also has `delete(path)`. Setting a field to
`undefined` removes it. A patch that changes no value writes nothing.
Updated frontmatter is canonical: declared keys first, then other keys in
sorted order. Comments and original key order are not preserved by a patch.

Writes take turns in one serial queue. Consecutive waiting writes to the same
path merge: whole-file writes keep the newest data, and updates combine their
fields and newest body when their table keys match. A merged update reads
storage at its one turn, preserving outside changes to fields it does not name.
A changed update makes one unconditional put; an unchanged update makes none.
Every merged caller receives the same `Saved` answer after the mirror shows
what landed, or a `WriteError`. A failed put leaves the last read value in the
mirror. A later whole-file write can still replace those bytes; the last
publication to land wins.
Git sync retains its separate three-way merge and conditional storage rules.

`idle()` waits until no write is queued or out. An action that needs every
editor's text on disk can await `idle()`. `close()` refuses new writes, drains admitted work, then
releases storage and watchers. Await a write's result when subsequent work
requires durable bytes. A UI draft and its retry or discard controls belong to
[`@epicenter/svelte`](../svelte/README.md), outside the Folder.

## Browser storage

The [browser repository engine](src/browser/README.md) stores the current
folder as an immutable Git working tree in IndexedDB. Local saves create no
Git commit. The older OPFS and IndexedDB stores are not opened or changed.
Browser Git exchange remains an independent engine feature; a Folder exposes
no sync or history controls.

## Native directories

Bun and Tauri open ordinary directory files, with no required Git repository.
They stage a replacement beside the directory and rename one whole file under
a shared save lock. Bun takes this lock through an exclusive SQLite
transaction; the Tauri plugin uses the same boundary. Paths and links are
checked before writes. A native watcher reports outside changes as hints, and
`refresh()` rereads the mirror. Watching is best effort, so an application
also refreshes on return to a visible window.

The CLI's `runHistory` is independent of a Folder's lifetime. It can commit,
inspect, and synchronize an existing directory. Git history and sync retain
their conditional storage writes in `boundary.ts` and `write.ts`.

## Helpers

`openedFile(bytes, maxBytes)` from `@epicenter/folder/file-browser` classifies
exact bytes as editable UTF-8 text, binary content, or too large. It preserves
a byte order mark and CRLF in text. `visibleRows` builds a file tree from a
listing, and `withFileNewlines` applies the file's line-ending style.

`documentsOf(folder.files())` from `@epicenter/folder/documents` interprets
saved Markdown at any path for the generic editor and SQL reader. It includes
schema diagnostics and unreadable paths. The declaration entry owns portable
schema and saved-view readers; its JSON Schema is generated from the TypeBox
source. `@epicenter/folder/bun` exports the CLI's `checkFolder`,
`queryFolder`, `runHistory`, and declaration tools. These tools can read or
change a directory independently of an opened Folder.

## Building for one environment

Alias only the bare specifier in a build that targets one host:

```ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

Use `/browser` for a browser-only build. Without an alias, the bare entry
chooses at call time and loads only the chosen engine. The
[`evidence/bundles`](evidence/bundles/) tests inspect emitted chunks.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/folder.ts`, `storage.ts`, `patch.ts`, `write-refusal.ts` | Mirror, host contract, canonical patches, and write refusals. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts`, `testing.ts` | Public and test entries. |
| `src/browser/` | IndexedDB repository and independent Git exchange. |
| `src/native/`, `tauri-files.ts`, `directory-store.ts` | Directory storage, watches, bindings, and save locks. |
| `src/shared/` | Markdown reading and content merge rules used by the mirror and sync. |
| `src/git/`, `history-wire.ts`, `write.ts` | History requests and Git publication. |
| `src/declaration/`, `declaration.ts`, `directory-documents.ts` | Portable schemas and generic document reads. |
| `evidence/`, `smoke/` | Bundle checks and browser smoke runs. |

## Commands

```sh
bun run typecheck
bun run test
bun test evidence/bundles evidence/closure
```

Each save changes one file; there is no multi-file transaction. Directory
change hints are best effort, and file bytes cross the desktop bridge whole.
