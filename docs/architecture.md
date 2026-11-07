# Epicenter architecture

How Epicenter works in code today. [The vision](vision.md) says what Epicenter
is and which rules it keeps;
[ADR-0835](adr/0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md)
lists every decision in force and whether it is built; [the vocabulary](CONTEXT.md)
owns the words. This page maps the code: which package holds each piece, which
files a flow passes through, and where the code differs from what is decided.

A folder is plain files in `~/Epicenter`. The server keeps a ledger of
changes for each folder. One thing moves: a change, a set of files each naming
the version it replaces. The sections below follow it.

## The primitives

| Primitive | Package | Main entry points |
| --- | --- | --- |
| The store: bytes at paths | `@epicenter/folder` | `Store` in `src/device/store.ts`: `list(under)`, `read(paths)`, `put(path, bytes \| null, expect)`, `watch(changed)`. `put` lands only while the path holds `expect` and otherwise answers `Moved { now }`. Memory (`device/memory-store.ts`), a Bun directory (`node-store.ts`), the desktop shell (`tauri-store.ts`), a served directory (`served/`), and the folder on the server (`remote/repository.ts`) answer it, held to one suite (`device/store.conformance.ts`). A version is the SHA-256 of a file's bytes (`versionOf` in `src/hash.ts`). |
| The ledger: a folder's log on the server | `@epicenter/server` | `appendChange` in `src/log/append.ts` (one call of the SQL function `epicenter_append_change`, migration `0011`); `changesSince`, `filesAt`, `readLog`, `folderHeads` in `src/log/read.ts`; `listMarks`, `setMark` in `src/log/marks.ts`; bytes over 16 KiB in a `BlobStore` (`src/log/blob-store.ts`, R2 or disk). The client side is `folderRepository(account, folder)` in `@epicenter/folder/sync`: `changes(since)`, `files()`, `filesAt({ at })`, `append(writes)`, `log()`, `marks()`, `mark()`, `appendVersions()`. |
| The merge | `@epicenter/definition` | `merge3` and `mergeLines` in `src/front-matter/` (sync merges with these: a field by key, a body by Git's line merge); `settle` in `src/merge/` (what a folder's own write runs over a note that changed under it). The server never merges. |
| The record of what a computer synced | `@epicenter/folder` | `recordsIn(store)` and `FolderRecord` in `src/platform/records.ts`: `~/Epicenter/.epicenter/synced/<folder-id>.json`, `{ folder, name, inode, birthtime, cursor, files }`. `identify` in `src/platform/identify.ts` decides which directory a record proves. A sync reads and saves it as its `Manifest` (`storeManifest` in `src/sync/sync.ts`). |
| The operation table | `@epicenter/cli` | `OPERATIONS` in `src/operations.ts`: one `defineOperation` description per operation (name, positionals, options, TypeBox input and output). `src/cli.ts` renders each as a command and `src/mcp.ts` as an MCP tool. The code behind each is a function in `@epicenter/folder/platform`. |

Around them:

- **The contract and the note.** `@epicenter/definition/contract`
  (`defineContract`, `checkContract`, `proposeContract`) reads a folder's
  `epicenter.json`; `front-matter` parses and patches `key: <JSON>` lines;
  `note` writes the house style. The folder's own writes still format a note
  as block YAML in the contract's key order (`note/canonical.ts`).
- **The sync function.** `sync({ local, remote, manifest })` in
  `@epicenter/folder/sync` copies what changed on one side to the other and
  merges a note both sides changed. `local` is any `Store`; `remote` is a
  `Repository` (`folderRepository`, or `memoryRepository` in a test).
- **The platform.** `@epicenter/folder/platform` holds every operation on
  folders as a function: `listHome`, `initFolder`, `syncFolder`, `syncEvery`,
  `keepEverySynced`, `cloneIntoHome`, `acceptIntoHome`, the history functions
  (`folderLog`, `fileHistory`, `fileAt`, `folderAt`, `folderDiff`,
  `restoreFolder`, `markFolder`, `folderMarks`), `importGit`, and the server's
  folders (`listFolders`, `shareFolder`, `unshareFolder`, `acceptShare`,
  `attachFolder`, `folderHeads`). The CLI and the Epicenter app both compose
  it; neither calls the other.
