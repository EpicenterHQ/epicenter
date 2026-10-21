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
const saved = await folder.tables.notes.set('milk', null, { fields: { title: 'Milk' } });
if (saved.error !== null) return show(saved.error.message);      // nothing was saved

// The folder's edit of a row: its document and typed input, saved a pause after the last change.
const rowEdit = folder.tables.notes.edit('milk');
const read = await rowEdit.read();                                // the row, undefined when absent
if (read.error !== null) return show(read.error.message);
rowEdit.change({ fields: { done: true }, body: 'Two litres\n' }); // over what getRow() shows
rowEdit.getRow();                         // the stored row with held input over it
folder.getStatus();                       // { saving, storageFailure, unsaved, failures, closing }
await folder.settle();               // send held input now; answers what did not save
const unsaved = await folder.close(); // sends held input once; answers what did not save
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
| `@epicenter/folder/edits` | The vocabulary of a path's editable document and typed input (`RowEdit`, `TextEdit`, `RowEditChange`, `Pending`, `ExclusiveFile`, `ActionError`, …) over `folder.tables.<name>.edit(id)` and `folder.files.edit(path)` ([below](#unsaved-input)), `ReadStatus`, and `mergeText`, the folder's line merge of whole texts. Opens nothing. | Code that names those types. |

Every opening entry exports the same contract (`contract.ts`): the `Folder`
type and its parts, `DefaultFolderOptions`, `DirectoryFolderOptions`,
`OpenFolderError`, `ReadError` and `SaveError`. Importing an entry opens
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
| `files` | `list(prefix?)` sorted root-relative paths; `read(path)` `{ path, content: Blob }` or `undefined`; `write(path, from, content)`; `delete(path, from)`; `edit(path)`, the file's editable document and typed input. |
| `tables.<name>` | A view of rows at `<name>/<id>.md`: `list()`, `get(id)`, `set(id, from, change)`, `delete(id, from)`, and `edit(id)`, the row's editable document and typed input. Adjacent files are available through `folder.files`. |
| `onChange(listener)` | Runs after a save commits: `change.paths`, or `null` when any path may differ, and `change.origin`, `this-handle` or `other-handle`. A save of this handle whose content was already stored is reported to this handle's listeners too. Returns the function that stops listening. |
| `getStatus()`, `onStatusChange(listener)` | `{ saving, storageFailure, unsaved, failures, closing }`: a save, delete or exclusive change running; the last storage failure; the paths holding typed input; held input whose save failed; whether close was called. Typing, discarding and a fence change it without any storage call. |
| `settle()` | Sends new input once, leaving failed input held for retry or a change, after running deletes and exclusive changes, and waits for saves already started, direct ones included, never for reads. Answers the input that did not save. |
| `close()` | At once, new input is refused and every storage call (reads, saves, deletes, `onChange`, `onStatusChange`, `settle`) throws; running deletes and exclusive changes finish; new input is sent once and failed input stays held for recovery; saves already started finish with their real outcome; reads still running are not waited for; then listeners and storage are released. Held input stays readable: `getStatus()`, and `edit(...)` handles, whose `getRow()`, `getText()`, `getPending()` and `discard()` answer, whose `read()` rejects, and whose `save()` and `retry()` join the close. Answers the input that did not save. Calling it again returns the same promise. |

Open options: `saveAfterMs`, how long after its last change typed input
saves (a trailing pause, `SAVE_AFTER_MS` = 1000 by default), a finite
number of milliseconds from 0 up; any other value throws a `RangeError`
before anything opens.

The saves of one path through one handle run one at a time, in call order,
direct saves and saves of typed input alike; saves of different paths run
side by side.

A storage call on a closed handle throws: it is a programming error, not a
storage failure.

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

### Unsaved input

The folder holds each path's editable document and what a person typed and
has not saved, for its whole life (`edit-owner.ts`,
[ADR-0656](../../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)).
`folder.tables.<name>.edit(id)` answers a `RowEdit` and
`folder.files.edit(path)` a `TextEdit`: objects over one document,
one input and one save queue per path, shared by every caller of the
handle. Making one reads and holds nothing. There is no other owner to
attach, and no UI framework or cache.

