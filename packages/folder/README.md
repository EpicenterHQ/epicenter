# @epicenter/folder

`openFolder(contract, place)` hands an app its folder at once, already
connecting, with the contract's collections directly on it. The place says
where the folder is: the app's `home`, a `directory`, or memory under test
([ADR-0773](../../docs/adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md)).
The folder connects once to its place's store and then holds one replica of
every visible file in it, so a page reads it synchronously
([ADR-0778](../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)).
A write makes it so: the folder reads the file just before writing it,
writes over exactly what it read, and settles a change made since the way
sync does, so nothing another writer did is overwritten unseen
([ADR-0774](../../docs/adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)).
A write never fails while the folder lives: the folder keeps it, in order,
until it lands
([ADR-0775](../../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)),
and rejects it with `FolderClosed` when the folder fails or closes first
([ADR-0782](../../docs/adr/0782-a-waiting-write-the-folder-will-not-make-rejects.md)).
The folder has the shape every capability has: synchronous reads, actions
that answer promises, and one `subscribe`
([ADR-0777](../../docs/adr/0777-a-capability-has-no-ready-promise.md)).
A Svelte app reads it through `reactive` from
[`@epicenter/svelte/reactive`](../svelte/README.md); React reads it with
`useSyncExternalStore`.

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | `openFolder(contract, place)`, and `home({ site, account })`, the app's own place, which the package picks when it runs ([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)): in a Tauri window the app's data folder, whose code loads when it opens; in a browser the folder attached to the app the account signs in as (ADR-0811), which needs the account; and a new place in memory under the `test` condition. |
| `@epicenter/folder/core` | The folder's types (`Folder`, `FolderNotes`, `FolderFiles`, `FolderLifecycle`, `FolderState`, `NoteEdit`, `Unavailable`, `Place`, ...), `OpenFolderError`, and the `FolderNotOpen` and `FolderClosed` errors, the same on every build, for a library that takes a folder or a collection. |
| `@epicenter/folder/node` | `directory(path)`, a directory as a place, for scripts and tests (Bun or Node); `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`; and the Epicenter folder on this computer: `epicenterRoot(path)` (every directory directly inside `~/Epicenter`, links followed), `localFolder(path)` (a folder at a path, refused inside `.git` or `.epicenter`), and `rootIdentity(path)` (a directory's device and inode). |
| `@epicenter/folder/memory` | `memory()`, a new place in memory, and `memoryFiles(placeOrFolder)`, the world outside it, for a test. |
| `@epicenter/folder/served` | `served(url)`, the directory the program serving this page keeps on this computer, reached through that program (Messages; ADR-0784). |
| `@epicenter/folder/serve` | `serveDirectory(path)`, the program's half: it answers its page's store verbs over a directory, in Bun or Node. |
| `@epicenter/folder/sync` | `sync({ local, remote, manifest })`, ADR-0803's prototype: a store synced with a repository's history through a manifest at `.epicenter/synced.json`, `{ folder, root, commit, files }`: the folder's id, the directory it synced in (device and inode, so a copy is told apart), and each file's Git blob id (ADR-0808, ADR-0811), merging notes with `@epicenter/definition/front-matter`. `localStoreOf(folder)` is an open folder as the local store: it lists every visible file and reads from what the folder holds, so an unchanged sync of 10,000 notes reads no file. Two syncs of one folder may run at once: every write, the manifest's included, is over the version read. `syncAtMoments({ folder, remote })` syncs an open folder when it starts, after a burst of saves, when its window returns, every three seconds while shown when either side changed, and on request (ADR-0804). No app runs it yet. `joinFolder(account, { folder? })` is a first sync on the server: it joins the folder named when the person holds it, or makes one (ADR-0811). |
| `@epicenter/folder/platform` | Every platform operation on folders as a function (ADR-0817), which the CLI and the Epicenter app compose: `listHome` (each folder in the Epicenter folder with its title, state, and members, the shares waiting, and the folders held elsewhere), `initFolder` (an `epicenter.json` proposed from the files), `syncFolder` (a copied folder asks before it pushes, and a first sync joins before it creates), `cloneFolder`, `cloneIntoHome`, `acceptIntoHome`, `syncEvery` (every folder that moved, from one request for where every folder is; ADR-0819), and the person's folders on the server: `listFolders`, `getFolder`, `folderHeads`, `shareFolder`, `unshareFolder`, `acceptShare`, and `attachFolder`. |
| `@epicenter/folder/tauri` | `revealRoot(root)`, which shows a root the shell named in the file manager, and `syncWithEpicenter` and `syncedWithEpicenter` for Epicenter enrollment. What a capability keeps for this computer goes to AppData through `settings` from [`@epicenter/local`](../local/README.md), not through a folder. |

Importing an entry does not open anything. A place is opaque: only this
package makes one, and nothing outside it holds a store or the collections
under a folder.

## The folder

```ts
// src/lib/app.ts
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
```

`openFolder` returns synchronously
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)):

