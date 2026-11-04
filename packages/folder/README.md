# @epicenter/folder

`openFolder(contract)` hands an app its folder at once, already opening,
with the contract's collections directly on it. The contract openers below
it, `openDevice` and `openRemote`, open an app's files as the typed client
its file contract derives
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
Each write is conditional on the version its writer read, so another
writer's change since is a `Conflict` rather than overwritten. A Svelte app
makes the client reactive with `fromClient` from
[`@epicenter/svelte/client`](../svelte/README.md).

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | `openFolder(contract, { site, account }?)`, which the build picks: the desktop's data folder (`tauri`), this browser's storage or, with an `account`, the account's copy (`default`), and a new folder in memory under the `test` condition. |
| `@epicenter/folder/core` | The folder every build shares, with no platform code: its types, `createFolder`, `folderOf(client)` (a ready folder over a client already open, which `fromClient` adapts), and `OpenFolderError`. |
| `@epicenter/folder/browser` | `openDevice(contract)` over the origin's private file system, and `closeDevice`; `deviceFiles(device)`, the same files by path, with `append` for a file written while it is made (a recording, which `@epicenter/recorder/browser` appends a piece at a time; listeners hear it made and finished, not every piece). |
| `@epicenter/folder/node` | `openDevice(contract, { path })` over a directory (Bun), and `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`. |
| `@epicenter/folder/remote` | `openRemote(contract, { account, site })` over the signed-in person's repository. |
| `@epicenter/folder/tauri` | `openDevice(contract, { root })` opens a root the shell named, `Data` or `AppData`; `openDataFolder(contract, site)` opens Data and updates its root `AGENTS.md`, while `openAppData(settingsContract)` opens AppData. `rootOf(device)` answers the root's name for local transcription, and `displayPath(device)` the path to show, which `open_root` answered. `syncWithEpicenter` and `syncedWithEpicenter` manage Epicenter enrollment. |
| `@epicenter/folder/bun` | The CLI's system `git` runner (`runGit`). |

Importing an entry does not open anything.

## The folder

```ts
// src/lib/app.ts
export const folder = openFolder(todos, { site: APPS.TODOS.url });
```

`openFolder` returns synchronously
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md),
[ADR-0767](../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md)):

| Member | What it does |
| --- | --- |
| `folder.state()` | `opening`, `ready`, or `failed` with the typed `OpenFolderError`; the same object until it changes |
| `folder.subscribe(fn)` | hears `state()` change; returns the unsubscribe |
| `folder.retry()` | opens again after a failure; does nothing otherwise |
| `folder.reveal` | shows the desktop's data folder in the file manager, even when it did not open; null on the web and in memory |
| `folder[Symbol.dispose]()` | closes what it opened, even an open still under way |
| `folder.todos.items()`, `invalid()`, `loading()`, `error()` | answer at once: empty and loading while the folder opens; listed while something subscribes to the collection |
| `folder.todos.list()`, `get`, `create`, `update`, `replace`, `delete` | wait for the open, then run; when it fails, answer `Err(OpenFolderError)` |

Only an interface reads `state()` (`<Opening>` from `@epicenter/svelte`).
Everything else reads and acts, and an action called while the folder opens
completes once it has. A collection's writes show in its `items()` before
they resolve. Under the `test` condition (`bun test --conditions=test`) the
folder is a new one in memory; a test seeds it with `create` and mocks no
module. A Node script opens a directory with `openDevice(contract, { path })`
from `/node`, since its path varies by call.

## Contract openers

`openDevice(contract, …)` opens the typed client an app's contract derives
(`Client<T>` from `@epicenter/definition/contract`) over a device's files, at
the contract's paths. It is async on every platform and answers a `Result`:
the client, or an `OpenFolderError` saying why nothing opened
(`Disconnected`, `Refused`, `Unreadable`, `StorageUnavailable`). An app opens it
once, at its startup, and hands the client down:

```ts
import { openDevice } from '@epicenter/folder/browser'; // OPFS
// import { openDevice } from '@epicenter/folder/node';           // a directory: openDevice(c, { path })
// import { openDevice } from '@epicenter/folder/tauri';          // a root the shell named: openDevice(c, { root: 'Data' })

const opened = await openDevice(recorder);
if (opened.error !== null) return opened;
const device = opened.data;
const id = timeId();
// The audio first: a note never names bytes that are not there yet.
const audio = await device.audio.create({ id, ext: 'm4a', bytes });
if (audio.error === null)
	await device.recordings.create({ id, title: 'Standup' });
```

