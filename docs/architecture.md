# Epicenter architecture

Epicenter apps edit ordinary files through their file contract: a published
layout of notes and files that `openDevice` and `openRemote` from
`@epicenter/folder` turn into a typed client
([ADR-0700](adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
A contract's schemas interpret source content; a note that does not fit
reads as invalid, with its text kept for repair.

This page maps the current implementation. Read the
[folder package](../packages/folder/README.md) for its contract, the
[application guide](../apps/README.md) for composition, and
[ADRs](adr/README.md) for the decisions behind them.

## Opening an app's files

```ts
const device = await openDevice(todosContract);
if (device.error !== null) throw device.error;
```

A browser page keeps its files in the origin's private file system
(`@epicenter/folder/browser`); a Bun process names a directory
(`@epicenter/folder/node`); a desktop window opens a root the shell lets it
reach (`@epicenter/folder/tauri`); an online page opens the signed-in
person's repository (`openRemote`). Opening needs no Git repository or
`epicenter.json`, and it writes no authored file. A refusal is returned to
the caller; another store is never opened in its place.

## Editing and saving

Each write is conditional on the version its writer read. Another writer's
change since is a `Conflict`: a change to a different field is carried over,
and a same-field `Conflict` keeps the typed text for retry (overwrite) or
discard (take theirs). Native storage stages one whole file and renames it
over its path after checking that version.

A Svelte page reads a client through `fromClient` and binds a text input to
`fieldEdit`, which shows typed text until its save answers and keeps it with
an inline error after a failed save. The page's leave guard holds a browser
unload, or a desktop window's close, while a write is out. In-memory edits do
not survive a crash.

Git exchange is separate from opening and local saving. The `epicenter`
CLI retains history commands, while current product pages offer no Save
version, Connect, or Sync action. The CLI's `epicenter.json` remains an
optional authored schema and local-exclusion policy for its own tools;
application opening does not publish one. The web never syncs. Account
access and inference have their own lifetimes.

## Desktop launch and directory assignment

Epicenter ships Settings and the Folders window in one Tauri bundle and serves
them from one `epicenter-app://localhost` origin. It manages folders and opens
no app: apps are separate programs (ADR-0701). It does not install or run app
source from a repository.

The Folders window lists the folders the `epicenter` CLI syncs, and each of
its actions is one CLI call. Epicenter opens no folder's files and binds no
window to a directory. Epicenter's own records are always
`~/Epicenter/so.epicenter`.

Each standalone app (Capture, Honeycrisp, Todos, Vocab, Whispering) is its
own Tauri program on the shared `epicenter-standalone` crate: its window
starts on its AppData root and opens its data folder,
`~/Epicenter/<productName>` (for Todos, `~/Epicenter/Todos`) unless the
person chose another, which Tauri's file-system scope must allow
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)).

Each window owns its clients and the edits of its mounted editors. The
shell owns directory permission and atomic file publication. Native window
Close waits for writes in flight before destruction. A failed destroy leaves
the page available for another close attempt. Application Quit remains a
shell operation.

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
