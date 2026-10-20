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
| Desktop app (Tauri) | `openFolder({ tables })` | The directory the shell bound to this window before the window existed. The page names no path, scope, or window. |
| Bun | `openFolder({ directory, tables })` | The existing directory at the path `directory`. |

Opening needs no app ID, account, remote, network, or schema file. It
creates no Git history or authored files. The desktop shell may create its
fixed default directory when it launches the window, never when the page
opens it
([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)). See
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
| `@epicenter/folder` | Acts as `/browser` in a browser and `/tauri` in the desktop app. `openFolder({ tables })` opens the origin's folder or the window's folder. Only the chosen engine is loaded. A build may alias this exact specifier to one entry. | Ordinary application code that runs in both. |
| `@epicenter/folder/browser` | `openFolder({ tables })`. Refuses inside the desktop app. | A web-only build. |
| `@epicenter/folder/tauri` | `openFolder({ tables })` and `updateSavedView(change)` for the folder the shell bound to this window. Refuses outside the desktop app. | A desktop-only build. |
| `@epicenter/folder/bun` | `openFolder({ directory, tables })` over a path, and the `epicenter` CLI's tools ([below](#cli-tools)). | Command-line tools, scripts, and tests given a directory. |
| `@epicenter/folder/file-browser` | Path helpers, visible tree rows, newline preservation, and `readTextFile`. Opens nothing. | A file tree or a file view. |
| `@epicenter/folder/declaration` | Portable declaration schemas, app-schema export, section readers, and saved-view types. Opens nothing. | Reading or distributing a folder's schemas and view settings. |
| `@epicenter/folder/documents` | Saved Markdown documents with optional schema diagnostics, including root and nested paths. | Generic file, grid, board, or SQL interpretation. |

Every opening entry exports the same contract (`contract.ts`): the `Folder`
type and its parts, `DefaultFolderOptions`, `DirectoryFolderOptions`,
`OpenFolderError`, `ReadError`, and `SaveError`. Importing an entry opens
nothing.

## Opening

`openFolder` returns `Result<Folder<TTables>, OpenFolderError>`. A refusal is
returned, never thrown, and no opener opens other storage instead.

| `OpenFolderError` | When |
| --- | --- |
| `InvalidTable` | A table name that cannot be one portable top-level directory, checked by the shared `pathProblem` rule in both engines. |
| `Unavailable` | Storage could not be reached: no IndexedDB, or a shell that cannot answer. |
| `InsideTauri` | The browser entry was called in the desktop app. |
| `NotTauri` | A desktop directory was asked for outside the desktop app. |
| `NotBound` | Desktop: the shell bound no folder to this window. |
| `Missing` | Desktop: the window's folder is gone. Opening never makes it again. |
| `ShuttingDown` | Desktop: the shell is shutting its folders down. |
| `InvalidRoot` | Bun: the path is not a directory, or has no parent to hold its save lock. Desktop: the page passed a `directory`, which the desktop opener never takes. |

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

The current saved folder is one immutable working tree, sharing objects with
received and exact-sending Git checkpoints. Local saves create no Git commit.
This is a clean break under a zero-user assumption: there is no migration from
the earlier IndexedDB overlay or declaration-dependent OPFS folders. Those
older stores are not opened or changed.

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
the path, so another program sees the old file or the new one. On Unix the
scratch directory is `0700`, and each staged file is `0600` before any bytes
are written. On macOS neither keeps an access control entry, such as an
`everyone allow read` the parent passes on, which would let other accounts
past those bits; one that cannot be removed refuses the save before its bytes
are written. Opening tightens a scratch directory left open by an older
version, entries included. A replacement keeps the file's permission bits; a
new file is `0600`. On Windows, access follows the parent's ACLs. CLI
history stages beside the directory too; it leaves old
`.git/epicenter/scratch` files alone. Each rename
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

The shell bound one existing directory to this window before the window
existed (`tauri-plugin-epicenter-folder`). Opening asks the shell to open it
(`open_folder`, with no arguments); the page then reads and saves only
through the shell's storage commands, one per storage method (`tauri-files.ts`,
[ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)),
each answered in the calling window's directory. No command names a root,
scope, or window.
The shell checks every path, stages and renames each save, and checks its
expected bytes under the same save lock. A command whose reply was lost counts
as landed only when the path holds what was sent. Nothing watches the directory:
`onChange` reports saves made through this page's handles. The shared UI context
(`@epicenter/svelte/folder`) polls active queries while visible to discover edits
from other windows and programs. Reading the handle directly always reads disk.

## Helpers

`@epicenter/folder/file-browser` provides path helpers, `visibleRows` for a
file tree over a `{ files, directories }` listing, `withFileNewlines`, and
`readTextFile(files, path, maxBytes)` over a folder's `files`. Text
classification keeps the file's byte-order mark; invalid UTF-8 and NUL bytes
open as binary details, and a file larger than `maxBytes` is `tooLarge`
without being read.

## Portable schemas and generic documents

`@epicenter/folder/declaration` owns `DeclarationSchema`, its derived types,
and purpose-specific readers. The generated [JSON Schema](epicenter.schema.json)
comes from that TypeBox source. Regenerate it with `bun run schema:generate` in this
package. The root declaration has independently optional `tables` and `views`.
Each table retains its complete object schema, including `$defs`, required
properties, and annotations. The supported schema grammar rejects unknown
assertion keywords, runtime callbacks, and unresolved references.

