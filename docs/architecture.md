# Epicenter architecture

Epicenter apps edit ordinary files through one public `@epicenter/folder`
handle. A folder is one rooted set of files; tables are views of Markdown
rows in those files. An app supplies the schemas it needs when it opens the
folder. The schemas interpret source content and do not authorize writes or
discard fields they do not recognize.

This page maps the current implementation. Read the
[folder package](../packages/folder/README.md) for its contract, the
[application guide](../apps/README.md) for composition, and
[ADRs](adr/README.md) for the decisions behind them.

## Opening a local folder

```ts
const { data: folder, error } = await openFolder({ tables: { todos: todoSchema } });
if (error !== null) throw error;
```

In a browser, this opens the origin's stable default in IndexedDB. In a
Tauri page, it opens the directory that the shell assigned to that window
before creating its WebView. A Bun process passes an existing path with
`openFolder({ directory, tables })`. To choose another native directory, the
shell assigns it to another window. Opening needs no account,
network connection, Git repository, or `epicenter.json`, and it writes no
authored file. A storage refusal is returned to the caller; another store is
never opened in its place.

The browser's older OPFS folders remain on disk but the current default
opener does not read them. The desktop shell leaves older authored
directories intact and lists them as folders. Neither boundary silently
migrates or removes data.

## Editing and saving

`folder.files` reads and changes paths; `folder.tables` interprets rows at
`<table>/<id>.md`. File and table `write` publish complete content. Table `set` immediately
patches the acquired working document, then awaits its captured publication.
Lists and gets do not populate editors; cold actions explicitly refresh first. All local publications and deletes
share one FIFO lane per path. Once admitted, an operation finishes in order.
Outside writers are uncoordinated: the last actual publication wins.

One folder-owned editor retains text per path. Raw replacement and schema-bound
changes edit that source. `getSnapshot()` is a pure cached read; `subscribe()`
emits it immediately and activates initial reading. The Svelte 5 adapter exposes
tracked `content`, `loadError`, `isDirty`, `isSaving`, and `saveError` getters.
Dirty input and an in-progress save are independent. A save captures the text at
its call; completion acknowledges only that intent. Newer input remains pending.
Discard and delete consume unsubmitted input, never cancel admitted saves, and
do not lock typing. Observations never cause writes. Acquired text remains
usable even when a refresh finds deletion or non-text content.

The browser commits atomically in IndexedDB. Native engines stage bytes beside
the target and replace one file, while preserving root containment and link
checks. Failed saves retain the input and its error for retry. Folder-wide
observations identify paths to reread. Native directory watching and browser
broadcasts supply these hints; manual/focus refresh reconciles missed events
without periodic polling. `getStatus()` reports aggregate work and immutable
failure metadata as `{ path, error }`; copyable text remains in the live editor
snapshot. Folder tracks submitted writes, not application workflows. Close synchronously releases listeners and storage without submitting held input
or waiting for writes. Page hide calls best-effort `flush()`. Confirmed departure
accepts losing unfinished work; callers needing durability await their write. Apps refuse new work and late results through their own closing state. In-memory retention does not survive a crash.

Git exchange is separate from opening and local saving. The `epicenter`
CLI retains history commands, while current product pages offer no Save
version, Connect, or Sync action. The CLI's `epicenter.json` remains an
optional authored schema and local-exclusion policy for its own tools;
application opening does not publish one. Browser Git exchange lives inside
the browser engine, outside the public `Folder` handle. Account access and
inference have their own lifetimes.

## Desktop launch and directory assignment

Epicenter ships Settings, Folders, Todos, Capture, Honeycrisp, and
Whispering in one Tauri bundle. The host has a closed table of bundled
pages and serves them from one `epicenter-app://localhost` origin. It does
not install or run app source from a repository. Old installer clones and
build caches remain on disk, unused.

The Folders window lists direct child directories of the Epicenter library
root (`~/Epicenter`) and bookmarked directories elsewhere. Opening a bundled
app normally opens its fixed reverse-DNS default there, such as
`~/Epicenter/so.epicenter.todos`, creating it when missing and reusing it
otherwise; nothing saves or selects that location (ADR-0672). Choosing
**Open with** assigns an existing listed directory to that app's new window.
The shell binds the directory and grants that window the folder plugin's
scoped file commands before the window loads. A listed or chosen directory
that disappeared is refused and never created. Epicenter's own records are
always `~/Epicenter/so.epicenter`. The Folders window can open the same files
as a text editor.

Standalone Todos opens the same `so.epicenter.todos` default through the same
shared table. Its shell computes and binds that location at launch, so the
page still calls `openFolder({ tables })`. Its rows land directly under
`todos/` there. The path choice belongs to the launch context, not to a path
supplied by the WebView.

Each window owns its Folder handle, query cache, retained input, and close
coordination. The shell owns directory permission and atomic file publication.
Whispering's recorder is a separate shell service that writes into the
directory granted to its window. Settings and connection credentials are
separate from the folder's local opening path.

After a native window successfully dispatches destruction, its page context is
closed immediately so app admission and late answers see `closing`. Cancel or a
failed destroy keeps the context live. FolderApp also closes synchronously on
unmount and closes any folder whose asynchronous open finishes after unmount.

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
