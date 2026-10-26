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

The Folder mirrors the file values that storage last returned or accepted.
`folder.files()` reads its current listing; `folder.tables` interprets rows at
`<table>/<id>.md`. A row with issues keeps its path and diagnostics for repair.
Browser and native change hints, focus, and explicit `refresh()` reconcile
outside edits without periodic polling.

Each `write`, `update`, `create`, or `delete` enters one serial queue. An
`update` composes over the Markdown file as it stands when that operation
runs. Each write makes one unconditional put, then updates the mirror. Its
promise answers after the new value is visible, or with a `WriteError`. There
is no merge on a local write; the last publication to land wins. The browser
commits the change atomically in IndexedDB. Native storage stages and renames
one whole file under the shared save lock.

A Svelte editor owns a `draft(source, save)` for typed text. It shows that
text until its save answers, and keeps it with an inline error after a failed
save. Mounted drafts flush on teardown and page departure. `folder.saving()`
reports queued and active writes. `folder.close()` refuses new writes, drains
the queue, then releases storage. A desktop window close waits for that drain;
a browser unload asks only while saving. In-memory drafts do not survive a
crash.

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

Each window owns one Folder mirror and the drafts of its mounted editors.
The shell owns directory permission and atomic file publication. Whispering's
recorder is a separate shell service that writes into the directory granted
to its window. Settings and connection credentials are separate from the
folder's local opening path.

`<OpenFolder>` closes on unmount and closes an asynchronous open that finishes
after unmount. Native window Close flushes drafts and waits for queued writes
before destruction. A failed destroy leaves the page available for another
close attempt. Application Quit remains a shell operation.

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