- **Git at the edge.** `exportGit` (`src/git/export.ts`, `git fast-import`)
  and `importGit` (`src/git/import.ts`, over a `GitHost`). No computer or
  server stores history as Git.
- **The server's routes.** `mountFolders` (`src/routes/folders.ts`,
  `folder.ts`) serves each folder's ledger at `<api origin>/folders/<id>`;
  `mountFolderApi` (`src/routes/folders-api.ts`) serves `/api/folders` for
  listing, sharing, accepting, and attaching. `apps/api` composes them as the
  hosted Worker and, on Bun with Postgres, for self-hosting.

## Flows

### A save on a computer

1. A desktop app writes through its open folder: `folder.todos.set(...)` in
   `packages/folder/src/folder.ts` reads the file, then calls the store's
   `put(path, bytes, expect)`. If the file moved, the folder reads and applies
   the change again, merging a body with `settle`.
2. In a Tauri window the store is the shell's
   (`packages/tauri-plugin-epicenter-folder`): it stages the bytes beside the
   target as `.ep-<random>.save`, checks the version again, and renames. The
   folder holds only its content; nothing of Epicenter's goes in it.
3. The desktop app does not sync. Epicenter's programs do (step 1 of the next
   flow), and the app reads a mark from the record Epicenter keeps
   (`syncedRecord()` in `@epicenter/folder/tauri`).

### The Epicenter app syncing a folder

1. `apps/epicenter/src/folders/home.svelte.ts` starts `keepEverySynced` once
   someone is signed in, over `epicenterRoot()` from
   `@epicenter/folder/tauri` (every real directory in `~/Epicenter`).
2. `keepEverySynced` (`src/platform/keep-synced.ts`) runs `syncEvery` when it
   starts, after a burst of changes in a folder, on a timer, and when the
   person presses Sync now. It hears changes through each store's `watch`.
3. `syncEvery` (`src/platform/sync-folder.ts`) asks `folderHeads` once:
   `GET <folders>` answers the cursor of every folder the token reaches. In
   parallel, `identify` proves which directory is which folder, by inode and
   birth time (or, when no directory matches a record, by its name and exact
   files in a folder the person holds alone).
4. For each proven folder whose head moved past its record, or whose files
   changed here, `syncFolder` runs `sync({ local, remote, manifest })` with
   `folderRepository(account, id)` and `records.manifest(id)`. An unbound
   directory syncs only when an app made it; otherwise it waits and asks
   which folder it is (`questionOf`).
5. `sync` (`src/sync/sync.ts`) lists the local store, asks `changes(since)`
   for what moved, and for each candidate path compares the two versions with
   the agreed one. It writes the local side first, each file over the version
   listed, then `append`s to the server in one change over the versions it
   read. A moved batch lands nothing; the sync lists again and runs another
   pass. A note both sides changed merges with `merge3`, this computer's side
   winning a field both changed, and an edit beats a delete. Before writing
   anything it stops when it would delete 20 or more files on the server, or 5
   or more that are half the folder (`outcome: 'deletions'`).
6. The server (`postChange` in `src/routes/folder.ts`, then `appendChange`)
   lands each path only where it still holds the expected version, numbers
   the change, and answers the new cursor, or `409 moved` naming the paths.
7. The record is saved over the version read, with the new cursor. The mark
   (`✓ ◌ ⚠ ✗`) comes from the report.

`epicenter sync` (`packages/cli/src/sync/commands.ts`) runs steps 3 to 7 for
one folder or, with `--all`, `syncEvery`.

### A web app's save

1. `openFolder(todos, home({ site, account }))` in a browser opens the folder
   attached to the app on the server: `joinApp` joins it, or `makeFolder`
   makes one (`src/home.ts`, `src/remote/repository.ts`). The store is
   `folderRepository`; nothing is kept in the browser.