```ts
const rowEdit = folder.tables.notes.edit(id);
const { data: row, error } = await rowEdit.read(); // the row, or undefined when absent
rowEdit.getRow();         // what is stored, with held input in it; reads nothing
rowEdit.getReadStatus();  // { known: 'nothing' | 'missing' | 'file' | 'not-text', reading, error }
rowEdit.change({ fields: { done: true }, body: 'Two litres\n' }); // one change, over getRow()
rowEdit.getPending();     // the held input, or undefined
rowEdit.isLocked();       // whether input is refused
await rowEdit.save();     // or wait `saveAfterMs`

const textEdit = folder.files.edit('notes/a.md');
await textEdit.read();
textEdit.getText();                     // the held text, held fields over the file, or the file
textEdit.change(editedText);            // the whole exact text
textEdit.changeFields({ title: 'x' });  // fields of any Markdown file
await textEdit.exclusive(async (file) => file.write(before, next)); // the file alone
```

`change` and `changeFields` synchronously return `Result<void, ChangeError>`.
`Ok(undefined)` means the input was accepted into memory, not saved. `Err`
explains why it was refused: an operation lock, nothing known to type over (`NoSource`: not read yet, or no file), a file
that is not text (`NotText`), or fields that cannot be applied. A refusal leaves earlier input intact. `save()` and
`retry()` resolve after their attempt; `getPending().error` and folder
status report persistence failures.

The Svelte adapter exposes tracked getters (`.row`, `.text`, `.pending`,
`.readStatus`, `.locked`) over the core read methods. The React hooks keep the
explicit methods over render snapshots. Both share the core commands and read
the file the first time a view asks for its document with nothing known and
no failed read. See `@epicenter/svelte/edits` and `@epicenter/react/edits`.

- **The document.** Each path holds what is stored there as last known: its
  exact content, no file, or nothing known yet. `getRow()` answers the
  stored row with held input put into its source and read again, so its
  fields, body, text and issues agree; over a source whose frontmatter does
  not parse, the held input shows over it with the source's issues.
  `getText()` answers held text, held fields over the file, or the file as
  text with any byte-order mark kept. Both are `undefined` while nothing is
  known, when no file is there, and `getText()` when it is not text (strict
  UTF-8 without NUL); `getReadStatus()` says which, whether a read runs, and
  why the last read failed. Every answer keeps its identity until what it
  answers changes, the row's beside the text's. `read()` answers `Ok` with
  what the edit shows afterwards, or the `ReadError`, which every read
  joining it shares; a failed read keeps what is shown, held input
  included. It rejects once the folder closes.
