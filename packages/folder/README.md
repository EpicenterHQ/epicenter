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
const saved = await folder.tables.notes.write('milk', { fields: { title: 'Milk' } });
if (saved.error !== null) return show(saved.error.message);      // publication was not confirmed

// One shared document, interpreted through the notes schema.
const fileDocument = folder.tables.notes.document('milk');
const acquired = await fileDocument.refresh();
if (acquired.error !== null) return show(acquired.error.message);
const stopObserving = fileDocument.subscribe((snapshot) => render(snapshot)); // snapshot now; follows changes
const changed = fileDocument.patch({ fields: { done: true }, body: 'Two litres\n' });
if (changed.error !== null) return show(changed.error.message); // accepted in memory; autosave follows
fileDocument.getSnapshot();              // { content, loadError, isDirty, isSaving, saveError }
folder.getStatus();                  // { saving, savingPaths, storageFailure, unsaved, failures, closing }
folder.flush();                      // submit held input now, without waiting
folder.close();                      // release synchronously; unfinished input may be lost
```

## Entries

| Import | Exports | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | Acts as `/browser` in a browser and `/tauri` in the desktop app. `openFolder({ tables })` opens the origin's folder or the window's folder. Only the chosen engine is loaded. A build may alias this exact specifier to one entry. | Ordinary application code that runs in both. |
| `@epicenter/folder/browser` | `openFolder({ tables })`. Refuses inside the desktop app. | A web-only build. |
| `@epicenter/folder/tauri` | `openFolder({ tables })` for the folder the shell bound to this window. Refuses outside the desktop app. | A desktop-only build. |
| `@epicenter/folder/bun` | `openFolder({ directory, tables })` over a path, and the `epicenter` CLI's tools ([below](#cli-tools)). | Command-line tools, scripts, and tests given a directory. |
| `@epicenter/folder/file-browser` | Path helpers, visible tree rows, newline preservation, and `readTextFile`. Opens nothing. | A file tree or a file view. |
| `@epicenter/folder/declaration` | Portable declaration schemas, app-schema export, section readers, saved-view types, and the pure view transform. Opens nothing. | Reading or distributing a folder's schemas and view settings. |
| `@epicenter/folder/documents` | Saved Markdown documents with optional schema diagnostics, including root and nested paths. | Generic file, grid, board, or SQL interpretation. |
| `@epicenter/folder/document` | Live document vocabulary for `folder.tables.<name>.document(id)` and `folder.files.document(path)` ([working documents](#working-documents)): `FileDocument`, `DocumentSnapshot`, `MarkdownContent`, `DocumentPatch`, `LoadError`, `ChangeError`, `ActionError`, `SaveFailure`, `SAVE_AFTER_MS`. Opens nothing. | Code that names those types. |

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
| `files` | `list(prefix?)` sorted root-relative paths; `read(path)` `{ path, content: Blob }` or `undefined`; `write(path, content)`; `delete(path)`; `document(path, schema?)`, a handle to the path's working source. |
| `tables.<name>` | A view of rows at `<name>/<id>.md`: `list()`, `get(id)`, `write(id, document)`, `delete(id)`, and `document(id)`, a handle to the path's working source through the table schema. Adjacent files are available through `folder.files`. |
| `onChange(listener)` | Runs after a write commits: `change.paths`, or `null` when any path may differ, and `change.origin`, `this-handle` or `other-handle`. A write of this handle whose content was already stored is reported to this handle's listeners too. Returns the function that stops listening. |
| `getStatus()`, `onStatusChange(listener)` | `{ saving, savingPaths, storageFailure, unsaved, failures, closing }`: whether writes or deletes are unsettled, and their paths; the last storage failure; the paths holding accepted input; held input whose last publication failed, as `{ path, error }`; whether close was called. The text lives in the document snapshot. |
| `flush()` | Best-effort submission of held input no admitted command owns, failed input included. Returns nothing and does not wait. |
| `close()` | Synchronously refuses new work, stops autosave, and releases listeners and storage. Submits no held input and waits for no writes. Returns nothing; repeated calls do nothing. Documents stay readable. |

Open options: `saveAfterMs`, how long after its last change typed input
saves (a trailing pause, `SAVE_AFTER_MS` = 1000 by default), a finite
number of milliseconds from 0 up; any other value throws a `RangeError`
before anything opens.

The writes and deletes of one path through one handle run one at a time, in
call order, direct ones and documents' alike; writes of different paths run
side by side.

Await the actual write or editor save you started when you need durable bytes.
Close does not submit held input or wait for per-path queues.

A new storage call after `close()` starts throws: it is a programming error,
not a storage failure. Calls submitted before close keep their own outcomes.

New file and row names follow the portable path rule. Earlier files with a
nonportable but structurally safe name remain readable, and a write or delete
may replace or remove one while it is still there; a new file cannot be
created under that name. Each host checks this where the change lands
(`Expectation` in `boundary.ts`). `HEAD` remains read-only because changing it
can turn a plain directory into Git state.

### Rows

A row adds `id` to `{ text, body, fields, issues }`. `text` is the file's exact
source. When frontmatter fits the table's schema, `issues` is `null` and
`fields` has the schema's type. A schema mismatch retains the raw fields.
Uninterpretable frontmatter exposes `fields: undefined`; `body` is available
only after a closing fence establishes its boundary. Issues name the reason,
each `{ kind, message, path, line? }`:

| `kind` | The file |
| --- | --- |
| `schema` | parses, and a field does not fit the schema |
| `frontmatter` | has an opening fence but no closing fence, or has YAML that cannot be parsed |
| `not-text` | is not UTF-8 text without NUL |

A schema only interprets. It never refuses a save, and unknown fields,
comments, and repairable frontmatter survive field and body edits. A row that does not
fit is read, shown, and repaired, not dropped. `list()` reads every `.md`
file directly in the table's directory; a missing directory is an empty
table, and reading creates nothing.
With no opening fence, the whole file is body and fields are empty.

### Saving

Direct writes are unconditional: no write names the content it started
from, and the last one to land wins.

- `files.write(path, content)` replaces whatever is at `path` with text or
  bytes, or makes the file. Pass bytes for a binary file or to keep a
  byte-order mark; a byte array is copied when the method is called.
- `files.delete(path)` removes the file. A file that is not there is
  already deleted, which is success.
- `tables.<name>.document(id).save({ fields?, body? })` patches acquired
  working text and publishes its exact captured content. Its awaited result is
  `Result<MarkdownContent<Schema>, ChangeError | SaveError>`: `NoContent`
  refuses before acquisition; accepted patches remain pending with `saveError`
  after publication fails. `undefined` removes a field; `body` replaces the
  body. Later typing builds on the accepted patch. A field edit of broken
  frontmatter is `InvalidFields`; a body edit can still land. The schema
  never refuses a save.
- `tables.<name>.write(id, { fields?, body? })` publishes a complete new row,
  creating or replacing the file unconditionally. Omitted fields and body are
  empty, and the id must be nonempty. It returns `Result<Row, SaveError>` with the exact published row and
  accepts no autosave input on failure. Use this for a form's new-file submission;
  keep the same chosen id for retry. It has no create-only or conflict guard.
- `tables.<name>.delete(id)` removes only the row file. Adjacent files stay.

Every write and delete of a path through one handle, document saves included,
runs in one lane in call order, and each reports its own outcome; writes of
different paths run side by side. Sync and history keep their own
conditional publication (`write.ts`, `git/history.ts`), which merges by the
shared content rules (`shared/merge.ts`, ADR-0622).

A raw write, row `write`, or delete acknowledges only the input it captured,
after success. Failure leaves that original input held and never accepts the
replacement payload as input; an interrupted autosave resumes with the original
input. A document `save(input)` accepts its input, captures its interpreted
content, and admits publication before observers can change the document.
Success confirms that exact snapshot, even if newer input is already pending.
Failure retains the accepted patch for explicit save or flush, without an
unbounded automatic retry.

| `SaveError` | When |
| --- | --- |
| `InvalidPath`, `InvalidId` | A path or row ID the folder cannot address, or a new file under a name only some disks hold. |
| `Occupied` | A file stands where a directory is needed, or the reverse. |
| `CaseTwin` | A new path that differs from a stored one only by case. |
| `NotText` | Text with NUL or unpaired surrogates, or a row edit of a file that is not text. |
| `Unparseable` | A complete row's fields cannot be serialized. Structured edits instead refuse `InvalidFields`. |
| `StorageFailed` | Publication could not be confirmed, with its reason. A lost reply may follow a completed write. |

A failed save returns its error and keeps accepted input available for retry.
`status.storageFailure` holds the last `StorageFailed` until a later
successful write on this handle. `status.saving` is true while any write or
delete is admitted and not settled. Structural refusals are the caller's to
show, not status.

### Working documents

The opened Folder owns one working source and one command lane per path for
its whole lifetime. `folder.files.document(path, schema?)` and
`folder.tables.notes.document(id)` return stable `FileDocument` handles to it.
A table binds its schema: `tables.notes.document(id)` is the same handle as
`files.document('notes/<id>.md', notesSchema)`. Repeated calls with the same path
and schema return that handle. Different schemas interpret the same source.
Obtaining a handle performs no I/O and installs no listeners.

`folder.files.document(path)` and `folder.tables.notes.document(id)` synchronously throw `RangeError`
for structurally unreadable addresses, before creating document state. A table
ID names one row stem: `folder.tables.notes.document('a/b')` is refused; use
`files.document('notes/a/b.md')` for that nested path. The check does not inspect
storage or enforce portability for a new name. Legacy IDs such as `''` and
`'a: b'` remain addressable; saving applies the existing publication rules.

```ts
const document = folder.tables.notes.document(id);
const stop = document.subscribe((snapshot) => render(snapshot)); // snapshot now, then changes
const { content, loadError, isDirty, isSaving, saveError } = document.getSnapshot();
// content: { text, body, fields, issues } | undefined
const acquired = await document.refresh();
if (acquired.error !== null) return show(acquired.error.message);
const saved = await document.save({ fields: { done: true }, body: 'Two litres\n' });
if (saved.error !== null) return show(saved.error.message);
renderPublished(saved.data); // exact captured Markdown content, without a row id
const dropped = document.discard(); // the text dropped, if any; writes nothing
stop(); // stop this observation; the folder retains the source and accepted work
```

```ts
type DocumentSnapshot<Schema> = {
  content: MarkdownContent<Schema> | undefined;
  loadError: LoadError | undefined; // Missing | NotText | ReadFailed
  isDirty: boolean;
  isSaving: boolean;
  saveError: SaveError | undefined;
};
```

`getSnapshot()` is pure and cached: it reads nothing, and answers the same
frozen object until something in it changes. `subscribe(listener)` calls the
listener with the current snapshot at once, then with each new one, and the
first subscription establishes read demand when nothing has been read yet or
the source was invalidated while nobody watched. Each subscriber owns its own
observation. The last unsubscribe stops further read demand after any ongoing
read, while the Folder retains acquired text, input, timers, saves, and failures.
There is no per-component document session to close.

`refresh()` reads after the path's admitted writes and answers
`Result<void, LoadError>` with what the first read to start after the call
found; a read already running never answers it, and a file that keeps
changing cannot hold it off. A read overtaken by a newer change still shows
its text when that is newer than anything installed, superseding an older
`loadError`, and subscribed documents read again until one applies. If the folder closes before a refresh answers, it reports `ReadFailed`
when its pending I/O returns. Close neither waits for nor cancels that I/O.

`content` is the latest accepted input, or the last text read. Its `text` is
the exact source; `fields`, `body` and `issues` interpret it through the
document's schema, with `issues === null` proving valid typed fields. Absent
content with no `loadError` means text is awaited; absent with a `loadError`,
acquisition failed. Once acquired, text stays for the folder's life: after
unmounting, a delete, a binary replacement, or a failed read, each reported
as the latest `loadError`. A successful text read clears it; input does not.

Lists, row gets, and raw file reads return stored data without acquiring or
updating working documents. Only a document's own read or a successful command
of this handle updates its known text. A subscription acquires an unknown or
invalidated source even if a list already returned the row. Await
`document.refresh()` before a one-off patch on an unopened row or an inactive
clean document: retained text may be stale even when present. Refresh preserves
dirty input. Keep a subscription for interactive use. Fresh list rows take
precedence over clean inactive snapshots; only dirty input overrides them.

Use separate commands for complete source and structured patches:

```ts
document.replace(completeSource);
document.patch({ fields: { title: 'Milk' }, body: 'Two litres\n' });
```

`replace(text)` accepts complete source, even before the first read.
`patch({ fields?, body? })` applies a `DocumentPatch<Schema>` to acquired text.
It refuses with `NoContent` before there is text, or `InvalidFields` when it
cannot identify the region (fields of broken frontmatter). Both return
synchronous `Result<void, ChangeError>` for acceptance into memory and start
autosave. Invalid text (NUL or unpaired surrogates) refuses before acceptance.
Show immediate refusals at the input boundary; they do not become `loadError`
or `saveError`. Repeating unchanged text does not replace accepted input.
With no opening fence, the entire source is body with empty fields
([ADR-0665](../../docs/adr/0665-a-markdown-file-without-frontmatter-has-empty-fields-and-a-body.md));
adding a field creates a fence.

`save(input?)` accepts a complete source string or a structured patch. With
input, it applies that input synchronously, captures immutable interpreted
content, and admits publication before notifying observers. It returns
`Promise<Result<MarkdownContent<Schema>, ChangeError | SaveError>>`. Success
returns the captured publication's exact content, even if later typing or a
reentrant observer has changed the working document. It does not return a row
ID or reread the latest snapshot. Use `save(text)` for an atomic full-source
action and `save(patch)` for an atomic structured action. Without input,
`save()` publishes current content, even when clean, or retries held input.
An explicit save of clean content is held as unsaved until storage acknowledges
it; if the write fails, the content remains in `unsaved` for retry or discard.
It refuses with `ChangeError.NoContent` without text and `ChangeError.Closing`
after close.

When a control needs synchronous acceptance feedback, call `replace(text)` or
`patch(patch)`, check its Result, and then `void document.save()` to publish
the then-current source. This permits an action such as clearing a form after
acceptance. Use `save(input)` when the action needs the exact version captured
with that input.

`isDirty` is accepted input that no publication or delete has acknowledged
yet; it is never inferred from comparing with storage. Only accepted input
saves automatically, `saveAfterMs` after the last change. Reads, listings,
and reported outside changes never write. `isSaving` is true while text
publications of the path are admitted and not settled; deletes do not count.

A save-only indicator observes `folder.getStatus()` through `onStatusChange`,
or the Svelte context's reactive `getStatus()`, without subscribing to a document.
`savingPaths` lists paths with queued or running writes or deletes; `saving`
is whether that list is nonempty. `unsaved` lists accepted input awaiting
acknowledgement, and `failures` lists held input whose save failed and is not
being retried. Filter each by path for a per-file label. These reads start no
file I/O. A document subscription, including tracking any Svelte adapter getter,
demands content and is appropriate for an editing view.

Status is a read-only projection of the existing command lanes and held input.
`savingPaths` is derived from those lanes, not maintained as a second registry.
No caller registers a path for a save indicator or keeps its list in sync.
The document owner builds one cached `FolderStatus` and notifies its status
readers;
the handle exposes that same snapshot. There is no intermediate aggregate or
second status cache. Unchanged save metadata retains snapshot identity, even
when the text changes. The Svelte context adds subscription tracking to the
same read without mirroring the snapshot.

A publication acknowledges only the input it captured, by identity: typing
during a save stays dirty after it lands, even when the newer text equals the
older. A read waits for the path's admitted writes and reads again when a
write or a reported change overtakes it, so an acknowledgement never lands
over a newer observation. `saveError` is the last applicable failed
publication; it survives typing and retries until a publication succeeds or
`discard()`. Discard drops unpublished input and its pending automatic save,
forgets the failure, writes nothing, and cancels no admitted publication;
a publication admitted before it cannot bring its failure back.

`folder.files.delete(path)` and `tables.<name>.delete(id)` capture the
document's current input and defer its pending automatic save, never blocking
new input. Success acknowledges only that captured input, which stays held as
the content; newer input saves afterwards and recreates the path. Failure
leaves pending input pending and resumes its automatic save while open. After
close, that input stays readable without another save attempt. Input
an earlier publication already acknowledged never becomes dirty again.

`folder.flush()` submits held input no admitted command owns, failed input
included, without waiting. Editing stays open. `getStatus().failures` exposes
immutable in-session `SaveFailure` values, `{ path, error }`. Copyable text
lives in the document snapshot.

`folder.close()` synchronously refuses new work, stops autosave, publishes
`closing: true` once, and releases listeners and storage. It neither submits
held input nor waits for admitted commands. Those commands may finish or fail
and keep their own Results. Documents stay readable; subscribing after close
reports the current snapshot once without reading or registering a listener.
Document `save()` refuses with `ChangeError.Closing`.

Await the actual write or save you started when durable bytes are required.
Confirmed departure accepts losing unfinished work. Application workflows
waiting on reads, network requests, or other tasks do not keep storage open;
apps refuse new work and late results through their own closing state.

Documents learn of outside changes through folder-wide storage hints: browser
broadcasts, native directory watching, and sync. Hints identify affected paths
or any path, never publication receipts. The owner reads subscribed sources;
inactive acquired sources reread when subscribed again. Directory hints include
descendants. Receiving a hint never causes a write.

`folder.refresh(paths?)` reconciles current document readers and marks inactive
sources stale. Omitted paths mean all, `[]` means none. Manual refresh and window
visibility reconciliation complement best-effort notifications without polling.
Table and raw file reads leave working documents untouched. Document
subscriptions acquire their own source; save-status readers acquire no content.

Svelte's `liveSnapshot(document)` from `@epicenter/svelte/snapshot` exposes
the snapshot through its tracked `.current` getter. React's `useDocument(document)` from
`@epicenter/react/document` reads the cached snapshot through
`useSyncExternalStore`. Each view observes the Folder-owned document; commands
stay on the handle.

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

A directory folder's files are the saved data: every storage read goes to disk,
and each save publishes one whole file (`native/engine.ts`). Opening reads a
file a person left there as it is and changes nothing. Git is optional: a
directory with no `.git`, or with a `.git` file or link, opens and saves the
same, and saving creates no repository. Editor and direct saves replace the
path unconditionally; an outside writer's changes may be overwritten.

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
Opening starts one recursive `fs.watch` for the handle. It reports outside
changes through `onChange` as `other-handle` path hints; unknown scope is `null`.
The folder owner rereads subscribed paths and marks inactive sources stale.
Notifications carry no bytes and never acknowledge accepted input as saved.
Closing releases the watch.

### Desktop app

The shell bound one existing directory to this window before the window
existed (`tauri-plugin-epicenter-folder`). Opening asks the shell to open it
(`open_folder`, with no arguments); the page then reads and saves only
through the shell's storage commands, one per storage method (`tauri-files.ts`,
[ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)),
each answered in the calling window's directory. No command names a root,
scope, or window.
The shell checks every path and stages and renames each save under the same
save lock used by Bun. Ordinary saves compare no previous content. A command whose reply was lost counts
as landed only when the path holds what was sent. The window binding starts one
recursive native watch when first opened and retains it until destruction or
shutdown. Each handle installs its scoped typed event listener before returning,
then releases its listener on close. Outside changes reach `onChange` as
`other-handle` path hints; they never acknowledge accepted input. Reading the
handle directly always reads disk.

Filesystem observation is best effort. Watch setup failure refuses opening;
unknown paths, native rescan/overflow, and watcher errors request a `null`
reconciliation. Root replacement recovery is unsupported and platform dependent:
neither continued observation of the original inode nor attachment to a
replacement directory is guaranteed. A terminal watcher error requests
reconciliation without an autonomous restart guarantee.
Neither native backend keeps a polling fallback, durable notification delivery,
or file-content replica. General list queries retain their refresh policy while
their event-based coverage is completed.

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
fields and the full body. Malformed frontmatter retains source and diagnostics;
its fields are unavailable, and its body is available only after a closing
fence establishes the boundary.
This reader leaves the stricter app table contract unchanged.

Schema imports and generation patch selected declaration sections with
conditional writes. A stale write rereads and reapplies its change; JSON line
merge cannot safely preserve two section changes sharing a line. Duplicate keys
and numeric values that cannot survive serialization stop a replacement, with
the original source available for repair. Direct file writes and Git sync
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

`changeSavedView(text, { key, value })` from `@epicenter/folder/declaration`
is a pure transform over current declaration text. `value: undefined` deletes
an entry. It preserves unrelated JSON, tables, metadata, and unsupported sibling
views. Assignments replace the current target without a source precondition.
Malformed containers, duplicate keys, and numeric values that cannot round-trip
are refused with the source still available for repair.

A caller reads its current `folder.files.document('epicenter.json')` content,
applies the transform, and calls `save(transformedSource)`. The
document owns the composed input, failures, and publication order alongside raw Files edits. There is no separate saved-view
writer or native storage capability. A first explicit save can create a source
containing only `views` after the editor reports the path missing. Opening and
browsing write nothing.

The generic editor owns unsubmitted form values and SQL executions by view key.
Submission retires a form into the shared file owner before I/O settles. Grid
cells, board moves, and Files likewise share the folder's file edit handles;
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
`src/git/` stays for exchange: `runHistory` owns one complete request, with no
history handle, subscriptions, background scans, or close step. A save version
or a sync holds the history lock through its final reply inspection.
It requires no declaration and interprets no table schema. Tracked files remain
tracked; untracked files enter a commit unless Git ignores them. Ignore rules
come from captured repository `.gitignore` files. Native Git also honors
its machine-specific excludes. The browser engine's own Git exchange is in
`src/browser/` ([its README](src/browser/README.md)).

Each request answers its own operation receipt and optional final observations.
A later inspection failure leaves a successful commit or publication successful;
`state.files` or `state.sync` is absent when it could not be established.
The final inspection lists the folder again and reads every tracked or included
file, rather than inferring that a checkpoint left it clean. Each capture reads
its `.gitignore` files first and reuses those bytes for selection and recording;
captures skip untracked ignored payloads, such as audio. Tracked files are read
even when an ignore rule matches them. A log request does not scan files.

`synced` acknowledges the captured version reaching the remote. Files can
change afterwards. `saved.changedSince` records a local change this request
observed after its latest successfully recorded capture, including a stale
conditional removal. It remains true even if a later inspection is clean or
fails. False means no such event was observed, not that the files are clean.
A subsequent successful checkpoint absorbs that information. Landed paths stay
in the reply across checkpoints and partial failures.

Acknowledged publication survives a later failure to clear its repair marker,
reconcile the index, or update remote tracking. These failures are diagnostics;
a checkpoint still reports its `indexWarning`. Unconfirmed remote tracking
makes `state.sync` absent in that reply. Later status requests read the tracking
ref as last recorded; a later fetch repairs it.

A missing `.gitignore` is valid. To keep new recordings local, save
`/audio/` in the root `.gitignore` before the audio is committed.
Adding that rule does not untrack earlier commits, censor incoming tracked
files, or cancel an exact pending send. Deleting the rule makes previously
ignored untracked files eligible. There is no declaration-level `local`
policy or binary-file admission policy. Finder files such as `.DS_Store` use
the same rules; add a `.gitignore` line to exclude them.

An app can maintain required exclusions through ordinary read-modify-write.
Read the current file, retain unrelated rules, compute the desired contents,
and write them with `files.write`. Skip unchanged contents. The write is
unconditional, so a change another writer landed between the read and the
write is replaced. Rule order and exceptions matter; checking for a literal
line is insufficient. An app that maintains a rule can restore it after
someone removes it. Later writers and sync can still change the file, and
already-tracked paths stay tracked.

```ts
const saved = await folder.files.write('.gitignore', '/audio/\n');
if (saved.error !== null) return show(saved.error.message);
```

This saves an ordinary local file, without creating a Git commit. A later
commit or sync records it normally. The folder
opener, Git initialization, and clone do not add or restore rules. App-maintained
startup updates use the same files API. There is no generic template API,
app-version ledger, or first-use flag.

Sync merges by the same rules on every host. Its merge commit's tree uses
`src/git/tree-merge.ts` over the merge base, the
remote's tree as current, and this device's as the change, with each file
both sides changed merged by the shared content rules (`shared/merge.ts`).
These merge rules belong to sync and history; public local writes publish
unconditionally.
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
| `src/handle.ts` | The caller-facing handle every engine shares: status, the close fence, per-path command ordering and synchronous release, and the read notes. |
| `src/local-folder.ts`, `src/browser/` | The browser's default local folder over the IndexedDB repository engine. |
| `src/native/` | The directory engine (`engine.ts`), its Bun host and save lock (`bun.ts`, `directory.ts`), and its desktop host (`tauri.ts`, with `bindings.gen.ts` generated from the folder plugin; do not edit). |
| `src/shared/` | The content merge and row reading every engine uses, Markdown documents at any path (`document.ts`). |
| `src/boundary.ts`, `directory-store.ts`, `directory-node.ts`, `directory-primitives.ts`, `tauri-files.ts` | Directory storage over `node:fs` and over the shell's commands. |
| `src/check-folder.ts`, `query-folder.ts`, `read-folder.ts`, `projection.ts`, `declaration.ts`, `definition.ts`, `row-text.ts`, `generate-declaration.ts` | The CLI's readers of `epicenter.json`; `row-text.ts` uses the shared row codec. |
| `src/git/`, `history-wire.ts`, `write.ts` | Shared Git object and tree rules, the directory history engine `runHistory` runs, and the one write its Sync publishes through. |
| `src/file-browser.ts` | File-browser helpers. |
| `src/document-owner.ts`, `document.ts` | The owner of typed row, text and field input over one handle for its whole life, and the vocabulary entry. |
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
first. Directory change hints are best effort. File bytes cross the
desktop bridge whole. Older OPFS folders are not read by the current opener.