| Member | What it does |
| --- | --- |
| `folder.state()` | `opening` until the first snapshot lands, `open`, `failed` with the typed `OpenFolderError` and the `retry()` that opens again once the person has acted (answering once that attempt settles), or `closed` once disposed; the same object until it changes |
| `folder.unavailable()` | why the store cannot be reached or written now, else null: while opening the folder keeps trying, and while open what it shows may be old and writes wait; it clears on its own, and is null once failed or closed |
| `folder.saving()` | whether a write is out, from its call or an editor's keystroke until it lands; `<WhenOpen>` reads it for the leave guard and its status line |
| `folder.subscribe(fn)` | hears `state()`, `unavailable()`, `saving()` or `displayPath()` change; returns the unsubscribe |
| `folder.displayPath()` | the desktop data folder's path as the shell named it, to show a person, once it opened; null before, and at any other place |
| `folder.reveal` | shows the desktop's data folder in the file manager, even when it did not open; null at any other place |
| `folder[Symbol.dispose]()` | closes what it opened, even an open still under way; every write still waiting rejects with `FolderClosed`, and a later write throws |
| `folder.todos.items()`, `invalid()`, `get(args)` | answer what the replica holds, at once; before the snapshot landed they throw `FolderNotOpen` |
| `folder.todos.subscribe(fn)` | hears the collection's reads change |
| `folder.todos.set(args, changes)`, `delete(args)`, and a file collection's `set(args, bytes)` | answer once the write has landed; reject with `FolderClosed` when the folder fails or closes first |
| `folder.todos.edit(args)` | one note as an immediate editor (`NoteEdit`): its fields and body one by one, or its whole `text`, with its own reads and `subscribe` |
| `folder.todos.list()`, and a file collection's `list()` and `read(args)` | wait for the connection, then read the store now; when the folder failed or closed, answer `Err(OpenFolderError)` or `Unavailable` |

Only an interface reads `state()` and `unavailable()` (`<WhenOpen>` from
`@epicenter/svelte`), and nothing that reads a collection renders before it.
Code that runs before the connection calls an action, which waits. A write
shows in `items()` once it lands, before it answers.

```ts
await folder.todos.set({ id }, { done: true }); // the fields named; the rest stay
await folder.todos.delete({ id });
const todo = folder.todos.edit({ id });
todo.fields.title = 'Oat milk'; // saved
await folder.audio.set({ id, ext: 'webm' }, bytes);
```

