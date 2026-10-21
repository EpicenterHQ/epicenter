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
const folder = await openFolder({ tables: { todos: todoSchema } });
```

In a browser, this opens the origin's stable default in IndexedDB. In a
Tauri page, it opens the directory that the shell assigned to that window
before creating its WebView. A Bun process passes an existing path with
`openFolder({ directory, tables })`; a Tauri page may pass the ID of another
folder the shell has registered and permitted. Opening needs no account,
network connection, Git repository, or `epicenter.json`, and it writes no
authored file. A storage refusal is returned to the caller; another store is
never opened in its place.

The browser's older OPFS folders remain on disk but the current default
opener does not read them. The desktop shell leaves older authored
directories intact and lists them as folders. Neither boundary silently
migrates or removes data.

## Editing and saving

`folder.files` reads and changes paths; `folder.tables` reads and changes
rows at `<table>/<id>.md`. Direct `files.write` and `tables.<name>.set` calls
supply the file or row they started from. The engine merges their complete
submitted change with current storage, by frontmatter field or text region,
using the same content rules in browser, Tauri, and Bun.

An edit handle instead owns one whole-source draft per path. `change()` applies
fields and body to the displayed source in call order; `replaceText()` replaces
it. Rereads do not fold outside changes into a dirty draft. `FileEdit.save()`
succeeds if storage still matches the observed source or already equals the
draft; otherwise it reports a whole-file `Conflict` and retains the draft.
`resolveConflict()` explicitly accepts saved content or submits a guarded
replacement. Unknown fields, comments, and repairable source remain visible;
no field-level merge runs implicitly on a draft save.

The browser commits a save in IndexedDB. The desktop shell and Bun stage
bytes beside the directory, compare the expected file under a shared save
lock, and replace one file. The native shell also checks every path and
refuses links that could leave the granted root. A failed save leaves the
previous file in place; the app retains its draft and shows the failure.
`onChange` tells another view which paths to reread. `getStatus()` reports saves
in progress and storage failures. Closing a handle finishes saves already
started and releases its listeners and storage.

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

The Folders window lists direct child directories of the Epicenter folder
root. Opening a bundled app normally assigns its named default there, such
as `~/Epicenter/Todos`. Choosing **Open with** assigns an existing listed
directory to that app's new window. The shell records the assignment and
grants that window the folder plugin's scoped file commands before the
window loads. A selected directory that disappeared is refused; the shell
does not recreate it as an empty default. The Folders window can open the
same files as a text editor.

Standalone Todos uses its whole platform application-data directory as
its folder. Its shell computes and assigns that location at launch, so the
page still calls `openFolder({ tables })`. Its rows land directly under
`todos/` there. The path choice belongs to the launch context, not to an
app ID or a path supplied by the WebView.

Each window owns its Folder handle, query cache, drafts, and close
coordination. The shell owns directory permission and guarded publication.
Whispering's recorder is a separate shell service that writes into the
directory granted to its window. Settings and connection credentials are
separate from the folder's local opening path.

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
