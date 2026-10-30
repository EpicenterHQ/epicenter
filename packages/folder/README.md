# @epicenter/folder

Two surfaces open an app's files. The contract openers, `openDevice` and
`openRemote`, return the typed client an app's file contract derives
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md));
see [Contract openers](#contract-openers). The legacy `openFolder` below serves
the apps that have not moved to a contract.

A Folder mirrors the files that storage last returned or accepted. It owns a
root, a serial write queue, and table views over Markdown files at
`<table>/<id>.md`. A table schema interprets rows; it does not limit what a
file may contain. Each typed value enters the write queue immediately. A Svelte
editor shows that value until its save answers, while the mirror shows only
landed storage.

## Entries

| Import | Purpose |
| --- | --- |
| `@epicenter/folder` | Open this browser origin's default folder or the directory bound to this Tauri window. Apps may alias this exact specifier to one platform entry at build time. |
| `@epicenter/folder/browser` | `openDevice(contract)` over the origin's private file system, `closeDevice`, and `outboxOf`; and `openFolder`, the fixed IndexedDB folder in a web page, which refuses inside Tauri. |
| `@epicenter/folder/node` | `openDevice(contract, { path })` over a directory (Bun), `outboxOf`, and `checkFiles` and `formatNotes` for `epicenter check` and `epicenter format`. |
| `@epicenter/folder/remote` | `openRemote(contract, { account })` over the signed-in person's repository, and `startUploading(device, remote)`. |
| `@epicenter/folder/tauri` | `openDevice(contract, { path? })` over the directory the shell bound to this window (its local data folder), and `openFolder` over the same directory. Both refuse outside Tauri. |
| `@epicenter/folder/bun` | Open an existing directory with `{ directory, tables }`; also exports the CLI's declaration tools, `holdingFileLock`, and the system `git` runner. |
| `@epicenter/folder/testing` | Construct a folder over `memoryHost` and control its storage in tests. |
| `@epicenter/folder/file-browser` | Pure path, tree, text classification, and newline helpers. |
| `@epicenter/folder/documents` | Interpret saved Markdown files for the generic editor and SQL reader. |
| `@epicenter/folder/declaration` | Portable declaration schemas and view transforms. |

The opening entries export the types and `readRow` from `contract.ts`. Importing
an entry does not open a folder.

## Opening

```ts
import { openFolder } from '@epicenter/folder';
import { Type } from 'typebox';

const tables = { notes: Type.Object({ title: Type.String() }) };
const opened = await openFolder({ tables });
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

A browser opens one fixed IndexedDB folder for its origin. A desktop page opens
only the directory its shell assigned before creating the window; the page
names no path. A Bun caller supplies an existing directory. Opening needs no
account, network, Git repository, or `epicenter.json`, and creates no authored
file. `openFolder` returns a refusal when storage is unavailable or the root or
table names are invalid. It never falls back to another store.

## Reads

`files()` lists every path the mirror knows, and `file(path)` reads its current
`FolderFile`. Text files are kept as strings. Other files have
`data: undefined`; use `read(path)` to fetch their bytes. A failed read leaves
`readError` on the file and retains any earlier data. The mirror reads listed
text files when opening and reconciles outside changes through `refresh()`.
Its `subscribe(listener)` method reports changes to mirrored values. Browser
tabs and native directory watchers provide change hints; focus and explicit
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

`openDevice(contract, …)` returns the typed client an app's contract derives
(`Client<T>` from `@epicenter/definition/contract`) over a device's files, at
the contract's paths:

```ts
import { openDevice, outboxOf } from '@epicenter/folder/browser'; // OPFS
// import { openDevice } from '@epicenter/folder/node';           // a directory: openDevice(c, { path })
// import { openDevice } from '@epicenter/folder/tauri';          // the window's bound directory

const device = openDevice(recorder);
const id = timeId();
const note = await device.recordings.create({ id, title: 'Standup' });
const audio = await device.audio.create({ id, ext: 'm4a', bytes });
if (note.error === null && audio.error === null)
	await outboxOf(device).add({
		id,
		files: [
			{ collection: 'recordings', ...note.data },
			{ collection: 'audio', ...audio.data },
		],
	});
```

Every note it writes is in house style, the contract's keys first. Every
update and delete carries the version (sha256) its writer read, and lands
only while the file still holds it (`Conflict` otherwise); `create` never
replaces a file (`Occupied`). In the browser, one dedicated Worker owns the
origin's private file system, with a Web Lock per path; a browser that gives
the page no private storage answers `Unavailable` with a
`DeviceError.StorageRefused` cause. The outbox records captures for upload
as sidecars under `.epicenter/outbox/`. `/node` also exports `checkFiles`
and `formatNotes`, which `epicenter check` and `epicenter format` run. In a
Tauri window the client works over the directory the shell bound to the
window, through the folder plugin's commands, and the shell holds the save
lock. A page names no directory, so `path` there is a relative folder
inside the bound one. See
`src/device/`; `bun run --cwd packages/folder smoke:device` drives the
browser opener in Playwright Chromium and WebKit.

`openRemote(contract, { account })` returns the same client over the
signed-in person's repository for the app, `<git audience>/~/<contract
name>.git`, through `account.fetch` (any `@epicenter/auth` `Account`). A
remote version is the Git blob id on `main`. `startUploading` sends each
capture in the device's outbox, once signed in and online, and deletes the
local copy only at the version the server's receipt shows landed:

```ts
import { openRemote, startUploading } from '@epicenter/folder/remote';

const remote = openRemote(recorder, { account });
using uploader = startUploading(device, remote); // Symbol.dispose stops it

const note = await remote.recordings.get({ id });
if (note.error === null)
	await remote.recordings.update({ id }, { title: 'Daily' }, { over: note.data.version });
```

The web never syncs: edits and deletes of repository files need the server,
and only files created on the device wait in the outbox. Uploading stops
when the account is retired. See `src/remote/`.

## Browser storage

The [browser repository engine](src/browser/README.md) behind the legacy
`openFolder` stores the current folder as an immutable Git working tree in
IndexedDB. Local saves create no Git commit. The browser no longer exchanges
Git: the web never syncs, and new apps use `openDevice` instead.

## Native directories

Bun and Tauri open ordinary directory files, with no required Git repository.
They stage a replacement beside the directory and rename one whole file under
a shared save lock. Bun takes this lock through an exclusive SQLite
transaction; the Tauri plugin uses the same boundary. Paths and links are
checked before writes. A native watcher reports outside changes as hints, and
`refresh()` rereads the mirror. Watching is best effort, so an application
also refreshes on return to a visible window.
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
a byte order mark and CRLF in text. `visibleRows` builds a file tree from a
listing, and `withFileNewlines` applies the file's line-ending style.

`documentsOf(folder.files())` from `@epicenter/folder/documents` interprets
saved Markdown at any path for the generic editor and SQL reader. It includes
schema diagnostics and unreadable paths. The declaration entry owns portable
schema and saved-view readers; its JSON Schema is generated from the TypeBox
source. `@epicenter/folder/bun` exports the CLI's `checkFolder`,
`queryFolder`, declaration tools, `holdingFileLock`, and the `runGit` runner. These tools can read or
change a directory independently of an opened Folder.

## Building for one environment

Alias only the bare specifier in a build that targets one host:

```ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

Use `/browser` for a browser-only build. Without an alias, the bare entry
chooses at call time and loads only the chosen engine. The
[`evidence/bundles`](evidence/bundles/) tests inspect emitted chunks.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/folder.ts`, `storage.ts`, `patch.ts`, `write-refusal.ts` | Mirror, host contract, canonical patches, and write refusals. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts`, `node.ts`, `testing.ts` | Public and test entries. |
| `src/device/` | `openDevice`: the contract client, its Bun and OPFS stores, the outbox, and `check`/`format`. |
| `src/remote/` | `openRemote`, its wire to the server, and the uploader. |
| `src/browser/` | The legacy IndexedDB repository behind `openFolder`. |
| `src/native/`, `tauri-files.ts`, `directory-store.ts` | Directory storage, watches, bindings, and save locks. |
| `src/shared/` | Markdown reading, rows, and the legacy engine's file content types; its three-way `merge` has no caller outside its own test. |
| `src/git/native-host.ts` | The system `git` runner the CLI's sync verbs use. |
| `src/git/raw-objects.ts` | Git objects for the browser repository. |
| `write.ts` | A guarded put whose lost reply is read back. |
| `src/declaration/`, `declaration.ts`, `directory-documents.ts` | Portable schemas and generic document reads. |
| `evidence/`, `smoke/` | Bundle checks and browser smoke runs. |

## Commands

```sh
bun run typecheck
bun run test
bun test evidence/bundles evidence/closure
```

Each save changes one file; there is no multi-file transaction. Directory
change hints are best effort, and file bytes cross the desktop bridge whole.
