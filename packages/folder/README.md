# @epicenter/folder

`openFolder(contract, place)` hands an app its folder at once, already
opening, with the contract's collections directly on it. The place says
where the folder is: the app's `home`, a `directory`, or memory under test
([ADR-0773](../../docs/adr/0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md)).
A write makes it so: the folder reads the file just before writing it,
writes over exactly what it read, and settles a change made since the way
sync does, so nothing another writer did is overwritten unseen
([ADR-0774](../../docs/adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md)).
A write never fails: the folder keeps it, in order, until it lands
([ADR-0775](../../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).
The folder has the shape every capability has: synchronous reads, actions
that answer promises, and one `subscribe`. A Svelte app reads it through
`reactive` from [`@epicenter/svelte/reactive`](../svelte/README.md); React
reads it with `useSyncExternalStore`.

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | `openFolder(contract, place)`, and `home({ site, account }?)`, the app's own place, which the build picks: the desktop's data folder (`tauri`), this browser's storage or, with an `account`, the account's repository (`default`), and a new place in memory under the `test` condition. |
| `@epicenter/folder/core` | The folder's types (`Folder`, `FolderNotes`, `FolderFiles`, `FolderLifecycle`, `NoteEdit`, `Unavailable`, `Place`, ...) and `OpenFolderError`, the same on every build, for a library that takes a folder or a collection. |
| `@epicenter/folder/node` | `directory(path)`, a directory as a place, for scripts and tests (Bun or Node), and `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`. |
| `@epicenter/folder/memory` | `memory()`, a new place in memory, and `memoryFiles(placeOrFolder)`, the world outside it, for a test. |
| `@epicenter/folder/tauri` | `revealRoot(root)`, which shows a root the shell named in the file manager, and `syncWithEpicenter` and `syncedWithEpicenter` for Epicenter enrollment. Machine-local state goes to AppData through `localFile` from `@epicenter/local`, not through a folder. |
| `@epicenter/folder/bun` | The CLI's system `git` runner (`runGit`). |

Importing an entry does not open anything. A place is opaque: only this
package makes one, and nothing outside it holds a store or the collections
under a folder.

## The folder

```ts
// src/lib/app.ts
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account }));
```

`openFolder` returns synchronously
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md),
[ADR-0767](../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md)):

| Member | What it does |
| --- | --- |
| `folder.state()` | `opening`, `open`, `failed` with the typed `OpenFolderError` and the `retry()` that opens again once the person has acted (answering once that attempt settles), or `closed` once disposed; the same object until it changes |
| `folder.unavailable()` | why the store cannot be reached or written now, else null: while opening the folder keeps trying, and while open what it shows may be old and writes wait; it clears on its own, and is null once failed or closed |
| `folder.saving()` | whether a write is out, from its call or an editor's keystroke until it lands; `<WhenOpen>` reads it for the leave guard and its status line |
| `folder.subscribe(fn)` | hears `state()`, `unavailable()`, `saving()` or `displayPath()` change; returns the unsubscribe |
| `folder.displayPath()` | the desktop data folder's path as the shell named it, to show a person, once it opened; null before, and at any other place |
| `folder.reveal` | shows the desktop's data folder in the file manager, even when it did not open; null at any other place |
| `folder[Symbol.dispose]()` | closes what it opened, even an open still under way; the writes waiting are not made, and a later write throws |
| `folder.todos.items()`, `invalid()`, `loading()`, `get(args)` | answer at once: empty and loading until the first listing lands; listed while something subscribes to the collection; `get(args)` is the entry shown |
| `folder.todos.set(args, changes)`, `delete(args)`, and a file collection's `set(args, bytes)` | answer once the write has landed, and never fail |
| `folder.todos.edit(args)` | one note as an immediate editor (`NoteEdit`): its fields and body one by one, or its whole `text`, with its own reads and `subscribe` |
| `folder.todos.list()`, and a file collection's `read(args)` and `append` | wait for the open, then read or append now; when it failed, answer `Err(OpenFolderError)` |

Only an interface reads `state()` and `unavailable()` (`<WhenOpen>` from
`@epicenter/svelte`). Everything else reads and acts, and an action called
while the folder opens completes once it has. A write shows in `items()`
once it lands, before it answers.

```ts
await folder.todos.set({ id }, { done: true }); // the fields named; the rest stay
await folder.todos.delete({ id });
const todo = folder.todos.edit({ id });
todo.fields.title = 'Oat milk'; // saved
await folder.audio.set({ id, ext: 'webm' }, bytes);
```