- **What keeps it current.** `read()`; the handle's own row `list()` and
  `get(id)`, which answer the documents of their rows; its file `read(path)`
  of a path an edit holds; and each save of the handle, which hands over the
  exact content storage kept, merged with what landed meanwhile, before the
  save resolves. So a landed save shows at once without a reread, and a
  failed reread never shows older text. A read that started before newer
  knowledge of the path arrived, such as a save that committed meanwhile,
  changes nothing; one that started after a save's commit is newer than it.
  A change another handle or a sync reported is read again for a path
  someone subscribes to, holds input for, or reads; any other document stays,
  as older than the change, so a list action typed over it still merges
  with storage, and is read again once someone subscribes. A document no one
  subscribes to any more is let go. An action (`exclusive`), a direct save or
  a status subscription alone holds no document, so an audio file is never
  kept. The folder watches no directory: a view polling its lists, or its
  own read (`@epicenter/svelte`'s `queries.read(edit)`), keeps it current.
- **Bases.** A change types over what the edit shows now: a held unit is
  replaced, a revert included. Each typed field, and the body, keeps a base:
  its value in the document when first typed, or what the last landed save
  sent for it. So a value typed back to what is stored still saves, and an
  outside change read while a save runs survives beside a revert typed over
  it. Whole text keeps the content it was first typed over, or the text the
  last landed save sent. A row save starts from the latest document typed
  over whose frontmatter parses, with every base put in; a field typed over
  a header another writer broke is refused (`Unparseable`) and the raw text
  stays repairable through `folder.files.edit(path)`.
- **Line merge.** `mergeText(base, current, change)` is the rule a save
  applies to a body or text: what `change` did to `base`, merged by line
  into `current`, `change` winning a region both changed. The React hooks
  use it so a handler of the committed render keeps a change the same event
  already made through another handler.
- **Fields of any file.** `changeFields` holds a patch that a save applies to
  the file as stored then, so it needs nothing read; a file known missing or
  not text refuses it. Removal (`undefined`) stays apart from `null`. A
  failed patch stays held like every other kind of input; an ordinary save
  never reapplies it to a file repaired or recreated since its refusal.
  Text typed over held fields keeps them and takes the patch's place.
- **Views of one edit.** Row and text handles expose the same path's pending
  input, save queue and fence. `getRow()` parses the current editable text,
  including unsaved whole-file input; `getText()` includes applicable row and
  field changes. Row changes patch held text. Whole-file typing takes over
  applicable row or field input, retaining its merge base, including when a
  save is running. Neither a view switch nor a read saves or retries input.
  Unapplied fields stay copyable in `getPending()` and refuse conversion to
  whole text until repaired or explicitly discarded. Both handles can save,
  retry or discard whichever representation is held.
- **Saving and retry.** `save()` sends new input now or joins its running
  attempt. An accepted input whose save fails stays held with its `SaveError`:
  autosave, blur, `settle()`, delete, exclusive actions and close do not retry
  it. `retry()` explicitly authorizes one more attempt, while accepted new
  input clears the older error and may autosave. Retry during a running
  attempt joins it rather than scheduling another attempt after failure.
  Both commands resolve when the attempt finishes, including failure; inspect
  `getPending()` for the outcome. `discard()` explicitly releases held input.
- **Fence.** `delete()` and `exclusive(action)` take the path at once, send
  new input once, and refuse with `ActionError.NotStarted` (`DELETING`,
  `BUSY`, `UNSAVED`, `CLOSING`) if another action holds it, the folder closes,
  or input did not save. `action` reads and saves through its `file`, which
  works while the folder closes and ends with the action.
- **Close.** From `close()` on, `save()` and `retry()` join the close and send
  nothing new.
- Every answer of `getRow()`, `getText()` and `getPending()` is immutable and
  kept until the path changes. `subscribe(listener)` calls `listener()` after
  anything the edit answers may have changed, which suits
  `useSyncExternalStore`.

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
the declaration. An invalid views section does not disable table checking. Git operations do
not interpret the declaration.

`updateSavedView({ key, base, value })` from `@epicenter/folder/tauri` changes one
entry in the invoking window's bound directory. `base: undefined` witnesses
absence; `value: undefined` deletes the entry. A conditional write rereads and
patches the latest source, preserving tables, metadata, and every other view.
A changed target entry returns a conflict; a retry whose desired entry already
landed succeeds. A first explicit view save can create `{"views": {...}}`
without inventing tables or initializing Git. Opening and browsing write nothing.
The writer is a desktop capability, separate from the browser Folder API.

The generic editor owns unfinished view settings and each SQL execution by view
key. A structured save of the declaration runs as an exclusive change of
`epicenter.json`, after its held source input saves. Grid cells, board moves,
and Files share the folder's file edit handles;
the declaration supplies presentation settings rather than another record store.

## CLI tools

`@epicenter/folder/bun` also holds what the `epicenter` CLI runs over a
directory it is given (ADR-0520). None of it opens a `Folder`.

| Export | Does |
| --- | --- |
| `checkFolder`, `queryFolder`, `readFolder` | Read the root `epicenter.json` and every table it declares, sort what does not conform, and answer one read-only SQL statement over the rows that do (ADR-0632). |
| `defineFolder`, `defineTable`, `field`, `formatDefinition` | The retained TypeScript authoring workflow used by `generate`. |
| `exportFolderSchemas`, `importFolderSchemas` | Explicit table-schema exchange through the root declaration. |
| `generateDefinition` | The older `epicenter generate`: runs a folder's `epicenter.ts` and writes its `epicenter.json` (ADR-0527), until its callers migrate. It preserves unrelated sections. Each conditional write rereads and reapplies after a concurrent change. |
| `runHistory`, `historyExitCode`, `encodeHistory`, `holdingHistoryLock` | One history operation (`status`, `log`, `saveVersion`, `sync`) over the system `git`, as the CLI runs it (ADR-0559). |
| `holdingFileLock`, `createGitRunner`, `runGit`, `locateGit`, `GitMissingError`, `neutralizeAttributes`, `basicAuthorization`, `nodeDirectoryPrimitives` | The lock, `git`, and file helpers the CLI's other commands share. |

`readFolder` requires declared `tables` in `epicenter.json`. A directory without
the file is `NotDataFolder`; absent or unusable tables are `InvalidDefinition`.
Unusable views stay with their own reader. It writes nothing, takes no lock, and follows no link.

Git is not on a `Folder`'s lifetime (ADR-0636). The history engine under
`src/git/` stays for exchange: `runHistory` opens a directory's history for
one operation and holds the history lock across a save version or a sync.
It requires no declaration and interprets no table schema. Tracked files remain
tracked; untracked files enter a commit unless Git ignores them. Ignore rules
come from captured repository `.gitignore` files. Native Git also honors
its machine-specific excludes. The browser engine's own Git exchange is in
`src/browser/` ([its README](src/browser/README.md)).

A missing `.gitignore` is valid. To keep new recordings local, save
`/audio/` in the root `.gitignore` before the audio is committed.
Adding that rule does not untrack earlier commits, censor incoming tracked
files, or cancel an exact pending send. Deleting the rule makes previously
ignored untracked files eligible. There is no declaration-level `local`
policy or binary-file admission policy. Finder files such as `.DS_Store` use
the same rules; add a `.gitignore` line to exclude them.

An app can maintain required exclusions through ordinary read-modify-write.
Read the current file, retain unrelated rules, compute the desired contents,
and pass the exact read as `from` to `files.write`. Skip unchanged contents.
Rule order and exceptions matter; checking for a literal line is insufficient.
An app that maintains a rule can restore it after someone removes it. Later
writers and sync can still change the file, and already-tracked paths stay tracked.

For an explicitly new file, the write is:

```ts
const saved = await folder.files.write('.gitignore', null, '/audio/\n');
if (saved.error !== null) return show(saved.error.message);
```

This saves an ordinary local file, without creating a Git commit. A later
commit or sync records it normally. The example assumes an explicitly new file;
an edit of existing rules supplies the exact bytes read as `from`. The folder
opener, Git initialization, and clone do not add or restore rules. App-maintained
startup updates use the same files API. There is no generic template API,
app-version ledger, or first-use flag.

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
| `src/handle.ts` | The caller-facing handle every engine shares: status, the close fence, the saves close waits for (one at a time per path), and the read notes. |
| `src/local-folder.ts`, `src/browser/` | The browser's default local folder over the IndexedDB repository engine. |
| `src/native/` | The directory engine (`engine.ts`), its Bun host and save lock (`bun.ts`, `directory.ts`), and its desktop host (`tauri.ts`, with `bindings.gen.ts` generated from the folder plugin; do not edit). |
| `src/shared/` | The content merge and row reading every engine uses, Markdown documents at any path (`document.ts`). |
| `src/boundary.ts`, `directory-store.ts`, `directory-node.ts`, `directory-primitives.ts`, `tauri-files.ts` | Directory storage over `node:fs` and over the shell's commands. |
| `src/check-folder.ts`, `query-folder.ts`, `read-folder.ts`, `projection.ts`, `declaration.ts`, `definition.ts`, `row-text.ts`, `generate-declaration.ts` | The CLI's readers of `epicenter.json`; `row-text.ts` uses the shared row codec. |
| `src/git/`, `history-wire.ts`, `write.ts` | Shared Git object and tree rules, the directory history engine `runHistory` runs, and the one write its Sync publishes through. |
| `src/file-browser.ts` | File-browser helpers. |
| `src/edit-owner.ts`, `edits.ts` | The owner of typed row, text and field input over one handle for its whole life, and the vocabulary entry. |
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
