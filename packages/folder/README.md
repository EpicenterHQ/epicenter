# @epicenter/folder

One public `Folder`: an opened, rooted set of local file paths and their
contents, with table views over Markdown rows
([ADR-0636](../../docs/adr/0636-an-app-opens-local-files-through-one-folder-handle.md),
[ADR-0633](../../docs/adr/0633-apps-open-local-data-before-connecting-services.md),
[ADR-0632](../../docs/adr/0632-a-lens-belongs-to-its-reader.md)). Each runtime
selects the folder when it opens:

| Runtime | Opening | Folder |
| --- | --- | --- |
| Browser | `openFolder({ tables })` | This origin's default local folder in IndexedDB, under a fixed internal key. |
| Desktop app (Tauri) | `openFolder({ directory, tables })` | The directory the shell registered as `directory`, an ID, never a path. |
| Bun | `openFolder({ directory, tables })` | The existing directory at the path `directory`. |

Opening needs no app ID, account, remote, network, or schema file. It
creates no Git history and writes nothing. See
[shared vocabulary](../../docs/CONTEXT.md).

```ts
import { openFolder } from '@epicenter/folder';
import { Type } from 'typebox';

const notes = Type.Object({ title: Type.String(), done: Type.Optional(Type.Boolean()) });
const { data: folder, error } = await openFolder({ tables: { notes } });
if (error !== null) return show(error.message);

const stop = folder.onChange((change) => refresh(change.paths)); // subscribe, then read
const row = (await folder.tables.notes.get('milk')).data;
const saved = await folder.tables.notes.set('milk', row ?? null, { fields: { title: 'Milk' } });
if (saved.error !== null) show(saved.error.message);             // nothing was saved
folder.status;                                                   // { saving, storageFailure }
await folder.close();
```

## Entries

| Import | Exports | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | `openFolder` with either form: `{ directory, tables }` in the desktop app, `{ tables }` in a browser. Decided when it is called; only the chosen engine is loaded. | Ordinary application code that runs in both. |
| `@epicenter/folder/browser` | `openFolder({ tables })`. Refuses inside the desktop app. | A web-only build. |
| `@epicenter/folder/tauri` | `openFolder({ directory, tables })`. Refuses outside the desktop app. | A desktop-only build. |
| `@epicenter/folder/bun` | `openFolder({ directory, tables })` over a path, and the `epicenter` CLI's tools ([below](#cli-tools)). | Command-line tools, scripts, and tests given a directory. |
| `@epicenter/folder/file-browser` | Path helpers, visible tree rows, newline preservation, and `readTextFile`. Opens nothing. | A file tree or a file view. |

Every opening entry exports the same contract (`contract.ts`): the `Folder`
type and its parts, `FolderOptions`, `OpenFolderError`, `ReadError`, and
`SaveError`. Importing an entry opens nothing.

## Opening

`openFolder` returns `Result<Folder<TTables>, OpenFolderError>`. A refusal is
returned, never thrown, and no opener opens other storage instead.

| `OpenFolderError` | When |
| --- | --- |
| `InvalidTable` | A table name that cannot be one portable top-level directory, checked by the shared `pathProblem` rule in both engines. |
| `Unavailable` | Storage could not be reached: no IndexedDB, or a shell that cannot answer. |
| `InsideTauri` | The browser entry was called in the desktop app. |
| `NotTauri` | A desktop directory was asked for outside the desktop app. |
| `DirectoryRequired` | The automatic entry was called in the desktop app without `directory`. |
| `InvalidId` | Desktop: an empty registered ID. |
| `UnknownScope`, `WindowNotPermitted`, `Missing`, `ShuttingDown` | Desktop: the shell refused the grant, or the registered directory is gone. A missing directory is never replaced with an empty one. |
| `InvalidRoot` | Bun: the path is not a directory, or has no parent to hold its save lock. |

Each handle has one root. A caller may open several handles, of one folder or
of several, and two schemas over one directory change interpretation, not
the saved files.

## The handle