Apps keep their TypeBox source and inferred types. To distribute a schema,
call `exportTables(appTables)` from the declaration entry in a trusted build
script and serialize its successful result. An explicit import copies those table definitions into a
data folder. Opening or updating an app publishes nothing. Imported JSON cannot
supply new compile-time TypeScript types to application source.

`@epicenter/folder/documents` reads saved Markdown through an existing handle's
files, with optional declared schemas. Root-relative paths identify documents;
root-level and nested Markdown are included. Missing frontmatter means empty
fields and the full body. Malformed frontmatter retains source and diagnostics.
This reader leaves the stricter app table contract unchanged.

Schema imports and generation patch selected declaration sections with
conditional writes. A stale write rereads and reapplies its change; JSON line
merge cannot safely preserve two section changes sharing a line. Duplicate keys
and numeric values that cannot survive serialization stop a replacement, with
the original source available for repair. Ordinary source editing and Git merge
still merge JSON by line.

### Saved views

`SavedView` describes a grid, board, or SQL configuration. `views` maps opaque
folder-local keys to those configurations; the editor creates UUID keys, and
changing a view's `title` keeps its key. Grid and board entries name one
top-level directory in `table`, including a directory with no declared schema.
They retain `columns`, `filters`, and `sort`; boards also name `groupBy`.
SQL entries retain a statement. These records contain no live result, window,
native path, card rank, or personal override.

`readSavedViews(text)` returns usable entries and a diagnostic for each invalid
or unsupported sibling. It does not replace those siblings with defaults.
`SavedViewSchema` and its inferred types come from the same TypeBox source as
the declaration. An invalid views section does not disable table checking or
protective `local` rules, which have separate readers.

`updateSavedView({ key, base, value })` from `@epicenter/folder/tauri` changes one
entry in the invoking window's bound directory. `base: undefined` witnesses
absence; `value: undefined` deletes the entry. A conditional write rereads and
patches the latest source, preserving tables, metadata, and every other view.
A changed target entry returns a conflict; a retry whose desired entry already
landed succeeds. A first explicit view save can create `{"views": {...}}`
without inventing tables or initializing Git. Opening and browsing write nothing.
The writer is a desktop capability, separate from the browser Folder API.

The generic editor owns unfinished view settings and each SQL execution by view
key. It also fences the declaration's raw source draft before structured saves.
Grid cells, board moves, and Files share the editor's existing file drafts;
the declaration supplies presentation settings rather than another record store.

## CLI tools

`@epicenter/folder/bun` also holds what the `epicenter` CLI runs over a
directory it is given (ADR-0520). None of it opens a `Folder`.

| Export | Does |
| --- | --- |
| `checkFolder`, `queryFolder`, `readFolder` | Read the root `epicenter.json` and every table it declares, sort what does not conform, and answer one read-only SQL statement over the rows that do (ADR-0632). |
| `defineFolder`, `defineTable`, `field`, `formatDefinition` | The retained TypeScript authoring workflow used by `generate`. |
| `exportFolderSchemas`, `importFolderSchemas` | Explicit table-schema exchange through the root declaration. |
| `generateDefinition` | The older `epicenter generate`: runs a folder's `epicenter.ts` and writes its `epicenter.json` (ADR-0527), until its callers migrate. It preserves unrelated sections and refuses to drop any existing `local` pattern. Each conditional write rereads and rechecks after a concurrent change. |
| `runHistory`, `historyExitCode`, `encodeHistory`, `holdingHistoryLock` | One history operation (`status`, `log`, `saveVersion`, `sync`) over the system `git`, as the CLI runs it (ADR-0559). |
| `holdingFileLock`, `createGitRunner`, `runGit`, `locateGit`, `GitMissingError`, `neutralizeAttributes`, `basicAuthorization`, `nodeDirectoryPrimitives` | The lock, `git`, and file helpers the CLI's other commands share. |

`readFolder` requires declared `tables` in `epicenter.json`. A directory without
the file is `NotDataFolder`; absent or unusable tables are `InvalidDefinition`.
Unusable views or local rules stay with their own readers. It writes nothing, takes no lock, and follows no link.

Git is not on a `Folder`'s lifetime (ADR-0636). The history engine under
`src/git/` stays for exchange: `runHistory` opens a directory's history for
one operation, reads only `local` from `epicenter.json` so no commit carries
a path it names, tracked or not, and holds the history lock across a save
version or a sync. It prepares no table schema. A commit reads `local` from
the very `epicenter.json` bytes it records, and no pattern may match that
file itself. Every pattern seen during the operation holds until it ends,
including one a remote's `epicenter.json` newly declares, which keeps its
files off this disk too. Sync stops before writing anything here when the
`epicenter.json` it would bring here drops a rule this folder's file still
lists or one the remote newly declares, or is gone where the folder had one,
and stops before sending when a commit the remote does not hold yet adds or
changes a path a rule keeps local; it never rewrites history. It checks the
file again as it writes it, under the save lock and against the live bytes,
so a rule saved here while Sync runs survives or stops the publish. The browser engine's own Git exchange is in
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
| `src/boundary.ts`, `directory-store.ts`, `directory-node.ts`, `directory-primitives.ts`, `tauri-files.ts` | Directory storage over `node:fs` and over the shell's commands. |
| `src/check-folder.ts`, `query-folder.ts`, `read-folder.ts`, `projection.ts`, `declaration.ts`, `definition.ts`, `row-text.ts`, `generate-declaration.ts` | The CLI's readers of `epicenter.json`; `row-text.ts` uses the shared row codec. |
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
