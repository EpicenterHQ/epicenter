# @epicenter/folder

Two surfaces open an app's files. The contract openers, `openDevice` and
`openRemote`, return the typed client an app's file contract derives
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md));
see [Contract openers](#contract-openers). The legacy `openFolder` below serves
only the Epicenter app's own folder editor and AI connections; every other
app is on a contract.

A Folder mirrors the files that storage last returned or accepted. It owns a
root, a serial write queue, and table views over Markdown files at
`<table>/<id>.md`. A table schema interprets rows; it does not limit what a
file may contain. Each typed value enters the write queue immediately. A Svelte
editor shows that value until its save answers, while the mirror shows only
landed storage.

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | The shared types and errors (`contract.ts`); it opens nothing. |
| `@epicenter/folder/browser` | `openDevice(contract)` over the origin's private file system, and `closeDevice`; `deviceFiles(device)`, the same files by path, with `append` for a file written while it is made (a recording, which `@epicenter/recorder/browser` appends a piece at a time; listeners hear it made and finished, not every piece). |
| `@epicenter/folder/node` | `openDevice(contract, { path })` over a directory (Bun), and `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`. |
| `@epicenter/folder/remote` | `openRemote(contract, { account })` over the signed-in person's repository. |
| `@epicenter/folder/tauri` | `openDevice(contract, { path?, create? })` over a root the shell lets this window reach: the directory it bound to the window (no `path`, or a relative one inside it), or a folder by absolute path that Tauri's file-system scope allows; and `openFolder` over the bound directory. A standalone app opens its two roots with `openAppData(settingsContract)` (its AppData root, through the app's own settings contract, whose `settings.md` has `folder`) and `openDataFolder(contract, { appData })` (the `folder` that names, or `~/Epicenter/<productName>`, which alone is made when missing; `defaultDataFolder()` answers that path). `rootOf(device)` answers the root a client opened by absolute path, as the shell answered it, for the window's other native commands (the recorder's and local transcription's `root`). `pickDataFolder(appData, { title, at? })` opens the native picker, which allows the folder it answers and answers its canonical path (the shell's `resolve_folder`), so `/tmp/x` and `/private/tmp/x` are one folder, and remembers that path, or forgets `folder` when the default is picked, for both "Choose folder…" and "Allow access"; `rememberFolder(appData, folder \| undefined)` records or forgets a choice. `syncWithEpicenter({ path, contract })` asks the shell to open `epicenter://init?path=<path>&contract=<contract>` (decisions 81 and 82), and `syncedWithEpicenter({ path })` says whether `epicenter init` set that folder up (its `.git/config` names it as `epicenter.root`). |
| `@epicenter/folder/bun` | Open an existing directory with `{ directory, tables }`; also exports the CLI's document readers (`readDirectoryDocuments`, `queryDocuments`) and the system `git` runner (`runGit`). |
| `@epicenter/folder/testing` | Construct a folder over `memoryHost` and control its storage in tests. |
| `@epicenter/folder/file-browser` | Text classification and newline helpers for a file editor. |
| `@epicenter/folder/documents` | Interpret saved Markdown files for the generic editor and SQL reader. |
| `@epicenter/folder/declaration` | Saved views: reading, changing, and their schema types. |

The opening entries export the types and `readRow` from `contract.ts`. Importing
an entry does not open a folder.

## Opening

```ts
import { openFolder } from '@epicenter/folder/bun';
import { Type } from 'typebox';

const tables = { notes: Type.Object({ title: Type.String() }) };
const opened = await openFolder({ directory: '/path/to/folder', tables });
if (opened.error !== null) throw opened.error;
const folder = opened.data;

const saved = await folder.tables.notes.create('milk', {
  fields: { title: 'Milk' },
  body: 'Two litres\n',
});
if (saved.error !== null) throw saved.error;
console.log(folder.tables.notes.row('milk')?.fields.title); // Milk
await folder.close();
```

A desktop page opens (`@epicenter/folder/tauri`) only the directory its shell
assigned before creating the window; the page names no path. A Bun caller supplies an existing directory. Opening needs no
account, network, Git repository, or `epicenter.json`, and creates no authored
file. `openFolder` returns a refusal when storage is unavailable or the root or
table names are invalid. It never falls back to another store.

## Reads

`files()` lists every path the mirror knows, and `file(path)` reads its current
`FolderFile`. Text files are kept as strings. Other files have
`data: undefined`; use `read(path)` to fetch their bytes. A failed read leaves
`readError` on the file and retains any earlier data. The mirror reads listed
text files when opening and reconciles outside changes through `refresh()`.
Its `subscribe(listener)` method reports changes to mirrored values. Native
directory watchers provide change hints; focus and explicit
refresh reconcile missed hints. A hint naming a file the mirror already holds
rereads that file without a full relist. New paths, directory hints, and
unnamed hints relist the folder.

`tables.notes.rows()` returns rows sorted by ID, and `row(id)` returns one row
or `undefined`. A row with `issues === null` has schema-typed fields and a
body. An invalid or unreadable row keeps its path and diagnostics so an editor
can offer repair. `readRow(text, schema)` interprets typed text with the same row
rules without writing it. A row's exact saved source is
`folder.file(row.path)?.data`.
`describeIssue` and `describeIssues` turn row diagnostics into sentences for a
repair view.