**One write.** `set(args, changes)` gives a note the fields named (`undefined`
removes one) and the body when given, keeping the rest, and makes the note
where none is. Every note the folder writes is in house style, the
contract's keys first. The folder reads the file just before writing and
writes over exactly what it read (the store's version, which never leaves
the package); when the file moved in between, it reads and applies the
change again. The fields named take this write. A body the write replaces
that changed since the folder showed the note merges by lines with `settle`
(`@epicenter/definition/merge`), as sync merges it, and a clash keeps both
sides in a conflict block. A file's `set` is the later write winning
(ADR-0771). `delete` of a file already gone is done; one changed since the
folder showed it is kept, as sync keeps it. Writes queued one after another
at one path never clash with each other.

**Writes never fail.** The folder keeps every write in one queue, in the
order made. While one cannot land (the network, the disk, the account) it
waits and tries again, `saving()` stays true, and `unavailable()` says why;
a write made while the folder opens waits for the open. When the folder
fails or closes, the writes waiting then are not made, and their promises
never answer. Waiting writes live in the page's memory, so the leave guard
asks before the page closes.

**What the folder writes as asked.** A value that does not fit the contract
is written and the note shows in `invalid()`, as a note another program
wrote would. A change to a note whose front matter does not parse keeps the
note and adds the change as a conflict block. A placeholder is part of a
file name the app chooses (ADR-0776): one that would leave the collection
(empty, `/`, `..`, a leading `.`, `:*?"<>|`, or a control character) throws
before anything is written, as does a value front matter cannot hold. A
rename is a `set` at the new name and a `delete` of the old.

A note that does not read is listed in `invalid` with its placeholders,
`text` (null when not UTF-8) and issues; repair it with `set` when its front
matter parses, or through an editor's `text` (`<NoteRepair>` in
`@epicenter/svelte`).

A file collection's `append(args, bytes, { create, announce })` adds bytes
to the end of a file written while it is made, such as a recording
(`@epicenter/recorder/browser` appends a piece at a time). It answers
whether the bytes landed: with `create` they land only where no file is,
and without, only where the file still is. Listeners hear the file made,
and after that only an append with `announce`. Only this browser's storage
appends; at any other place `append` answers `Unavailable`. An append is
not queued with the folder's writes.

## Places

| Place | Where | Version (internal) |
| --- | --- | --- |
| `home()` on the desktop | the `Data` root the shell named from the app's bundle identifier ([ADR-0752](../../docs/adr/0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)); opening it brings its root `AGENTS.md` up to date with the contract `site` publishes ([ADR-0772](../../docs/adr/0772-a-folder-says-what-it-is-in-agents-md-and-this-computer-keeps-the-rest.md)) | sha256 |
| `home()` on the web | this origin's private file system (OPFS), for good | sha256 |
| `home({ site, account })` on the web | the account's repository for `site`, `<git audience>/~/<name derived from site>.git`, through `account.fetch`; it opens once the account is signed in, works online only, and stops when the account is retired | Git blob id on `main` (for a file kept with Git LFS, the blob of its pointer) |
| `directory(path)` | a directory, made when missing (`Unreadable` when it cannot be) | sha256 |
| `memory()`, and `home()` under `test` | memory, for the life of the process | sha256 |

A version is how a store names the bytes a write must land over; no app
holds one. A device store's sha256 of a non-note file is that file's Git
LFS object id; naming a device's notes by their Git blob id too
(ADR-0774) waits on the desktop shell's checked writes, which compare
sha256.

Opening a place either answers its store, a temporary failure the folder
tries again on its own (`Unavailable`, while `state()` stays `opening`), or
an `OpenFolderError`, which fails the folder. Every `OpenFolderError` is
something waiting will not fix: `Refused` (a place a folder can never be),
`Unreadable` (there but not openable), `Disconnected` (a link to a drive
that is not connected: the person connects it, then retries) and
`StorageUnavailable` (no Worker, not a Tauri window, a shell that named no
root or did not answer). No place answers a temporary failure today; the
account's repository waits for sign-in instead, and a listing or write that
cannot reach it is `unavailable()` while open.

Every place opens to a store that holds bytes at paths, and one typed
client over it gives the folder the contract's notes and files
(`src/device/client.ts`). A listing passes the collection's directory as a
hint (the repository reads only that folder), and a note listing reads only
the notes whose stamp changed since the last.

