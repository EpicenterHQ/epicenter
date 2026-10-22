# 0678. App storage openers use runtime-bound scopes

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [ADR-0673](0673-a-sqlite-handle-owns-one-connection-until-asynchronous-disposal.md) proposes persistent database handles, SQL operations, and asynchronous connection disposal.
- **Unbuilt:** Production `openDeviceStorage`, shared native app-to-device-storage bindings, production browser device files and SQLite over OPFS, raw-access coordination, cross-tab contention handling, and parent-handle cleanup; implementations remain fictional-data prototypes. The existing `openFolder` already uses the browser origin or native window binding.

## Context

Apps currently call `openFolder({ tables })`. The browser opens
`epicenter.folder.default` in IndexedDB; the desktop opens the directory
bound to the calling window. Neither app call supplies an app identifier,
account, remote, or native path. Bun tools instead supply an explicit
`directory`. These behaviors are implemented in
[`packages/folder`](../../packages/folder/README.md).

Device-local files and SQLite need a stable app scope too. Requiring every
page to pass its app identifier would repeat a choice the native shell already
makes when launching that app. Deriving device storage from the selected Folder
would instead give one app different preferences and caches whenever it opens
another directory, while different apps editing that directory would share
their device state.

## Decision

**Ordinary app code opens its runtime-bound Folder and device storage without
supplying an identifier.**

`openFolder({ tables })` keeps its name and existing selection rules.
`Folder` names rooted paths and contents, including table interpretations;
`authored` describes the intended use rather than a second resource type.
The proposed `openDeviceStorage()` opens this app's device-local storage.
Neither opener selects storage from an account, Git remote, display title,
or caller-supplied app identifier.

The two bindings remain independent:

| Binding | Browser | Native app |
| --- | --- | --- |
| Folder | This origin's existing default IndexedDB folder | The existing directory bound to the calling window |
| Device storage | This origin's device-local storage, backed by OPFS for files and SQLite | An app-scoped location beneath the shell's configured AppData root |

The browser model assumes one ordinary app per origin. Different URL paths
do not establish different app scopes. Several same-origin apps would require
an explicit new selection and isolation design, rather than inferring identity
from the current route. Browser scope also depends on the browser profile and
storage partition; it does not identify a physical device or person.

The native shell binds a stable logical app identifier before exposing device
storage to a page. A standalone shell supplies it from its app configuration;
Epicenter supplies it from the app it launches. Standalone and hosted versions
of the same app resolve the same device scope in the same storage environment.
The shell's own bundle identifier, a window instance, and the chosen Folder
path do not substitute for that app identifier. Missing bindings refuse opening
rather than selecting shared or browser storage. Tools outside an app runtime
must supply the scope or directory explicitly at their composition boundary.
Identity is bound once, not rediscovered from names on each operation.

**Device file access and SQLite opening address the same rooted file namespace.**

The proposed device handle offers `files` for ordinary relative-path file
operations and `openSqlite(path)` for database connections. The path
`search.sqlite` names the same file through both capabilities. The runtime
applies the app binding to both; a relative path selects a file within that
root, not another app or an arbitrary native path. Native SQLite uses native
storage; browser SQLite uses a filesystem-transparent OPFS implementation.
SQLite need not run through the whole-file `files.read` and `files.write`
operations to address those same files.

Paths are relative to the admitted root. Absolute paths, traversal outside that
root, and native aliases escaping it are refused by the backend. An app can name
account databases such as `messages-demo-a.sqlite` or arrange subdirectories;
the account does not select the app's scope. The scratch file prototype accepts
only one filename; subdirectory admission is not established by its tests.

Raw reads, writes, replacements, and deletion of a database or its SQLite
journal companions require every connection to be closed and competing access
excluded for the operation's duration. Closing one tab's connection does not
establish exclusivity if another tab or process still has the file open. The
raw file API does not establish this quiescence by virtue of returning bytes.