## Writes

`write(path, data)` creates or replaces a whole file at its queue turn.
`replace(path, data)` replaces only an existing file; if the file is absent at
its turn, it returns `NothingToUpdate`. A checked put prevents `replace` from
recreating a file deleted between its read and save. Whole-file editors use
`replace`. `update(path, patch, { schema? })` reads the file from storage at
its turn and sets only the named fields or body. Its put is checked against
the bytes read. If another writer changes the file before the put, the update
rereads and reapplies the patch for up to three checked attempts. If those
attempts all lose, it returns `KeptChanging` for the editor to show inline;
it never makes an unconditional final put.

A table has `create(id, { fields, body? })`, `update(id, patch)`, and
`delete(id)`; the folder also has `delete(path)` and `move(from, to)`.
`create` expects an absent path, including files the mirror has not heard
about. A stale reply that reads back the bytes it tried to create counts as
landed; identical existing content is indistinguishable from that case.
`move` reads the source when its turn runs, creates the destination only if
absent, then removes the source. A failed removal leaves both files and
returns `MoveIncomplete` with both paths. Setting a field to `undefined`
removes it. A patch that changes no value writes nothing. Updated
frontmatter is canonical: declared keys first, then other keys in sorted
order. Comments and original key order are not preserved by a patch.

Writes take turns in one serial queue. Waiting whole-file writes of the same
kind keep the newest data, and waiting updates through the same schema combine
their fields and newest body. A coalesced update reads storage at its one turn,
preserving outside changes to fields it does not name. Each coalesced caller
receives the same `Saved` answer after the mirror shows what landed, or a
`WriteError`. A failed put leaves the last read value in the mirror. The later
write wins on the same unit: an `update({ fields })` sets its named fields, an
`update({ body })` sets the body while keeping storage's frontmatter, and a
whole-file `write` or `replace` replaces the file. A whole-file write queued
after a field update can overwrite that field. A Folder runs no Git merge:
`epicenter sync` merges with `settle` from `@epicenter/definition/merge`.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through Folder instructions like any editor. Fields are never collaborative; they stay last-write-wins per field. No layer writes files except through the Folder. Agents may write files directly or issue the same Folder instructions through Epicenter; either way their changes reach editors through the Folder copy.

`idle()` waits for every queued turn, including immediately queued typing.
`close()` refuses new writes, drains admitted work, then releases storage and
watchers. Await a write's result when subsequent work requires durable bytes.
A UI edit and its retry or discard controls belong to
[`@epicenter/svelte`](../svelte/README.md), outside the Folder.

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
before writes. A
native watcher reports outside changes as hints, and `refresh()` rereads the
mirror. Watching is best effort, so an application also refreshes on return
to a visible window.
Native listings compare opaque stamps made from file size, modification time,
and file identity where available. A same-size replacement is found by a
refresh even when no watcher hint arrives. Reads and saves return the stamp
of the file they observed or published; checked writes still compare content
hashes.

History is not a Folder's: a folder gains Git only when `epicenter init`
registers it, and `epicenter sync` (in `@epicenter/cli`) is its only
committer, over the system `git` this package's `runGit` runs.

## Helpers

`openedFile(bytes, maxBytes)` from `@epicenter/folder/file-browser` classifies
exact bytes as editable UTF-8 text, binary content, or too large. It preserves
a byte order mark and CRLF in text. `withFileNewlines` applies the file's
line-ending style.

`documentsOf(folder.files())` from `@epicenter/folder/documents` interprets
saved Markdown at any path for the generic editor and SQL reader. It includes
schema diagnostics and unreadable paths. The declaration entry owns the
saved-view reader and writer; the declaration's JSON Schema is generated from
the TypeBox source. `@epicenter/folder/bun` exports the CLI's
`readDirectoryDocuments`, `queryDocuments`, and the `runGit` runner. These
tools can read or change a directory independently of an opened Folder.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/folder.ts`, `storage.ts`, `patch.ts`, `write-refusal.ts` | Mirror, host contract, canonical patches, and write refusals. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts`, `node.ts`, `testing.ts` | Public and test entries. |
| `src/device/` | `openDevice`: the contract client, its Bun, OPFS and Tauri stores, and `check`/`format`. |
| `src/remote/` | `openRemote` and its wire to the server. |
| `src/native/`, `tauri-files.ts`, `directory-store.ts` | Directory storage, watches, and bindings. |
| `src/shared/` | Markdown reading and rows. |
| `src/git/native-host.ts` | The system `git` runner the CLI's sync verbs use. |
| `src/declaration/`, `declaration.ts`, `directory-documents.ts` | Portable schemas and generic document reads. |
| `evidence/`, `smoke/` | Recorded experiments, the closure check, and browser smoke runs. |

## Commands

```sh
bun run typecheck
bun run test
bun test evidence/closure
```

Each save changes one file; there is no multi-file transaction. Directory
change hints are best effort, and file bytes cross the desktop bridge whole.
