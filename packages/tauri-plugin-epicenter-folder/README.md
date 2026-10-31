# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: it binds one existing
directory to each window that edits files, before the window exists, and is
that window's folder storage, one command per storage method, under checks
the page cannot get around. It runs no `git`: the folder's history runs in the
`epicenter` CLI, which a shell starts for a page over the directory bound to
its window
([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).

The page opens the folder itself, with `@epicenter/folder`'s engine
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
It names no scope or window: every command answers in the directory bound to
the calling WebView's label
([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)),
or in another root the page opened by its exact path, which Tauri's runtime
file-system scope must allow (see Other roots).

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the canonical directory value (`directory.rs`), the shared path rule, the page's storage (`storage.rs`), and the fixed native defaults (`library.rs`). No Tauri. |
| `src/` | The Tauri plugin: window bindings (`folders.rs`), shared window construction (`windows.rs`), which roots a page may open (`scope.rs`), and storage commands. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `put_folder_file` are not in them (see Storage). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows. `core/src/paths.rs` and `paths.ts` in `@epicenter/folder` both read it. |
| `fixtures/records-default.json` | Where the records default is admitted and refused. `core/src/library.rs` and `records-default.test.ts` in the CLI both run it. |
| `fixtures/storage-outcomes.json` | Storage calls and what each answers. `core/src/storage_tests.rs` runs them over the shell's storage and `storage-outcomes.test.ts` in `@epicenter/folder` over the Bun directory storage, so both give the same outcomes. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Binding a window's folder

Install the folder plugin once alongside `tauri_plugin_dialog::init()`.
The folder plugin uses the dialog plugin for its native confirmation after a
second unanswered window-close request; omitting it makes that path panic.
A shell decides which directory a window edits in
trusted Rust and resolves it. The shared opener chooses its identity and binds
the directory before building the WebView:

```rust
use tauri::{Manager, WebviewUrl};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let directory = Directory::create(&app.path().app_data_dir()?)?;
        app.open_folder_window("notes", directory, WebviewUrl::default(), |builder| {
            Ok(builder.title("Notes"))
        })?;
        Ok(())
    })
```

The apps on [`epicenter-standalone`](../tauri-epicenter-standalone/README.md)
(Capture, Honeycrisp, Todos, Vocab, Whispering) bind their window to their
AppData root this way, and keep their data folder at
`~/Epicenter/<productName>`, allowed in Tauri's file-system scope at startup
(see Other roots). They use neither the library nor `DesktopPaths`, which
are Epicenter's own.

`defaults::DesktopPaths::resolve(app)` resolves Epicenter's machine-local
application data directory and the library root once at startup: release
uses `so.epicenter` and `~/Epicenter`; development uses `so.epicenter.dev`
and `~/Epicenter Dev`. A nonempty absolute `EPICENTER_DATA_DIR` or
`EPICENTER_FOLDER_DIR` overrides either.

`library` (ADR-0672) is the table of fixed native defaults: each
`LibraryDefault` is a permanent reverse-DNS child of the root and a display
title that never names storage. Epicenter's records are its one row.

```txt
<library>/
  so.epicenter/              RECORDS     Epicenter
```

`DesktopPaths::open_default(definition)` computes `<root>/<id>`, admits it,
then creates it when missing or reuses the directory already there with its
files. It reads and writes no configuration and claims no ownership: a
default that was moved or deleted is made again by the next ordinary launch,
and two apps may open one directory. A file or a link at the path is refused
and kept; no alternative name is allocated. Picker-chosen directories and synced
folders opened in an editor bypass the defaults and must exist.

Admission is `library::check_editable_directory` for records: never a
folder's `.epicenter` or anything in one, and never overlapping application
data. `library::check_app_directory`, for ordinary apps, one-time launches,
and folder editor windows, also refuses records, anything in them, and any
directory holding them, such as the root. Overlap compares canonical
paths and directory identity, so a linked parent or another spelling of a
protected directory is no route around it. A root override is admitted before
anything is made. Native and CLI records admission run the same cases from
`fixtures/records-default.json`.

`Directory::create(path)` prepares a fixed default computed by the shell,
creating it and its parents when missing and retaining its canonical root.
`Directory::existing(path)` resolves a directory a person selected without
creating anything: a missing one is `Missing`, a file or a link is
`Unavailable`, and nothing is made. The directory itself must be a real
directory, never a link; its parent may be a link a person chose. What `.git`
is, if anything, does not matter, as it does not to the Bun host
(`@epicenter/folder/bun`): a directory with no `.git`, with a `.git` file or
link (a linked worktree or submodule), or with a repository opens and saves
alike, and the shell never changes `.git`. Git state that would send history
writes elsewhere is the `epicenter` CLI's to refuse, before each history
operation.

`FolderExt::open_folder_window(application, directory, url, configure)` opens
one window per application key and canonical root. A standalone app supplies
its page name (`"todos"`) and Epicenter's editor supplies `"files"`; the plugin computes
`<key>:<digest>` internally.
Opening the same pair reveals its existing window without configuring it
again. Different apps can open the same root in separate windows. Labels are
local to a Tauri runtime, so two apps' windows do not collide.
A digest match alone never grants access: reuse also requires the existing
window's complete directory binding to match.

The opener runs lookup, binding, configuration, and construction on Tauri's
main thread. Call it from setup or a blocking worker, never an async executor
thread. `configure` receives Tauri's actual builder and must preserve that
builder's application and window identity. It may set the title, navigation,
size, or native tab identifier. A configuration or construction failure
releases the binding; a presentation failure retains the live window and its
binding so another open can reveal it. Destruction removes the binding.
Shutdown refuses both new windows and reuse.

`Folders::bind_while_building(label, directory, build)` remains for a
role-based singleton such as Epicenter's Settings window, whose fixed `home`
label and hide-on-close lifetime differ from app-and-folder windows. It binds
before construction and rolls back a failed build; callers own that window's
identity and reuse. Ordinary apps use `open_folder_window`.

Bindings are runtime resources, not a persisted list of folder choices.

Several windows may be bound to one directory, as Settings and a folder
editor are to `so.epicenter`. Each page runs its own engine over the
directory. Each save is checked against the version its page read right
before its rename (see Storage). A save that another writer overtook is
answered `stale`; the page reads again and merges. No lock spans the check
and the rename, so two saves racing in that instant can both land, the later
replacing the earlier; Git history is the backstop
([ADR-0568](../../docs/adr/0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md)).

A shell must also give the window the plugin's commands in a capability:
`{ "windows": ["todos:*"], "permissions": ["epicenter-folder:default"] }`.
That is all a window over its own directory needs; it grants no `fs`
command. The capability only lets a window call the plugin. Which directory
it reaches is its binding, plus any other root Tauri's scope allows it to
open (Other roots).

## Opening

The page's `@epicenter/folder` adapter calls `open_folder` with a private
change channel and, for the window's own directory, no root (or that
directory's path). A window with no binding is refused `NotBound`, a bound
directory that is gone `Missing`, and one that cannot be inspected
`Unavailable`; the window's own directory is never made again here, since
making it belongs to the shell's launch. After shutdown the answer is
`ShuttingDown`. The first successful open of a root starts one recursive
watcher for it; subsequent opens replace its channel while reusing the
watcher. Watch setup failure is `Unavailable`. `open_folder` answers the
root's canonical path, by which the page names it from then on.

### Other roots

A page may open another root by its absolute path (`open_folder({ root,
create })`), the way a standalone app opens its data folder beside its
AppData root. The plugin keeps no grant list of its own: Tauri decides.

1. `Refused { root, reason }` for a place no app keeps its files in
   (`scope::Refusals`): the top of a disk, the home folder, anything inside a
   `.git` folder, anything inside or around Epicenter's own records or
   settings, and anything holding the app's own data directory.
2. `NotGranted { root }` unless Tauri's runtime file-system scope allows
   the path (`tauri-plugin-fs`'s `FsExt::fs_scope`, which a deny wins
   over): a shell allows its app's default folder there at startup, the
   dialog plugin's `open` allows the folder a person picks, and
   `tauri-plugin-persisted-scope` keeps those across launches. No capability
   names a folder, and an app without `tauri-plugin-fs` reaches only its
   windows' own directories.
3. `Missing` when it is not there, unless `create`, which makes it and its
   missing parents.

An opened root stays reachable by its path, and watched, until the window
closes; switching between roots a page opened costs nothing. A storage
command naming a root the page has not opened is `NotGranted`.

`resolve_folder({ root })` answers the canonical path of a root the page
could open, with the same refusals in the same order, and opens, watches and
makes nothing. The folder picker answers the path the person reached, which
may pass through a link (`/tmp` is `/private/tmp` on macOS); the page
remembers the canonical path (`pickDataFolder` in `@epicenter/folder/tauri`),
so a folder is one setting however it was picked.

The page registers one private close channel with `subscribe_close`; it
releases that registration with `unsubscribe_close`. On window close, Rust
sends the request to the page. `<OpenFolder>` waits for `folder.idle()`, then
calls `destroy_bound_window` with its subscription token; Rust destroys only
that window. A second close while the page waits asks natively whether to
close anyway. Keeping the window open lets the first wait finish and close it.
A page reload clears
the old channel and token, so an old page cannot close its successor.

Every open also removes the staged files in the root's `.epicenter/scratch`
that a stopped save left more than an hour ago
(`storage::sweep_scratch`), by the creation time in the name the stager gave
it, the same rule as `isStaleScratch` in `@epicenter/folder`. Younger ones
may belong to a save still running in another process. Only regular files
with a name a stager made are removed: any other file, a directory, or a link
stays, and a scratch path that is a link or not a directory is not read.

Each command clones the window's `Directory` when it arrives and works in
that root until it ends. A window closed and replaced under the same label
meanwhile cannot redirect work already admitted.

## Storage

A page's folder storage (`FolderStorage` in `@epicenter/folder`'s
`boundary.ts`) is these commands, one per method, each one IPC call
([ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)):