The places are separate stores, and nothing moves between them
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)):
an app's local web variant keeps this browser's storage for its life, its
online web variant the repository, and its desktop variant the data folder,
which only `epicenter sync` moves. Sign-in grants capabilities, never
storage.

In the browser, one dedicated Worker owns the origin's private file system,
with a Web Lock per path. A browser that gives the page no private storage
still opens, and each call answers `Unavailable` with a
`DeviceError.StorageRefused` cause, so an app keeps working in memory. Only
a context with no Worker opens nothing (`StorageUnavailable`). An append
makes its file whole like any new file, then adds each later piece at the
end through a sync access handle opened and closed for that piece, so a
crash keeps every piece written; a read that an append overtook reads
again. In a Tauri window the folder works over the root the shell named,
through the folder plugin's commands, each naming that root by name, never
by path; the shell makes the data folder when nothing is at its path, checks
each save, and watches each root a page opened. See the folder plugin's
README, and `src/device/`; `bun run --cwd packages/folder smoke:device`
drives a folder at this browser's storage in Playwright Chromium and WebKit.

The repository never merges a web write: each file of a write names the
blob its writer read (or null for nothing), and the server refuses the write
when the path no longer holds it, in the step that moves `main`
([`@epicenter/server`](../server/README.md)). The folder then reads what is
there and applies the change again, settling a body with `settle`. A note
travels as text; any other file's bytes travel as a Git LFS object,
uploaded before the write names it. See `src/remote/`.

A collection's `subscribe(listener)` hears that its files changed, and the
folder lists again. The folder hears every write it makes before the write
resolves, and outside writes as they come: other tabs through the Worker's
`epicenter-device` broadcast channel, the shell's watcher in Tauri, a
recursive watch in Bun (which stages a probe in `.epicenter/saves` until it
hears one, so a change made while it started is not lost), and on the
repository a read of `main` (`GET <repo>.git/epicenter/head`) every three
seconds while anything listens, until the notify Durable Object replaces
the poll.

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
endpoints, shortcut overrides) is not a folder's: it lives in AppData
through `localFile` from `@epicenter/local`
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
API keys never go in a settings note: they stay in the keychain.

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
here the `saves/` a page writes, both held to one fixture with the OPFS
worker's copy;
`bun run check:state-paths` fails when other production code spells it. Like
every hidden path (`isHiddenPath`), it is not a folder's data: no watcher
reports it, listings show it for their readers to skip, and `epicenter sync`
never commits it. A native watcher reports outside changes, and a folder's
listeners hear them. Watching is best effort.
Native listings compare opaque stamps made from file size, modification time,
and file identity where available; a read returns the stamp of the file it
read, and checked writes compare content hashes.

History is not the folder's: it gains Git only when `epicenter init`
registers it, and `epicenter sync` (in `@epicenter/cli`) is its only
committer, over the system `git` this package's `runGit` runs.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/home.ts`, `home.tauri.ts`, `home.memory.ts` | The root entry, one leaf per build: `openFolder` and that build's `home`. |
| `src/core.ts`, `node.ts`, `memory.ts`, `tauri.ts`, `bun.ts` | The other public entries. |
| `src/open-folder.ts`, `place.ts`, `folder.ts`, `note-edit.ts`, `note-codec.ts` | `openFolder` over a place, what a place is, the folder and its write queue, the note editor, and how a note's change becomes the text written. |
| `src/device/` | A contract's collections over a store (`client.ts`), the stores (memory, Bun, OPFS, Tauri), and `check`/`format`. |
| `src/browser.ts`, `desktop-folder.ts` | This browser's storage as a place, and the desktop folder's `AGENTS.md`. |
| `src/remote/` | The repository as a store, and its wire to the server. |
| `src/native/`, `paths.ts`, `state.ts`, `path-turns.ts` | Watches, the shell's bindings, the path rule, where unfinished writes live, and per-path turns. |
| `src/git/native-host.ts` | The system `git` runner the CLI's sync verbs use. |
| `evidence/`, `smoke/` | Recorded experiments, the closure check, and browser smoke runs. |

## Commands

```sh
bun run typecheck
bun run test
bun test evidence/closure
```

Each save changes one file; there is no multi-file transaction. Directory
change hints are best effort, and file bytes cross the desktop bridge whole.
