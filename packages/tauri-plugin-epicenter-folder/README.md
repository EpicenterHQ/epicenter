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
It names no root, scope, or window: every command answers in the directory
bound to the calling WebView's label
([ADR-0647](../../docs/adr/0647-a-native-window-edits-one-directory-bound-before-it-exists.md)).

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the canonical directory value (`directory.rs`), the cross-process save lock, the shared path rule, and the page's storage (`storage.rs`). No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: window bindings (`folders.rs`), shared window construction (`windows.rs`), and storage commands. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `put_folder_file` are not in them (see Storage). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows. `core/src/paths.rs` and `paths.ts` in `@epicenter/folder` both read it. |
| `fixtures/storage-outcomes.json` | Storage calls and what each answers. `core/src/storage_tests.rs` runs them over the shell's storage and `storage-outcomes.test.ts` in `@epicenter/folder` over the Bun directory storage, so both give the same outcomes. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Binding a window's folder

Install the plugin once. A shell decides which directory a window edits in
trusted Rust and resolves it. The shared opener chooses its identity and binds
the directory before building the WebView:

```rust
use tauri::{Manager, WebviewUrl};
use tauri_plugin_epicenter_folder::{Directory, FolderExt};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        // A fixed default the shell computes: made when it is missing.
        let directory = Directory::create(&app.path().app_data_dir()?)?;
        app.open_folder_window("todos", directory, WebviewUrl::default(), |builder| {
            Ok(builder.title("Todos"))
        })?;
        Ok(())
    })
```

`Directory::create(path)` prepares a fixed default computed by the shell,
creating it when missing and retaining its canonical root.
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
one window per application key and canonical root. Both standalone Todos and
Epicenter supply `"todos"`; the plugin computes `todos:<digest>` internally.
Opening the same pair reveals its existing window without configuring it
again. Different apps can open the same root in separate windows. Labels are
local to a Tauri runtime, so standalone and hosted windows do not collide.
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
directory. Every participating writer takes the folder's save lock across
its expectation check and change (see Storage). A save that another writer
overtook is answered `stale`; the page reads again and merges. Native windows,
other Epicenter processes, and Bun writers use the same lock
([ADR-0568](../../docs/adr/0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md)).

A shell must also give the window the plugin's commands in a capability:
`{ "windows": ["todos:*"], "permissions": ["epicenter-folder:default"] }`.
That is all the window needs; no fs plugin is installed. The capability only
lets a window call the plugin. Which directory it reaches is its binding.

## Opening

The page calls `open_folder()`, with no arguments. A window with no binding
is refused `NotBound`, a bound directory that is gone `Missing`, and one that
cannot be inspected `Unavailable`; nothing is made again here, since making a
default belongs to the shell's launch. After shutdown the answer is
`ShuttingDown`. Opening starts no watcher or background worker.

Every open also removes the staged files in `.<directory>.epicenter-scratch`
beside the root that a stopped save left more than an hour ago
(`storage::sweep_scratch`), by the creation time in the name the stager gave
it, the same rule as `isStaleScratch` in `@epicenter/folder`. Younger ones
may belong to a save still running in another process. Only regular files
with a name a stager made are removed: any other file, a directory, or a link
stays, and a scratch path that is a link or not a directory is not read.
Files an older shell staged in `.git/epicenter/scratch` are left as they are.

Each command clones the window's `Directory` when it arrives and works in
that root until it ends. A window closed and replaced under the same label
meanwhile cannot redirect work already admitted.

## Storage

A page's folder storage (`FolderStorage` in `@epicenter/folder`'s
`boundary.ts`) is these commands, one per method, each one IPC call
([ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)):

| Method | Command | Answers |
| --- | --- | --- |
| `list()` | `list_folder()` | `{ files: { path, size }[], directories: string[] }` |
| `children(directory)` | `read_folder_children(directory)` | `{ files: string[], directories: string[] }`; `""` is the root |
| `read(path)` | `read_folder_file(path)` | the bytes, raw |
| `put(path, bytes, ifMatch)` | `put_folder_file`, raw body and headers | `"landed"` or `"stale"` |
| `mkdir(path)` | `make_folder_directory(path)` | `null` |
| `rmdir(path)` | `remove_folder_directory(path)` | `null` |

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
  entry: a read or `read_folder_children` finds nothing there (`NotFound`),
  and a put or `make_folder_directory` is `InvalidPath`. On macOS and
  Windows the stored spelling comes from resolving the path; elsewhere from
  listing each parent.
- A file where a directory should be is `NotADirectory` naming it, and a
  directory where a file should be is `NotAFile`.

A refusal or a failure is a `StorageError`, named and shaped as the page's
`FileError`: `InvalidPath`, `NotFound`, `NotAFile`, `NotADirectory`,
`DirectoryNotEmpty`, or `Io` with the operation and the system's message. A
failure the shell reports changed nothing. Only the page can tell that a
reply was lost, which it reports as `Unconfirmed`.

### A put