| Method | Command | Answers |
| --- | --- | --- |
| `list()` | `list_folder()` | `{ path, stamp }[]`, every file, `.git` and `.epicenter` aside |
| `read(path)` | `read_folder_file(path)` | the stamp, a zero byte, then the file bytes, raw |
| `put(path, bytes, expected)` | `put_folder_file`, raw body and headers | `{ kind: "landed", stamp: string \| null }` or `{ kind: "stale" }` |

A command from a window with no binding, or after shutdown, is `Io` naming
`NotBound` or `ShuttingDown`, and changes nothing.

Paths are folder-relative with `/`, and must pass the shared path rule
(`paths::path_problem`, the same rule as `pathProblem` in
`@epicenter/folder`). The rule refuses an alias of `.git` in any segment (any
case, trailing dots and spaces, ignorable code points, `git~1`), `HEAD`, and
names that do not survive every desktop file system: a trailing dot or
space, a Windows device name, a Windows short name such as `GIT~1`, a
reserved or control character. Leading dots are ordinary. The shell keeps no
list of a folder's files; which data paths a folder has is the page's
business. `.git` at the root is never listed and never named.

`storage.rs` resolves every path literally, with the outcomes of the Bun
directory storage (`directory-store.ts`), held to one vector file both run
(`fixtures/storage-outcomes.json`):