**The connection.** The folder starts watching its store, lists every
visible file (no path segment starting with `.`), reads the text of every
note the contract claims in one call, then reads every path it heard in
between. That snapshot is the replica: the text of every contract note and
the version and size of every other file (an attachment, `AGENTS.md`, a
person's own file), never their bytes. Only the contract's paths are a
collection's items; the rest are there for sync. A change the store hears re-reads only its paths; a
change it cannot name (`'all'`) lists again and reads what differs, so
nothing shows empty meanwhile. Reads and writes of one path run in the
order they began. A note is parsed against the contract when its
collection is first read, and again when it changes. A collection's
`list()` lists that collection from the store again, for code that must see
another writer's change it may not have heard yet.

**One write.** `set(args, changes)` gives a note the fields named
(`undefined` removes one) and the body when given, keeping the rest, and
makes the note where none is. Every note the folder writes is in house
style, the contract's keys first. The folder writes over the version it
read; when the file moved in between, it reads and applies the change
again. The fields named take this write. A body the write replaces that
changed since the folder showed the note merges by lines with `settle`
(`@epicenter/definition/merge`), as sync merges it, and a clash keeps both
sides in a conflict block. A file's `set` is the later write winning
([ADR-0771](../../docs/adr/0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md));
a file is written whole, once. `delete` of a file already gone is done; one
changed since the folder showed it is kept, as sync keeps it. Writes queued
one after another at one path never clash with each other.

**Writes wait, then land or reject.** The folder keeps every write in one
queue, in the order made. While one cannot land (the network, the disk, the
account) it waits and tries again, `saving()` stays true, and
`unavailable()` says why; a write made while the folder connects waits for
the connection. When the folder fails or closes, every write still waiting
rejects with `FolderClosed`, whose `status` says which; a write made while
it is failed rejects too. Waiting writes live in the page's memory, so the
leave guard asks before the page closes.

**What the folder writes as asked.** A value that does not fit the contract
is written and the note shows in `invalid()`, as a note another program
wrote would. A change to a note whose front matter does not parse keeps the
note and adds the change as a conflict block. A placeholder is part of a
file name the app chooses
([ADR-0776](../../docs/adr/0776-a-notes-name-is-its-file-name-and-a-rename-is-a-set-and-a-delete.md)):
one that would leave the collection (empty, `/`, `..`, a leading `.`,
`:*?"<>|`, or a control character) throws before anything is written, as
does a value front matter cannot hold. A rename is a `set` at the new name
and a `delete` of the old.

A note that does not read is listed in `invalid` with its placeholders,
`text` (null when not UTF-8) and issues; repair it with `set` when its front
matter parses, or through an editor's `text` (`<NoteRepair>` in
`@epicenter/svelte`).

## Stores

Every place opens to a store: four verbs over bytes at paths
([ADR-0779](../../docs/adr/0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md)),
in `src/device/store.ts`. A store knows nothing of contracts or notes.

| Verb | What it answers |
| --- | --- |
| `list(under)` | every file at or below each of `under` (directories or file paths; `''` is everything), with its version and its size where the store knows it |
| `read(paths)` | each path's bytes and version, or `gone`, in one call |
| `put(path, bytes \| null, expect)` | the version that landed (null for a removal), only while the path holds `expect` (a version, or null for nothing); `Moved { now }` when it holds something else, carrying what |
| `watch(changed)` | the stop, once it is listening; from then `changed` hears the paths that changed, or `'all'` |

A version is a file's Git blob id on every store
([ADR-0808](../../docs/adr/0808-a-files-version-is-its-git-blob-id-on-every-store.md)),
and no app holds one: a note's (or a hidden file's) is the blob id of its
bytes, and an attachment's the blob id of its canonical Git LFS pointer,
computed from its sha256 and size (`blobIdOf` in `src/hash.ts`). A device
caches an attachment's hash by its stamp (size, modification time and file
identity) in `.epicenter/hashes.json` (`src/device/stamp-cache.ts`), under
Git's racy-clean rule: an entry holds only for a file last modified in an
earlier second than its hash, so a listing reads a recording once, and an
attachment is hashed again before a put replaces it. `putLanded` counts a
`Moved` whose `now` is the version the put meant to land as landed: a lost
reply. A device's listing leaves out `.git` and `.epicenter` at its root.
Every store answers a hint only once a read of the path answers the change.
`storeChecks` in `src/device/store.conformance.ts` holds memory, a Bun
directory, the desktop shell and a served directory to the same behavior in
`store.conformance.test.ts`, and the repository in
`src/remote/remote.postgres.test.ts`.

## Places

| Place | Where |
| --- | --- |
| `home({ site })` in a Tauri window | the `Data` root the shell named from the app's bundle identifier ([ADR-0752](../../docs/adr/0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)); opening it brings its root `AGENTS.md` up to date with the contract `site` publishes ([ADR-0772](../../docs/adr/0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md)) |
| `home({ site, account })` in a browser | the folder attached to the app the account signs in as (`joinFolder(account)`: the one the person holds, made at its first open, the first of several), reached by its id at `<git audience>/folders/<folder>` through `account.fetch`; it opens once the account is signed in, works online only, and stops when the account is retired |
| `directory(path)` | a directory, made when missing (`Unreadable` when it cannot be) |
| `served(url)` | the directory the program serving the page owns, through that program's `serveDirectory`; `StorageUnavailable` when nothing at `url` answers for one, and `Unavailable`, still opening, while the program is out of reach |
| `memory()`, and `home()` under `test` | memory, for the life of the process |