Every note it writes is in house style, the contract's keys first. Every
update and delete carries the version (sha256) its writer read, and lands
only while the file still holds it (`Conflict` otherwise); `create` never
replaces a file (`Occupied`). No write lands over whatever is there. In the browser, one dedicated Worker owns the
origin's private file system, with a Web Lock per path; a browser that gives
the page no private storage still opens, and each call answers `Unavailable`
with a `DeviceError.StorageRefused` cause, so an app keeps working in memory.
An append (`deviceFiles(device).append`) makes its file whole like any new
file, then adds each later piece at the end through a sync access handle
opened and closed for that piece, so a crash keeps every piece written; a
read that an append overtook reads again.
Only a context with no Worker opens nothing (`StorageUnavailable`). In Bun
the directory is made when missing (`Unreadable` when it cannot be). `/node` also exports `checkFiles`
and `formatNotes`, which `epicenter check` and `epicenter format` run. In a
Tauri window the client works over a root the shell named, through the
folder plugin's commands, each naming that root by name, never by path; the
shell makes the data folder when nothing is at its path, checks each save,
and watches each root a page opened. See the folder plugin's README, and
`src/device/`; `bun run --cwd packages/folder smoke:device` drives the
browser opener in Playwright Chromium and WebKit.

Each collection's `subscribe(listener)` hears that its files changed, with
no word of what (read again to see). The device hears every write through
it before the write resolves, and outside
writes as they come: other tabs through the Worker's `epicenter-device`
broadcast channel, the shell's watcher in Tauri, a recursive watch in Bun.
Bun's watch starts listening some time after it is made, so it stages a
probe in `.epicenter/saves` until it hears one, then tells its listeners to
read again: a change made while it started is not lost. A remote hears its own writes the same way, and other writers' by reading
`main` (`GET <repo>.git/epicenter/head`) every three seconds while anything
listens, until the notify Durable Object replaces the poll. A listener can
run when nothing it shows changed, never for a hidden path.

A note that does not read is listed in `invalid` with its placeholders,
`text` (null when not UTF-8) and `version`. Repair it with `update` when its
front matter parses, else `replace(args, text, { over })`, which writes the
whole note from text that reads and fits, in house style. `updateNote`
(`@epicenter/definition/contract`) is the one rule for an edit that meets a
`Conflict`; `fromClient` in `@epicenter/svelte/client` is the Svelte state
over a client.

`openRemote(contract, { account, site })` returns the same client over the
signed-in person's repository for the app, `<git audience>/~/<name derived from site>.git`, through `account.fetch` (any `@epicenter/account` `Account`). A
remote version is the Git blob id on `main`, and every write is one commit.
It keeps nothing on the device: it works online only, and stops when the
account is retired.

```ts
import { openRemote } from '@epicenter/folder/remote';

const remote = openRemote(recorder, { account, site: 'https://whispering.epicenter.so' });
const note = await remote.recordings.get({ id });
if (note.error === null)
	await remote.recordings.update({ id }, { title: 'Daily' }, { over: note.data.version });
```

The two openers are two stores, and nothing moves between them
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)): an app's local web variant opens the device
for its life, its online web variant the remote, and its desktop variant the
folder through `/tauri`, which only `epicenter sync` moves. Sign-in grants
capabilities, never storage. See `src/remote/`.

### Settings

An app's settings are flat notes at fixed paths, one per concern
(`settings.md`, `shortcuts.md`, …), each a collection with no placeholders
in an ordinary `defineContract`. A desktop app with machine-local settings has an AppData contract. The same
notes may sit in both of its roots: the data folder holds the synced values (its contract claims the
notes it syncs), the AppData root this computer's sparse overrides. A
reader resolves each note with a shallow spread, where it reads it: a key
in the AppData note wins, then the data folder's, then the default
(`keysOf`, the app's own, drops what every note carries, its `body` and
`version`; a missing note spreads nothing):

```ts
const shortcuts = {
	...SHORTCUT_DEFAULTS,
	...keysOf(device.shortcuts.get({})), // the data folder: synced
	...keysOf(appData.shortcuts.get({})), // this computer only
};
```

The shell derives the data folder from the app's site. A local web app
spreads defaults and its device note; an online web app reads its notes
from the repository. API keys never go in a settings note: they stay in the
keychain.

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
never commits it. A native watcher reports outside changes, and a client's
listeners hear them. Watching is best effort.
Native listings compare opaque stamps made from file size, modification time,
and file identity where available; a read returns the stamp of the file it
read, and checked writes compare content hashes.

History is not the client's: a folder gains Git only when `epicenter init`
registers it, and `epicenter sync` (in `@epicenter/cli`) is its only
committer, over the system `git` this package's `runGit` runs.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/browser.ts`, `tauri.ts`, `bun.ts`, `node.ts`, `remote.ts` | Public entries. |
| `src/device/` | `openDevice`: the contract client, its Bun, OPFS and Tauri stores, and `check`/`format`. |
| `src/remote/` | `openRemote` and its wire to the server. |
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