- No link is followed. A path through a link, or naming one, is
  `InvalidPath`; a listing reports a link as a file.
- A name stored under another spelling, which a disk that ignores case or
  Unicode normalization would reach (`plan.md` for `Plan.md`), is another
  entry: a read finds nothing there (`NotFound`), and a put is
  `InvalidPath`. On macOS and
  Windows the stored spelling comes from resolving the path; elsewhere from
  listing each parent.
- A file where a directory should be is `NotADirectory` naming it, and a
  directory where a file should be is `NotAFile`.

A refusal or a failure is a `StorageError`, named and shaped as the page's
`FileError`: `InvalidPath`, `NotFound`, `NotAFile`, `NotADirectory`, or
`Io` with the operation and the system's message. A
failure the shell reports changed nothing. Only the page can tell that a
reply was lost, which it reports as `Unconfirmed`.

### A put

`put_folder_file` publishes a file's bytes at a path, or removes its file,
only while the path holds what the page expects. It takes the bytes as the
request's raw body, so content crosses IPC as it is rather than as a JSON
array of numbers. Its arguments are headers, each percent-encoded: `path`,
`remove` (`true` to remove the file, when the body is ignored), and
`expected`, what the page expects there: `any`, `absent`, `present` (a
regular file, whatever its bytes), or the lowercase SHA-256 of the file
(`storage::Expectation`). `any` is never stale, and removing nothing that may
be absent has landed. A new file must pass the shared path rule; an existing
name only some disks hold may be replaced or removed, never made, so a put of
bytes expecting `any` there lands only while a file is there, checked
right before the rename, and is `InvalidPath` otherwise. `HEAD` is never written.
A JSON array of bytes, Tauri's `postMessage`
fallback, is accepted too. The generated bindings cannot type a raw request,
so the command is left out of them; the plugin dispatches it beside the
typed commands, under the same permission, and `tauri-files.ts` invokes it
by name. `read_folder_file` returns a raw `ArrayBuffer` to the page. Its stamp
is ASCII before the first zero byte; the remaining bytes are the file. The
stamp is formed from size, modification time in nanoseconds, and device and
inode on Unix. Reads inspect the opened file handle so a replacement cannot
pair old bytes with the new file's stamp. A landed put returns the stamp of
the published file, or `null` for a removal. Stamps detect changes;
expectations remain byte hashes.