2. `folder.set(...)` calls `put(path, bytes, expect)`. The repository holds
   puts made within 50 ms of each other (300 ms at most) and lands them as one
   change: it uploads any bytes over 16 KiB with `PUT blobs/<sha256>` after
   `POST blobs/missing`, then `POST <folders>/<id>/changes`.
3. The server appends it as above. A stale write answers `409 moved`, which
   the store returns as `Moved { now }`; the folder reads what is there and
   applies its write again.
4. Others' changes arrive through the store's `watch`, which asks
   `changes?since=` on a timer.

### Sharing and accepting

1. `epicenter share <folder> <email>` (or the Epicenter app) calls
   `shareFolder` in `src/remote/folders.ts`: `PUT /api/folders/<id>/members/<email>`
   with a role, `member` or `reader`. The server (`shareFolder` in
   `packages/server/src/folders.ts`) writes a `folder_invitation` row naming
   the email, and answers the same whether or not anyone holds an account
   with it.
2. The invitee's `listFolders` returns it in `pending` once their verified
   email matches. Nothing is granted yet.
3. `acceptIntoHome` (`src/platform/sync-folder.ts`) calls `acceptShare`
   (`POST /api/folders/<id>/accept`), which makes a `folder_member` row, then
   `cloneIntoHome`: a new directory in `~/Epicenter` named for the title, a
   record written from first contact, and a sync that never deletes.
4. A token reaches a folder by `folders:all` (the CLI and the Epicenter app) or
   by the folder's attachment to its app (`folder_app`). Roles are checked on
   every request (`src/folder-roles.ts`, `src/auth/resource-access.ts`).

### A file's history and restore

1. `epicenter log`, `history`, `show`, `at`, `diff`, `mark`, and `restore`
   call the functions in `src/platform/history.ts`, which call
   `folderRepository`: `log` (`GET …/log`), `filesAt` (`POST …/files`),
   `marks` and `mark` (`GET …/marks`, `PUT …/marks/<name>`). The Epicenter
   app's History view (`apps/epicenter/src/folders/History.svelte`) calls the
   same functions.
2. A moment is a change's number, a mark's name, or a time. The server reads
   the files as of that point from `change_file`.
3. `restoreFolder` compares the folder at the moment with the folder now and
   appends one change that names the older versions (`appendVersions`), and
   removes files made since. It names versions the server holds, so no bytes
   travel. Computers receive it as any change: the next sync writes the older
   versions and deletes the removed files on the device (see below).

### `export --git` and `import --git`

- **Out.** `epicenter export <dir> --git <repository>` (`packages/cli/src/git/commands.ts`)
  calls `exportGit`, which reads `log`, `blobs`, and `marks` and writes a Git
  repository with `git fast-import`: one commit per change, notes and
  `epicenter.json` as blobs, other files as Git LFS objects named by their
  versions, marks as tags. It is deterministic and incremental.