`put_folder_file` publishes a file's bytes at a path, or removes its file,
only while the path holds what the page expects. It takes the bytes as the
request's raw body, so content crosses IPC as it is rather than as a JSON
array of numbers. Its arguments are headers, each percent-encoded: `path`,
`remove` (`true` to remove the file, when the body is ignored), and
`if-match`, the lowercase SHA-256 of the file the page expects there, left
out when it expects no file. A JSON array of bytes, Tauri's `postMessage`
fallback, is accepted too. The generated bindings cannot type a raw request,
so the command is left out of them; the plugin dispatches it beside the
typed commands, under the same permission, and `tauri-files.ts` invokes it
by name. `read_folder_file` returns its bytes as a raw response, an
`ArrayBuffer` to the page, for the same reason the same way.

A put of bytes writes the bytes to a new file in
`.<directory>.epicenter-scratch` beside the root, the directory the Bun host
stages in (opened with `create_new`, so nothing already there is written
through). A scratch path that is a link or not a directory refuses the put as
`Io`, and nothing changes. On Unix the scratch directory is `0700` before
anything is staged in it: made so, or tightened through the opened directory
when an older shell left it `0755`, and a put that cannot make it so is `Io`.
Each staged file is `0600` before its first byte, so no other account reads
a save that has not landed or one that stopped. On macOS an access control
entry lets other accounts past those bits, and a parent can pass one on
(`everyone allow read`), so the scratch directory and each staged file have
every entry removed through the open descriptor before anything is staged or
written; a put that cannot remove them is `Io`. An open's sweep removes them
from an existing scratch directory too. Replacing a file keeps its
permission bits; a new file is `0600`. Windows has no such bits: there the
scratch directory has the access its parent passes on. The scratch
directory is on the parent's file
system, so a root that is itself a mount point cannot be saved to: its
rename fails as `Io` and the file at the path stays. Then the put takes the
folder's save lock, an exclusive SQLite transaction on
`.<directory>.epicenter-save-lock` beside it (`lock.rs`). Holding the turn,
it walks the path again (no link, every name stored as asked), checks what
the path holds, and only then makes the path's missing parent directories
and renames the staged file over it. A removal takes the turn, walks and
checks, and removes. `remove_folder_directory` takes the same turn across
its check and removal; `make_folder_directory` takes none. A Bun process
opening the same directory (`@epicenter/folder/bun`, and so the `epicenter`
CLI) takes the same save lock around each of its own checks and renames, as
does any other Epicenter shell, so no other save through the plugin or the
Bun host lands between the check and the change
([ADR-0562](../../docs/adr/0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md)).
A directory another writer pruned while the put waited is made again under
the turn; the root itself never is. A put waits up to ten seconds for
another writer's save; past that it changes nothing and is `Io`, naming the
lock file. The cost is a read and hash of the destination when `if-match`
names a hash. A path that holds something else changes nothing and answers
`"stale"`. On every answer but `"landed"` the put leaves nothing behind: not
its staged file, and not a directory it made, unless another writer put
something in it.

A folder has no repository until its first commit, Sync or Save version
([ADR-0535](../../docs/adr/0535-an-existing-folder-opens-with-its-own-declaration.md)),
and saving never makes one: a put stages beside the root, so it makes
nothing in the root but the files saved and their directories, and nothing in
`.git` is reachable, with or without `HEAD` (`page_files.rs`).

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

### Not a cross-version contract

These commands are a contract between a shell and the pages it ships or
installs, not across versions. A shell update may change them, and an
installed app built for the old ones is rebuilt; no command set is kept for
an older page.

## Git

The `epicenter` CLI owns Git operations over an explicit directory. This
plugin offers file storage; the current page capabilities grant no native
history command. Git's checks live in the CLI's runner,
`packages/folder/src/git/native-host.ts`.

## Changes outside the page

The plugin stores files and binds directories to windows. It keeps no watchers,
change-event channel, or wake clock. The shared TypeScript folder context
(`@epicenter/svelte/folder`) rereads active queries while their document is
visible, with a delay proportional to the cost of the preceding read batch.
Own writes still report precise paths inside the page's Folder engine.
Other windows' and programs' edits appear on the next query refresh. A native
Folder handle's `onChange` alone does not observe external programs.

## Shutdown

Every put and directory change holds a clone of its window's directory while
it runs; a read holds one too. When the app exits, or the shell calls
`app.folders().shutdown()`, the plugin refuses new binds, opens, reads, and
work. It waits for nothing: quitting is
immediate ([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Every save is an atomic rename, so a change cut off at exit leaves the old
file or the new one. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the read or change
  that follows is not defended against; a page cannot make one. A put
  checks the path for links again under the save lock.
- The save lock is an exclusive SQLite transaction on
  `.<directory>.epicenter-save-lock` beside the directory. The system
  releases it when the process ends, however it ends (`fcntl`, through
  SQLite). It is unreliable on some network filesystems.
- The expectation is checked under the folder's save lock. A program that
  takes no lock and changes a path between that check and the rename is not
  seen. Two windows bound to nested roots, one inside the other, take
  different save locks.
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