A put of bytes writes the bytes to a new file in the root's
`.epicenter/scratch`, the directory the Bun host stages in (opened with
`create_new`, so nothing already there is written through). `.epicenter` at
the root is Epicenter's own: no listing shows it, the
watcher reports no change in it, and `epicenter init`'s `.gitignore` keeps
it out of history. A scratch path, or an `.epicenter`, that is a link or not
a directory refuses the put as `Io`, and nothing changes. On Unix the scratch directory is `0700` before
anything is staged in it: made so, or tightened through the opened directory
when it is open to others, and a put that cannot make it so is `Io`.
Each staged file is `0600` before its first byte, so no other account reads
a save that has not landed or one that stopped. On macOS an access control
entry lets other accounts past those bits, and a parent can pass one on
(`everyone allow read`), so the scratch directory and each staged file have
every entry removed through the open descriptor before anything is staged or
written; a put that cannot remove them is `Io`. Replacing a file keeps its
permission bits; a new file is `0600`. Windows has no such bits: there the
scratch directory has the access its parent passes on. The scratch
directory is on the root's own file system, so the rename is one step. Then
the put walks the path again (no link, every name stored as asked), checks
what the path holds, and only then makes the path's missing parent
directories and renames the staged file over it. A removal walks, checks,
and removes. Nothing holds the path between the check and the change, in
the shell or in a Bun process opening the same directory: a save another
writer lands in that instant can be replaced
([ADR-0562](../../docs/adr/0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md)).
A directory another writer pruned while the put staged is made again; the
root itself never is. The cost is a read and hash of the destination when
`expected` names a hash. A path that holds something else changes nothing and answers
`{ kind: "stale" }`. On every answer but `{ kind: "landed", stamp }` the put
leaves nothing behind: not
its staged file, and not a directory it made, unless another writer put
something in it.

A folder has no repository until its first commit, Sync or Save version
([ADR-0535](../../docs/adr/0535-an-existing-folder-opens-with-its-own-declaration.md)),
and saving never makes one: a put stages in `.epicenter`, so it makes
nothing in the root but the files saved, their directories, and
`.epicenter`, nothing beside the root, and nothing in `.git` is reachable, with or without `HEAD` (`page_files.rs`).

A data file is never written in place: the rename replaces a hard link
rather than writing through it. The one data file written in place is a
recording, by `tauri-plugin-epicenter-recorder`
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
It asks `app.folders().bound(window)` for the calling window's directory,
checks the path with `page_files::data_path` (the same rule and link check
as a put), and creates the file with `create_new`. A directory is removed
only when empty; nothing removes a tree whole. The page writes no Git
object: the `epicenter` CLI stores each with `git hash-object -w`, which
names and checks it.

## Git

The `epicenter` CLI owns Git operations over an explicit directory. This
plugin offers file storage; the current page capabilities grant no native
history command. Git's checks live in the CLI's runner,
`packages/folder/src/git/native-host.ts`.

## Changes outside the page

Each root a window opened owns one `notify::RecommendedWatcher` over it,
recursively, without following symbolic links. It sends typed `FolderChanged`
hints to the calling WebView's private channel. Its `paths` are root-relative hints, including
directory hints that cover descendants; `null` means any path may differ.
Rename notifications retain both paths when the operating system supplies them.
Read/open access events and private Git paths are ignored; close-after-write
events remain observations. A native rescan, unknown
scope, or watch error emits `null`; no file is read or hashed by the callback.

`@epicenter/folder/tauri` opens the native watch with its private channel,
then constructs and returns its passive Folder. No reader or cached source
exists before listening, so hints need no startup replay.
The owner rereads sources held by readers or accepted input. An observation,
including an echo of an own write, never acknowledges a save or initiates a
write. Each handle retires its channel on close; the binding releases the
watch on destruction or shutdown, outside the bindings mutex. Native setup also
runs outside that mutex; a candidate remains inactive until installed on the
same binding. Teardown fences in-flight callbacks before reusing a window label.
No resource identifier or filesystem permission is exposed to the page.

Delivery is best effort. Root replacement recovery is unsupported and platform
dependent; neither original-inode retention nor reattachment is guaranteed.
Terminal errors request reconciliation without an autonomous restart guarantee.
No polling fallback or file-content replica is kept here.

## Shutdown

Every put and directory change holds a clone of its window's directory while
it runs; a read holds one too. When the app exits, or the shell calls
`app.folders().shutdown()`, the plugin refuses new binds, opens, reads, and
work. It waits for no admitted storage operation. Watch release fences any
notification currently emitting, without waiting for page reads or saves
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Every save is an atomic rename, so a change cut off at exit leaves the old
file or the new one. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the read or change
  that follows is not defended against; a page cannot make one. A put
  checks the path for links again right before its rename.
- The expectation is checked right before the rename, with no lock between
  them. A writer that changes a path in that instant is not seen, and its
  save can be replaced; Git history keeps what sync committed.
- A compromised page keeps the powers the engine needs: it can move the
  branch, reset the index, and change or delete any data path. Each is
  visible and repairable from the reflog and the remote.
- Epicenter ships for macOS only
  ([ADR-0567](../../docs/adr/0567-epicenter-ships-for-macos-only-for-now.md)).

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts
cargo build --offline                     # regenerates permissions/ for the listed commands
```