- **In.** `epicenter import --git <path or URL>` (and "Import from Git…" in the
  Epicenter app, over the shell's Git in `apps/epicenter/src-tauri/src/git.rs`)
  calls `importGit` with a `GitHost`. It mirrors the repository into a scratch
  directory, makes a folder on the server with `import: true`, posts each
  first-parent commit as a change with its author, time, and message
  (`POST …/import`), writes the files to a new directory in `~/Epicenter`,
  records it as synced, and closes the import. `--resume` and `--abandon`
  recover a half-done import (`~/Epicenter/.epicenter/imports/<folder-id>.json`).

### `epicenter mcp`

1. `epicenter mcp [<dir> ...] [--all]` (`packages/cli/src/mcp.ts`) serves the
   MCP protocol on stdin and stdout.
2. Its tools are every entry of `OPERATIONS`, with the same input and output
   schemas and the same code, and, for each folder it reaches, tools derived
   from the collections of its `epicenter.json`:
   `<folder>_<collection>_query`, `_get`, `_set`, `_write`.
3. A collection tool writes through `openFolder`, as an app does, so a field
   that does not fit the contract is refused before anything is written.
4. It runs `keepEverySynced` over only the folders it writes, after a burst of
   writes and every few seconds. Signed out, it writes and says on stderr that
   it does not sync.

## Not built, and where the code differs

[ADR-0835](adr/0835-records-from-0802-to-0834-agree-on-files-a-ledger-and-git-at-the-edges.md)
holds the Built column; this table says what the code does where it differs.

| Decided | What the code does |
| --- | --- |
| Epicenter sends a change at once and checks every 30 seconds, with no notifier and no live session ([ADR-0830](adr/0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md)) | `keepEverySynced` runs a round 3 seconds after the last change in a burst (`AFTER_CHANGE_MS`) and every 3 seconds (`CHECK_EVERY_MS`); a web store polls every 3 seconds (`POLL_MS`); web puts batch within 50 ms, not when typing pauses. There is no notifier and no live session. |
| A folder is the directory Epicenter last synced, else Epicenter asks; no proof by name and files ([ADR-0832](adr/0832-a-folder-is-the-directory-epicenter-last-synced-or-epicenter-asks.md)) | `identify` still proves a directory by its recorded name and exact files in a folder the person holds alone, and `questionOf` matches unbound directories by name or title and joins silently when one match is held alone. |
| A restore never deletes on a device; bytes leave through an outbox; the chain covers what changed, not who ([ADR-0829](adr/0829-a-restore-never-deletes-on-a-device-and-historys-chain-covers-what-changed-not-who.md)) | The next sync after a restore deletes on the device the files the restore removed. No outbox and no epoch rotation on restore; `purgeBlobs` deletes kept bytes. Each change's `digest` includes its account, author, and client. |
| Text inline up to 2 KiB; each folder's older changes in its own archive ([ADR-0833](adr/0833-a-folders-present-lives-in-one-shared-database-and-its-past-in-its-own-archive.md)) | Bytes up to 16 KiB (`INLINE_MAX`) are inline in Postgres, larger ones in the blob store. There is no archive. |
| A body merges by Git's line merge, both versions shown; no merge by word ([ADR-0830](adr/0830-epicenter-sends-a-change-the-moment-it-happens-and-checks-for-others-every-thirty-seconds.md)) | Sync's `merge3` merges by line. `settle`, which a folder's own write and an agent's tool run over a note that changed under them, still merges a line both sides changed by word first (`merge/merge.ts`). |
| A note's front matter is one `key: <JSON>` per line ([ADR-0796](adr/0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md)) | The grammar's reader and patcher exist and sync merges with them; a folder's own write formats a note as block YAML (`note/canonical.ts`). |
| `epicenter git land` turns a branch into one change ([ADR-0831](adr/0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md)) | There is no `git land` command. |
| Every folder is a Git remote ([ADR-0834](adr/0834-every-folder-is-also-a-git-remote.md)) | No Git endpoint. History leaves with `export --git` and enters with `import --git`. |
| An app is a view, a window over one folder, and capabilities ([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)) | An app compiles a contract with `defineContract` and opens a place with `openFolder(contract, home({ site, account }))`. `defineView`, `openFolder(view)`, and `@epicenter/app` do not exist. The fit check is unbuilt. |
| Items named `{name}` ([ADR-0818](adr/0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md)) | The code says note and `{id}`. |
| The Epicenter app shows every folder, its history, sharing, and import | Its Folders window is built (`apps/epicenter/src/folders/`) and its pages have not been seen running. "Connect your agents", views across folders, and purge are not built. |
| `epicenter query`, `set`, `delete`, `normalize` ([ADR-0827](adr/0827-the-cli-and-mcp-render-one-table-of-operations.md)) | Not built; an agent has typed collection tools through `epicenter mcp`. |

Older records and comments call one sync a round; `keepEverySynced` still does,
and no other code does.

## Running it

Run apps from the repository root with `bun dev:<app>`: `bun dev:todos:ui` for
a browser demo, `bun dev:epicenter` for the native app, `bun dev:api` for the
hosted API alone. The package READMEs describe their contracts:
[folder](../packages/folder/README.md),
[definition](../packages/definition/README.md),
[server](../packages/server/README.md),
[cli](../packages/cli/README.md), [apps](../apps/README.md),
[the Epicenter app](../apps/epicenter/README.md), and
[the API](../apps/api/README.md).
