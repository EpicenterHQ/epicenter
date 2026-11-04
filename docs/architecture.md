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

A Svelte page reads the folder through `reactive`, the one adapter for
every capability, and the component that shows a note makes one editor of
it (`notes.edit({ id })`) and binds its fields. The editor shows typed text until its save answers and keeps it with
an inline error after a failed save. The page's leave guard asks before a
browser unload while a write is out; a desktop window closes at once.
In-memory edits do not survive a crash or a close.

Git exchange is separate from opening and local saving. The `epicenter`
CLI syncs a folder, and Epicenter's Folders window runs it (Sync now,
Connect, background sync); an app page offers only "Set up in Epicenter".
A folder holds no `epicenter.json`: `epicenter check` and `epicenter format`
take an app's contract by URL or file path. The web never syncs. Account
access and inference have their own lifetimes.

## Desktop launch and directory assignment

Epicenter ships Settings and the Folders window in one Tauri bundle and serves
them from one `epicenter-app://localhost` origin. It manages folders and opens
no app: apps are separate programs (ADR-0701). It does not install or run app
source from a repository.

The Folders window lists the folders the `epicenter` CLI syncs, and each of
its actions is one CLI call. Epicenter opens no folder's files and stores no
folder list: the CLI scans `~/Epicenter` and one level of owner folders, and
each folder's own Git configuration records its consent
(`epicenter.synced = true`).

Each standalone app (Capture, Honeycrisp, Todos, Vocab, Whispering) is its
own Tauri program on the shared `epicenter-standalone` crate
([ADR-0701](adr/0701-apps-run-as-separate-programs.md)): the shell names a
Data root and an AppData root. The page opens Data and, when it has machine
settings, AppData. The data path comes from its site's host under
`~/Epicenter` (for Todos, `~/Epicenter/todos`; for another owner,
`<owner>/<app>`). The first open
makes that folder when nothing is there
([ADR-0725](adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md),
[ADR-0726](adr/0726-an-apps-path-is-its-claim.md)).

Each window owns its clients and the edits of its mounted editors. The
shell owns which roots a page reaches and atomic file publication. A window closes
at once and Quit quits, without waiting for the page: a local write still in
flight then is a small, rare loss at the edge
([ADR-0702](adr/0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)).

## What to check next

The public surface and host-specific behavior are documented in
[`packages/folder/README.md`](../packages/folder/README.md) and
[`apps/epicenter/README.md`](../apps/epicenter/README.md). Run apps from the
repository root with `bun dev:<app>`. For a browser Todos demo, use
`bun dev:todos:ui`; for the native host, use `bun dev:epicenter`.