After a crash, SQLite must recover any hot journal or WAL before a standalone
main-file copy is treated as complete. A live consistent snapshot is a
database-aware operation outside this initial API; raw byte reads are not
backups. See [SQLite's file-access guidance](https://sqlite.org/howtocorrupt.html).

A fictional-data [official OPFS prototype](../../packages/folder/evidence/device-opfs/NOTES.md)
observes this shared namespace in a browser. With the `opfs` adapter of
`@sqlite.org/sqlite-wasm` 3.54.1-build1, SQLite creates the literal
`search.sqlite`. After its connection closes, file access reads the database
bytes, and another tab writes a copy and opens that copy as a database.
Headless Chromium, Firefox, and Playwright WebKit on macOS also complete two
tabs' concurrent atomic batches against one file and keep the last committed
value after an orderly page close mid-transaction. The adapter needs a
cross-origin-isolated page; without COOP and COEP headers the prototype refuses
to open rather than falling back to other storage.

This is feasibility evidence, not production behavior. Forced contention
exceeded application retry budgets, failing after about 31.7 s in Chromium and
Firefox and 4.5 s in WebKit with different SQLite errors. Each engine also
returned bytes from a raw read of a database copy held in an exclusive
transaction, so browser enforcement does not supply the quiescence required
above. The prototype's cooperating main-file Web Lock lease refused raw access
while any tab held a connection. It does not protect sidecars, native clients,
or OPFS callers that bypass it. Forced renderer or browser termination, mobile
browsers, and origin retention were not tested.

**A device handle owns the connections it opens and supports asynchronous disposal.**

`device.openSqlite(path)` returns the persistent database handle defined in
ADR-0673. Opening the same path again creates an independent connection to the
same file. Closing one connection does not close another connection or remove
the file.

`device.close()` refuses new file operations and database opens, closes that
handle's database connections, and releases its resources. An admitted open
cannot publish a usable connection after closing begins: it fails or its
connection is closed before device cleanup completes. Other device handles,
tabs, windows, and CLI connections remain independent. Closing removes no files.

`device[Symbol.asyncDispose]()` invokes the same cleanup as `device.close()`.
Repeated calls await the same cleanup outcome. The session owner stops and
awaits its application work before closing; cleanup does not promise to cancel
or drain unawaited SQL or file operations. Every child close is attempted even
if another fails, and cleanup failures remain observable. Per-connection
`close` and disposal follow ADR-0673.

These examples are proposed API calls with opening errors abbreviated:

```ts
async function inspectFictionalMessages() {
  await using device = await openDeviceStorage();
  await using db = await device.openSqlite('messages-demo-a.sqlite');
  return await db.all('SELECT id, text FROM fictional_messages LIMIT 50');
}
```

A long-lived UI session keeps `device` and its connections until teardown;
closing the device after awaiting its work closes the remaining connections.
The authored Folder stays independent:

```ts
const folder = await openFolder({ tables });
const device = await openDeviceStorage();
const db = await device.openSqlite('messages-demo-a.sqlite');
```

Folder selection does not select the device root, and `Folder` gains no SQLite
method. No second top-level app-facing `openSqlite({ account })` is introduced.
Package placement is independent of these resource lifetimes.

## Consequences

Pages stop repeating app identifiers, native paths, and browser storage choices
at file and database call sites. The runtime must still establish a stable
binding; removing an argument does not remove identity. A native app may open
several Folders while retaining its device-local preferences and caches.

The app-facing distinction is Folder versus device storage. Public access,
sharing, and Git synchronization remain policies independent of either name.
Device-local state can contain durable recovery information and is not
automatically disposable cache. Credentials remain a separate capability.

The existing browser Folder database name and stored bytes stay unchanged.
Native path allocation must select a shared app scope without reusing old
installed-app clones under AppData. Device-storage paths, creation policy,
initialization, retention, raw-access coordination across tabs and native CLI
processes, browser contention deadlines, cross-origin isolation, and cleanup
must be specified and verified before the new opener ships. A refused open does
not select another path, device scope, or storage engine. No database
initialization or migration runner is added to the shared handle; apps own
their schemas.

## Considered alternatives

- **Require an app ID on both openers.** Repeats runtime identity in page code
  and incorrectly associates a portable Folder with one app owner.
- **Derive device storage from the Folder.** Couples app-local state to a
  movable directory and shares it across unrelated apps opening that directory.
- **Infer app identity from the Tauri bundle ID or browser URL path.** The
  desktop host serves several apps, and browser paths share origin storage.
- **Rename `openFolder` to `openAuthoredStorage` or `openStorage`.** Adds an
  abstract name without changing its rooted-file behavior; the latter also
  hides the distinction from device storage.
- **Keep databases in a separate managed namespace.** Hides the expected
  relationship between `files` and `openSqlite` and requires a separate byte
  import/export path even when all connections are cleanly closed.
- **Use a pooled OPFS adapter with private filename mappings.** Does not meet
  the shared-path contract. The prototype shows the official transparent OPFS
  adapter meeting that contract without a custom VFS; its concurrency and
  deployment requirements still need production decisions.
- **A SQLite method on the authored `Folder`.** Changes the selected data
  folder's authority and needs a database backing beyond the browser's existing
  IndexedDB Git-object engine.