| Member | Contract |
| --- | --- |
| `files` | `list(prefix?)` sorted root-relative paths; `read(path)` `{ path, content: Blob }` or `undefined`; `write(path, from, content)`; `delete(path, from)`. |
| `tables.<name>` | A view of rows at `<name>/<id>.md`: `list()`, `get(id)`, `set(id, from, change)`, and `delete(id, from)`. Adjacent files are available through `folder.files`. |
| `onChange(listener)` | Runs after a save commits: `change.paths`, or `null` when any path may differ, and `change.origin`, `this-handle` or `other-handle`. Returns the function that stops listening. |
| `status`, `onStatusChange` | `{ saving, storageFailure }`. |
| `close()` | New calls throw at once; saves already started finish with their real outcome; then listeners and storage are released. Calling it again returns the same promise. |

A call on a closed handle throws: it is a programming error, not a storage
failure.

New file and row names follow the portable path rule. Earlier files with a
nonportable but structurally safe name remain readable. A save or deletion
can change one of those files when it supplies the exact source it started
from; a new file cannot be created under that name. `HEAD` remains read-only
because changing it can turn a plain directory into Git state.

### Rows

A row is `{ id, text, body, fields, issues }`. `text` is the file's exact
source. When the frontmatter fits the table's schema, `issues` is `null` and
`fields` has the schema's type; otherwise `fields` holds the raw values and
`issues` says why, each `{ kind, message, path, line? }`:

| `kind` | The file |
| --- | --- |
| `schema` | parses, and a field does not fit the schema |
| `frontmatter` | has frontmatter that does not parse; `body` is the whole text |
| `not-text` | is not UTF-8 text without NUL |

A schema only interprets. It never refuses a save, and unknown fields,
comments, and repairable frontmatter survive every save. A row that does not
fit is read, shown, and repaired, not dropped. `list()` reads every `.md`
file directly in the table's directory; a missing directory is an empty
table, and reading creates nothing.

### Saving

Every save names what it started from: `from` is the content or row as read,
or `null` for something new. The engine reads the file as it is now and
merges the change from `from` into it, so saves that landed meanwhile stay,
then writes the result guarded by what it read. Another writer landing in
between makes the engine read and merge again.

- `files.write(path, from, content)` saves text or bytes. Pass bytes for a
  binary file or to keep a byte-order mark; a byte array is copied when the
  method is called.
- `tables.<name>.set(id, from, { fields?, body? })` puts `fields` over the
  row's fields and replaces its body, then saves the row's text. It answers
  `sent`, the row it submitted, to start the next edit from. A field edit of
  a row whose frontmatter does not parse is `Unparseable`; a body edit lands.
- `delete(id, from)` removes only the row file. Adjacent files stay in the
  folder. A delete whose `from` an unseen edit changed keeps the row and answers
  `{ deleted: false }`.

The merge is content-only and the same on every host (`shared/merge.ts`,
`shared/row.ts`, ADR-0622). No schema or storage takes part:

| File | Unit |
| --- | --- |
| `.md` with frontmatter that parses | one frontmatter field; one region of body lines |
| `.md` whose frontmatter does not parse, and other UTF-8 text | one region of lines |
| binary | the whole file |

Units only one side changed survive, and a side that changed nothing leaves
the other's bytes exactly as they are. Where both changed one unit, the save
wins. A delete never erases an edit it did not see: a delete whose base
another writer changed keeps their file, and an edit of a file deleted
meanwhile writes the edit.

| `SaveError` | When |
| --- | --- |
| `InvalidPath`, `InvalidId` | A path or row ID the folder cannot address. |
| `Occupied` | A file stands where a directory is needed, or the reverse. |
| `CaseTwin` | A path that differs from a stored one only by case. |
| `NotText` | Text with NUL or unpaired surrogates, or a row edit of a file that is not text. |
| `Unparseable` | A field edit of a row whose frontmatter does not parse. |
| `StorageFailed` | Storage failed, with its reason; earlier storage is unchanged. |

A failed save returns its error and leaves the file as it was; the caller
keeps what it meant to save. `status.storageFailure` holds the last
`StorageFailed` until a later successful save on this handle, a no-op retry
included. `status.saving` is true while a save is between its call and its
commit or refusal. Structural refusals are the caller's to show, not status.

## Browser storage