Opening a place either answers its store, a temporary failure the folder
tries again on its own (`Unavailable`, while `state()` stays `opening`), or
an `OpenFolderError`, which fails the folder. Every `OpenFolderError` is
something waiting will not fix: `Refused` (a place a folder can never be),
`Unreadable` (there but not openable), `Disconnected` (a link to a drive
that is not connected: the person connects it, then retries) and
`StorageUnavailable` (nothing at a served directory's URL answers, or not
a Tauri window, a shell that named no root or did not answer).
The account's repository waits for sign-in; a listing or write that cannot
reach it is `unavailable()`.

The places are separate stores, and nothing moves between them
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):
an app's web build keeps the account's repository and nothing in the
browser ([ADR-0786](../../docs/adr/0786-every-web-app-is-online-and-browser-storage-leaves-the-platform.md)),
and its desktop window the data folder, which sync moves.

In a Tauri window the folder works over the root the shell named, through the folder
plugin's commands, each naming that root by name, never by path; the shell
makes the data folder when nothing is at its path, checks each save, and
watches each root a page opened. See the folder plugin's README, and
`src/device/`.

The repository never merges: `folderRepository(account, folder)` in
`src/remote/repository.ts` commits each put where the path still holds the
blob its writer expects (null for nothing), and the server refuses the
commit when it does not, in the step that moves `main`
([`@epicenter/server`](../server/README.md)), which is `Moved` here. The
folder then reads what is there and applies the change again, settling a
body with `settle`. It speaks the server's routes in Git's vocabulary:
`changes` since a commit, the `tree` at a commit (a listing), `blobs` by id
(a note's bytes, many in one request), an attachment's bytes at
`blobs/<sha256>`, put before the commit names it, and `commits`. A watch
asks for `changes` every three seconds. The same object is the `Repository`
sync takes. A manifest names its repository only by `{ folder }`
(`RepositoryAddress`), and `folderUrl` in `@epicenter/definition/site` is
the one place that becomes an address.

The folder hears every write it makes before the write resolves, and
outside writes as they come: other tabs through the
`epicenter-device` broadcast channel, the shell's watcher in Tauri, a
recursive watch in Bun (which stages a probe in `.epicenter/saves` until it
hears one, so a change made while it started is not lost), and the
repository's poll.

`evidence/first-paint/node.ts` measures the time from open to the first
read of a collection over a directory with about 5,000 notes; the opt-in
`EPICENTER_MEASURE=1` test in `src/remote/remote.postgres.test.ts` measures
it over the repository on a slow link.

### Tests and scripts

Under the `test` condition (`bun test --conditions=test`) `home()` is a new
place in memory, so an app's `src/lib/app.ts` opens a folder in memory; a
test seeds it with the folder's own methods and mocks no module. A test
that opens its own folder uses `memory()`, or `directory(tmp)` for files on
disk; a script uses `directory(path)`:

```ts
import { openFolder } from '@epicenter/folder';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { directory } from '@epicenter/folder/node';

const scratch = openFolder(todos, directory('/tmp/todos'));
const place = memory();
const folder = openFolder(todos, place);
const other = openFolder(todos, place); // shares the files, hears folder's writes
```

`memoryFiles(placeOrFolder)` is the world outside a place in memory:
`write(path, content)` and `read(path)` as another program would (a file
that does not read, too), `paths(under?)`, `hold()` the folder's writes,
`refuse(reason, { under })` its writes (they wait, with `unavailable()`
saying why, until undone) and `refuseReads(reason, { under })` its reads
and listings as `Unavailable`, and `holdOpen()` or `refuseOpen(error)` a
folder's open (an `OpenFolderError` fails it; `Unavailable` keeps it
opening).

### Settings

