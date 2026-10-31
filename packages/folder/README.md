# @epicenter/folder

The contract openers, `openDevice` and `openRemote`, open an app's files as
the typed client its file contract derives
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
Each write is conditional on the version its writer read, so another
writer's change since is a `Conflict` rather than overwritten. A Svelte app
makes the client reactive with `fromClient` from
[`@epicenter/svelte/client`](../svelte/README.md).

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | `OpenDeviceError`, why `openDevice` opened no client; it opens nothing. |
| `@epicenter/folder/browser` | `openDevice(contract)` over the origin's private file system, and `closeDevice`; `deviceFiles(device)`, the same files by path, with `append` for a file written while it is made (a recording, which `@epicenter/recorder/browser` appends a piece at a time; listeners hear it made and finished, not every piece). |
| `@epicenter/folder/node` | `openDevice(contract, { path })` over a directory (Bun), and `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`. |
| `@epicenter/folder/remote` | `openRemote(contract, { account })` over the signed-in person's repository. |
| `@epicenter/folder/tauri` | `openDevice(contract, { path?, create? })` over a root the shell lets this window reach: the directory it bound to the window (no `path`, or a relative one inside it), or a folder by absolute path that Tauri's file-system scope allows. A standalone app opens its two roots with `openAppData(settingsContract)` (its AppData root, through the app's own settings contract, whose `settings.md` has `folder`) and `openDataFolder(contract, { appData })` (the `folder` that names, or `~/Epicenter/<productName>`, which alone is made when missing; `defaultDataFolder()` answers that path). `rootOf(device)` answers the root a client opened by absolute path, as the shell answered it, for the window's other native commands (the recorder's and local transcription's `root`). `pickDataFolder(appData, { title, at? })` opens the native picker, which allows the folder it answers and answers its canonical path (the shell's `resolve_folder`), so `/tmp/x` and `/private/tmp/x` are one folder, and remembers that path, or forgets `folder` when the default is picked, for both "Choose folder…" and "Allow access"; `rememberFolder(appData, folder \| undefined)` records or forgets a choice. `syncWithEpicenter({ path, contract })` asks the shell to open `epicenter://init?path=<path>&contract=<contract>` (decisions 81 and 82), and `syncedWithEpicenter({ path })` says whether `epicenter init` set that folder up (its `.git/config` names it as `epicenter.root`). |
| `@epicenter/folder/bun` | The CLI's system `git` runner (`runGit`). |

Importing an entry does not open anything.

## Contract openers

`openDevice(contract, …)` opens the typed client an app's contract derives
(`Client<T>` from `@epicenter/definition/contract`) over a device's files, at
the contract's paths. It is async on every platform and answers a `Result`:
the client, or an `OpenDeviceError` saying why nothing opened (`Missing`,
`NotGranted`, `Refused`, `Unreadable`, `StorageUnavailable`). An app opens it
once, at its startup, and hands the client down:

```ts
import { openDevice } from '@epicenter/folder/browser'; // OPFS
// import { openDevice } from '@epicenter/folder/node';           // a directory: openDevice(c, { path })
// import { openDevice } from '@epicenter/folder/tauri';          // a root the window may reach

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
replaces a file (`Occupied`). In the browser, one dedicated Worker owns the
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
Tauri window the client works over a root the shell opened for it, through
the folder plugin's commands, and the shell checks each save and watches
each root a page opened. A root other than the bound directory opens only
when Tauri's runtime file-system scope allows it (the shell's default, or a
folder the picker allowed); see the folder plugin's README. See
`src/device/`; `bun run --cwd packages/folder smoke:device` drives the
browser opener in Playwright Chromium and WebKit.

Each collection's `subscribe(listener)` hears that its files changed, with
no word of what (read again to see). The device hears every write through
it before the write resolves, and outside
writes as they come: other tabs through the Worker's `epicenter-device`
broadcast channel, the shell's watcher in Tauri, a recursive watch in Bun.
A remote hears its own writes the same way, and other writers' by reading
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

`openRemote(contract, { account })` returns the same client over the
signed-in person's repository for the app, `<git audience>/~/<contract
name>.git`, through `account.fetch` (any `@epicenter/auth` `Account`). A
remote version is the Git blob id on `main`, and every write is one commit.
It keeps nothing on the device: it works online only, and stops when the
account is retired.

```ts
import { openRemote } from '@epicenter/folder/remote';

const remote = openRemote(recorder, { account });
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
in an ordinary `defineContract`. A desktop app has one settings contract,
whose `settings.md` declares `folder`, and the same notes may sit in both of
its roots: the data folder holds the synced values (its contract claims the
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

`folder`, the data folder the person chose, is the one key only the AppData
root holds; absent, the app opens `~/Epicenter/<productName>`.
`rememberFolder(appData, folder | undefined)` writes or clears it, keeping
the note's other keys. A local web app has one root, so it spreads the
defaults and its device's note; an online web app reads its notes from the
repository. API keys never go in a settings note: they stay in the
keychain.

## Native directories

Bun and Tauri open ordinary directory files, with no required Git repository.
They stage a replacement in the directory's own `.epicenter/scratch` and
rename one whole file over its path, after checking it still holds the
version the writer read. No lock spans that check and the rename: a save
another program lands in that instant can be replaced, and Git history is
the backstop (ADR-0568). No listing shows `.epicenter`, no watcher reports
it, and nothing is made beside the directory. Paths and links are checked
before writes. A native watcher reports outside changes, and a client's
listeners hear them. Watching is best effort.
Native listings compare opaque stamps made from file size, modification time,
and file identity where available. Reads and saves return the stamp of the
file they observed or published; checked writes compare content hashes.

History is not the client's: a folder gains Git only when `epicenter init`
registers it, and `epicenter sync` (in `@epicenter/cli`) is its only
committer, over the system `git` this package's `runGit` runs.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts`, `node.ts`, `remote.ts` | Public entries. |
| `src/device/` | `openDevice`: the contract client, its Bun, OPFS and Tauri stores, and `check`/`format`. |
| `src/remote/` | `openRemote` and its wire to the server. |
| `src/native/`, `tauri-files.ts`, `directory-store.ts` | Directory storage, watches, and bindings. |
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
