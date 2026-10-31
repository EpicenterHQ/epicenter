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
runs. Updates use conditional puts and retry when storage changed; whole-file
writes replace the file. A landed write then updates the mirror. Its
promise answers after the new value is visible, or with a `WriteError`. There
is no merge on a local write; the last publication to land wins. The browser
commits the change atomically in IndexedDB. Native storage stages one whole
file and renames it over its path after checking the version the writer read.

A Svelte editor owns an `edit(source, save)` for typed text. It shows that
text until its save answers, and keeps it with an inline error after a failed
save. Each typed value enters the queue immediately; teardown sends nothing
more. `folder.saving()`
reports queued and active writes. `folder.close()` refuses new writes, drains
the queue, then releases storage. A desktop window close waits for that drain;
a browser unload asks only while saving. In-memory edits do not survive a
crash.

Git exchange is separate from opening and local saving. The `epicenter`
CLI retains history commands, while current product pages offer no Save
version, Connect, or Sync action. The CLI's `epicenter.json` remains an
optional authored schema and local-exclusion policy for its own tools;
application opening does not publish one. Browser Git exchange lives inside
the browser engine, outside the public `Folder` handle. Account access and
inference have their own lifetimes.

## Desktop launch and directory assignment

Epicenter ships Settings and the Folders window in one Tauri bundle and serves
them from one `epicenter-app://localhost` origin. It manages folders and opens
no app: apps are separate programs (ADR-0701). It does not install or run app
source from a repository.

The Folders window lists the folders the `epicenter` CLI syncs. **Open files**
binds a listed directory to an editor window of its own and grants that window
the folder plugin's scoped file commands before the window loads. A listed
directory that disappeared is refused and never created. Epicenter's own
records are always `~/Epicenter/so.epicenter`.

Each standalone app (Capture, Honeycrisp, Todos, Vocab, Whispering) is its
own Tauri program on the shared `epicenter-standalone` crate: its window
starts on its AppData root and opens its data folder,
`~/Epicenter/<productName>` (for Todos, `~/Epicenter/Todos`) unless the
person chose another, which Tauri's file-system scope must allow
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).

Each window owns one Folder mirror and the edits of its mounted editors.
The shell owns directory permission and atomic file publication. Settings and connection credentials are separate from the
folder's local opening path.

`<OpenFolder>` closes on unmount and closes an asynchronous open that finishes
after unmount. Native window Close waits for queued writes
before destruction. A failed destroy leaves the page available for another
close attempt. Application Quit remains a shell operation.

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