A browser origin has one default local folder, kept in IndexedDB by the
[browser repository engine](src/browser/README.md) under a fixed internal
key that no app name, account, or remote changes. A save counts as saved
only after IndexedDB committed it, and other tabs of the origin hear it on
`onChange`. A web origin holds one ordinary app; separately isolated apps
need separate origins.

The older declaration-dependent opener kept folders in the origin private
file system (OPFS). The default folder opens IndexedDB independently. It
does not read, inspect, change, or remove the older OPFS data. An origin with
only older OPFS data therefore opens an empty current folder.

## Native directories

A directory folder's files are the saved data: every read goes to disk, and
every save is one guarded change of one file (`native/engine.ts`). Opening
reads a file a person left there as it is and changes nothing; only a save of
that path, merged with its current bytes, replaces it. Git is optional: a
directory with no `.git`, or with a `.git` file or link, opens and saves the
same, and saving creates no repository.

### Bun

`directory` is a trusted path; links in it are resolved once, at open. This
process reaches the disk itself (`native/bun.ts`). A new file's bytes are
staged in `.<name>.epicenter-scratch` beside the directory and renamed over
the path, so another program sees the old file or the new one. Each rename
or removal, with the check of the bytes it expects there, holds the
directory's save lock: an exclusive SQLite transaction on
`.<name>.epicenter-save-lock` beside the directory, which the desktop shell
and other Bun processes take too
([ADR-0562](../../docs/adr/0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md)).
A save waits up to ten seconds for another process's, then fails and changes
nothing. Opening clears what a stopped save staged an hour or more ago.
Nothing watches the directory: `onChange` reports this handle's saves and
those of other handles of the directory in this process.

### Desktop app

`directory` is the ID the shell registered the directory under
(`tauri-plugin-epicenter-folder`). Opening asks the shell to grant this
window that directory (`grant_directory`); the page then reads and saves only
through the shell's storage commands, one per storage method (`tauri-files.ts`,
[ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)).
The shell checks every path, stages and renames each save, and checks its
expected bytes under the same save lock. A command whose reply was lost counts
as landed only when the path holds what was sent. The shell's watcher reports
changes to the directory as `other-handle` changes; history moving under
`.git` is not a file change.

## Helpers

`@epicenter/folder/file-browser` provides path helpers, `visibleRows` for a
file tree over a `{ files, directories }` listing, `withFileNewlines`, and
`readTextFile(files, path, maxBytes)` over a folder's `files`. Text
classification keeps the file's byte-order mark; invalid UTF-8 and NUL bytes
open as binary details, and a file larger than `maxBytes` is `tooLarge`
without being read.

## CLI tools

`@epicenter/folder/bun` also holds what the `epicenter` CLI runs over a
directory it is given (ADR-0520). None of it opens a `Folder`.

| Export | Does |
| --- | --- |
| `checkFolder`, `queryFolder`, `readFolder` | Read the root `epicenter.json` and every table it declares, sort what does not conform, and answer one read-only SQL statement over the rows that do (ADR-0632). |
| `defineFolder`, `defineTable`, `field`, `formatDefinition`, `parseDefinition`, `DEFINITION_PATH`, `describeTables` | The `epicenter.json` grammar: each table one JSON Schema object, plus optional `title` and `local`. |
| `generateDefinition` | The older `epicenter generate`: runs a folder's `epicenter.ts` and writes its `epicenter.json` (ADR-0527), until its callers migrate. |
| `runHistory`, `historyExitCode`, `encodeHistory`, `holdingHistoryLock` | One history operation (`status`, `log`, `saveVersion`, `sync`) over the system `git`, as the CLI runs it (ADR-0559). |
| `holdingFileLock`, `createGitRunner`, `runGit`, `locateGit`, `GitMissingError`, `neutralizeAttributes`, `basicAuthorization`, `nodeDirectoryPrimitives` | The lock, `git`, and file helpers the CLI's other commands share. |

`readFolder` requires `epicenter.json`: a directory without it is
`NotDataFolder`, and one that cannot be read or prepared is
`InvalidDefinition`. It writes nothing, takes no lock, and follows no link.