An app's settings are flat notes at fixed paths, one per concern
(`settings.md`, `shortcuts.md`, ...), each a collection with no
placeholders in an ordinary `defineContract`, which sync with the folder.
What a capability keeps for this computer only (model choices, connected
endpoints, the microphone, shortcut overrides) is not a folder's: it is
this computer's settings, from
[`@epicenter/local`](../local/README.md). A secret is never a setting: on
the desktop the shell keeps API keys and the account's token in the app's
credentials file and reads them when it sends a request
([ADR-0740](../../docs/adr/0740-every-credential-an-app-holds-lives-in-its-own-place.md)).

## Native directories

Bun and Tauri open ordinary directories, with no required Git repository,
and write them as
[ADR-0702](../../docs/adr/0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md)
decides. A save stages its bytes in the folder's `.epicenter/saves` and
renames them over the path right after checking the version its writer read.
Within one process, writes to one path take turns, and a create lands only
where nothing is; across processes, a replacement's check-to-rename gap is
accepted, and Git history is the backstop. A new file is placed by a hard
link, which never replaces a file that appeared after the check, so of
writers creating one path in any process exactly one lands. A save below a
mount point inside the folder fails saying it cannot cross one. Nothing is
made beside the directory, a path that leaves it or names `.git` is refused,
and a name only some disks hold is never made.

The desktop shell (`storage.rs` in `tauri-plugin-epicenter-folder`) is the
strict host: it also refuses links and names stored under another spelling,
tightens an existing `.epicenter` to this account and refuses one that is a
link, and sweeps stale saves at each open. Bun's
store (`src/device/node-store.ts`) is a plain store over `node:fs` for the
CLI's `check` and `format`, scripts and tests: it writes only paths it
listed or a contract made, so those edge cases do not reach it, and a save
a stopped Bun process left waits for the shell's sweep.

`.epicenter` holds only unfinished writes: `saves/`, safe to delete when no
app runs, and `recordings/`, a desktop recording until it stops or is
recovered. `state.rs` in the folder core spells that layout, and `state.ts`
here the `saves/` a page writes, both held to one fixture;
`bun run check:state-paths` fails when other production code spells it. Like
every hidden path (`isHiddenPath`), it is not a folder's data: no watcher
reports it, a device's listing of its root leaves it out, and sync never
carries it. Watching is best effort.

History is not the folder's: a folder is plain files and its manifest, and
its history is the repository's on the server, which sync commits to
(ADR-0804). No Git runs on a computer.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/home.ts`, `home.memory.ts` | The root entry and its `test` leaf: `openFolder` and `home`. |
| `src/core.ts`, `node.ts`, `memory.ts`, `tauri.ts`, `bun.ts` | The other public entries. |
| `src/open-folder.ts`, `place.ts`, `folder.ts`, `errors.ts`, `note-edit.ts`, `note-codec.ts` | `openFolder` over a place, what a place is, the folder's connection, replica and write queue, its errors, the note editor, and how a note's change becomes the text written. |
| `src/device/` | The store contract and its conformance checks, the device stores (memory, Bun, Tauri), and `check`/`format`. |
| `src/data-folder.ts`, `desktop-folder.ts` | The data folder a Tauri window opens, and its `AGENTS.md`. |
| `src/remote/` | A folder's repository on the server: the `Repository` sync takes, and the store a web folder opens. |
| `src/served/`, `served.ts`, `serve.ts` | A directory a program serves its page: the page's store, the program's handler, and the wire between them (four `POST`s of JSON; a watch is a stream of JSON lines, and a dropped one is heard as `'all'`). |
| `src/native/`, `paths.ts`, `state.ts`, `path-turns.ts` | Watches, the shell's bindings, the path rule, where unfinished writes live, and per-path turns. |
| `src/sync/` | `sync`, its repository contract and memory twin, the manifest, the scenarios every world runs, and `syncAtMoments`. |
| `evidence/` | Recorded experiments and measurements, and the closure check. |

## Commands

```sh
bun run typecheck
bun run test
bun test evidence/closure
```

Each save changes one file; there is no multi-file transaction. Directory
change hints are best effort, and file bytes cross the desktop bridge whole.