Git is not on a `Folder`'s lifetime (ADR-0636). The history engine under
`src/git/` stays for exchange: `runHistory` opens a directory's history for
one operation, reads `local` from `epicenter.json` so no commit carries a
path it names, tracked or not, and holds the history lock across a save
version or a sync. The browser engine's own Git exchange is in
`src/browser/` ([its README](src/browser/README.md)).

Sync merges by the same rules on every host. Its merge commit's tree uses
`src/git/tree-merge.ts` over the merge base, the
remote's tree as current, and this device's as the change, with each file
both sides changed merged by the content rules a save uses (`shared/merge.ts`).
A delete never erases an edit it did not see. No rename is followed: a move
on one side against an edit on the other keeps both paths. A file against a
directory takes this device's entry whole. JSON, `epicenter.json` included,
merges by line like other text. Whatever a side lost stays in its parent
commit, and the merge message names it in an `Overrode:` trailer.

Sync then publishes the merged tree over the files through `write.ts`, one
file at a time under the save lock. The file the checkpoint committed is the
base, the merged tree's file is current, and the live file is the change, so
an edit made while Sync runs stands. A publish cut off partway is finished
first by the next commit (`refs/epicenter/publishing`).

## Building for one environment

Alias the exact bare specifier. Do not rewrite subpaths.

```ts
// vite.config.ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

With `/tauri`, no IndexedDB engine is emitted; with `/browser`, no desktop
engine. Without an alias, both engines are emitted as separate chunks and
neither loads until a folder is opened. No engine carries isomorphic-git.
`evidence/bundles` builds these and reads the output.

## Layout

| Path | What it is |
| --- | --- |
| `src/contract.ts`, `folder.ts` | The public contract: `Folder` and its parts, the open options, and the errors. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts` | The entries. |
| `src/handle.ts` | The caller-facing handle every engine shares: status, the close fence, and the operations close waits for. |
| `src/local-folder.ts`, `src/browser/` | The browser's default local folder over the IndexedDB repository engine. |
| `src/native/` | The directory engine (`engine.ts`), its Bun host and save lock (`bun.ts`, `directory.ts`), and its desktop host (`tauri.ts`, with `bindings.gen.ts` generated from the folder plugin; do not edit). |
| `src/shared/` | The content merge and row reading every engine uses. |
| `src/boundary.ts`, `directory-store.ts`, `directory-node.ts`, `directory-primitives.ts`, `tauri-files.ts`, `changes-tauri.ts` | Directory storage over `node:fs` and over the shell's commands, and the shell's change watcher. |
| `src/check-folder.ts`, `query-folder.ts`, `read-folder.ts`, `projection.ts`, `declaration.ts`, `definition.ts`, `row-text.ts`, `canonical.ts`, `generate-declaration.ts` | The CLI's readers of `epicenter.json` and its row codec. |
| `src/git/`, `history-wire.ts`, `write.ts` | Shared Git object and tree rules, the directory history engine `runHistory` runs, and the one write its Sync publishes through. |
| `src/file-browser.ts` | File-browser helpers. |
| `evidence/` | Bundle and dependency-closure tests, and recorded browser-engine experiments. |
| `smoke/` | Browser smoke runs of the IndexedDB engine (`bun run smoke:local`, `bun run smoke:sync:local`). |

## Commands

```sh
bun run test              # package tests
bun run test:engine       # the browser engine and shared rules
bun run typecheck         # TypeScript

bun evidence/bundles/inspect.ts main tauri   # print the chunks a build emits
```

Tests of a directory's history run real `git` over temporary directories
(`directory-history.test-support.ts`). Tests that serve Git over loopback
need permission to bind a local port. `src/git-http.test-support.ts` answers
smart HTTP with the system `git http-backend`, and
`src/git-demo-server.test-support.ts` serves it on loopback for the Todos and
Git lab development commands; neither is in the package's exports.

## Limits

Browser data reaches a disk tool through synchronization or export, not
through an IndexedDB key. Each save changes one file; there is no multi-file
transaction, so a caller that keeps a row beside a media file saves the media
first. A Bun folder hears no other program's edits. File bytes cross the
desktop bridge whole. Older OPFS folders are not read by the current opener.
