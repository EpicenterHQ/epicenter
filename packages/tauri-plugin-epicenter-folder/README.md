# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: it grants a directory to the
windows registered for it, and is each window's folder storage, one command
per storage method, under checks the page cannot get around. It runs no `git`: the folder's
history runs in the `epicenter` CLI, which the shell starts for a page over
the root this crate granted
([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).

The page opens the folder itself, with `@epicenter/folder`'s engine
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
A shell registers a directory under a scope ID for the windows that may edit
it. The page names the scope and nothing else: it never supplies a root.

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the registry, the cross-process save lock, the shared path rule, and the page's storage (`storage.rs`). No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: the commands, and the watcher that tells a scope's windows what changed (`watcher.rs`). |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `put_folder_file` are not in them (see Storage). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows. `core/src/paths.rs` and `paths.ts` in `@epicenter/folder` both read it. |
| `fixtures/storage-outcomes.json` | Storage calls and what each answers. `core/src/storage_tests.rs` runs them over the shell's storage and `storage-outcomes.test.ts` in `@epicenter/folder` over the Bun directory storage, so both give the same outcomes. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Registering folders in a shell

Install the plugin once. Register each folder from trusted Rust code after the
shell has resolved its paths, which is in `setup`, not before:

```rust
use tauri_plugin_epicenter_folder::{FolderConfig, FolderExt, ScopeConfig};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let todos = resolve_todos_directory(app)?;
        app.folders().register(ScopeConfig {
            scope: "so.epicenter.todos".into(),
            folder: FolderConfig::new(todos),
            windows: vec!["todos".into()],
        })?;
        Ok(())
    })
```

`windows` must name at least one window. To let another window into a
registered folder later, such as a browser window opening Todos's folder,
call `app.folders().permit("so.epicenter.todos", "browser")`. A permitted
window stays permitted until the app exits.

`FolderConfig` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | The folder's directory. The first grant of an application's folder creates it if it is missing. |
| `kind` | `Application` | `FolderKind::Application` for an application's own folder, made by `FolderConfig::new`. `FolderKind::Data` for a data folder found under the Epicenter root, made by `FolderConfig::data`: its root is never created (a missing one is refused `Missing`). |

Everything else, the remote, the author, and the branch included, is the
repository's: the page's engine and the `epicenter` CLI read it from Git's
configuration, and the CLI supplies its own defaults.

Several windows may edit one scope at once. Each page runs its own engine over
the directory, and the shell checks and publishes every save under one mutex
per root (see Storage), so a save that carries the hash it read, or a
create, that another window overtook is answered `stale` instead of silently
replacing it, and the page reads again and merges. Only a scope's windows change once
it is registered. Two scopes may hold one root, as the Folders window's
`data:<name>` and an app's own scope do; they share the root's mutex.

A shell must also give the window the plugin's commands in a capability:
`{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }`. That
is all the window needs; no fs plugin is installed. The capability only lets
a window call the plugin. Which folders it reaches is decided by `windows` in
`ScopeConfig` and by `permit`.

## Which folder a window opens

A window an app runs opens one folder, which the shell decides. When it
opens the window it calls
`app.folders().hand(label, WindowFolder { app, folder })`, beside `permit`,
and the page asks `window_folder()`: the app's id and the scope of the
folder it was handed, or `null` for a window that runs no app. The page
never reads its folder from its URL, so its navigation and reloads cannot
change or lose it, and it cannot claim another app. `hand` permits nothing.

## The grant

The page calls `grant_directory(scope)`. A window the scope does not name is
refused as `WindowNotPermitted`, an unregistered scope as `UnknownScope`. The
first grant, from whichever of the scope's windows asks first, creates the
root if it is missing and the folder is an application's (a
missing data folder's root is refused `Missing`). Its parent may be a link a
person chose; the root itself must be a real directory. The grant resolves
the root to its canonical path. What `.git` is, if anything, does not matter,
as it does not to the Bun host (`@epicenter/folder/bun`): a directory with no
`.git`, with a `.git` file or link (a linked worktree or submodule), or with a
repository opens and saves alike, and the shell never changes `.git`. Git
state that would send history writes elsewhere is the `epicenter` CLI's to
refuse, before each history operation.

Every grant, the first and each later one, also removes the staged files in
`.<directory>.epicenter-scratch` beside the root that a stopped save left more
than an hour ago (`storage::sweep_scratch`), by the creation time in the name
the stager gave it, the same rule as `isStaleScratch` in `@epicenter/folder`.
Younger ones may belong to a save still running in another process. Only
regular files with a name a stager made are removed: any other file, a
directory, or a link stays, and a scratch path that is a link or not a
directory is not read. Files an older shell staged in `.git/epicenter/scratch`
are left as they are.

A grant returns `{ root }`. A later grant, such as a reloaded page's or
another window's, returns the same root. Nothing keeps out a second scope on
the root or a second Epicenter process: each save takes the folder's save
lock, which every writer shares
([ADR-0568](../../docs/adr/0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md)).
The `epicenter` CLI refuses a data folder's first `git init` inside another
repository's working tree whatever the page asks. The grant adds nothing to
the app's access control: the window reaches the folder only through this
plugin's commands, each of which looks up the root the scope was granted.

## Storage

A page's folder storage (`FolderStorage` in `@epicenter/folder`'s
`boundary.ts`) is these commands, one per method, each one IPC call
([ADR-0581](../../docs/adr/0581-a-desktop-pages-folder-storage-is-one-shell-command-per-storage-method.md)):

| Method | Command | Answers |
| --- | --- | --- |
| `list()` | `list_folder(scope)` | `{ files: { path, size }[], directories: string[] }` |
| `children(directory)` | `read_folder_children(scope, directory)` | `{ files: string[], directories: string[] }`; `""` is the root |
| `read(path)` | `read_folder_file(scope, path)` | the bytes, raw |
| `put(path, bytes, ifMatch)` | `put_folder_file`, raw body and headers | `"landed"` or `"stale"` |
| `mkdir(path)` | `make_folder_directory(scope, path)` | `null` |
| `rmdir(path)` | `remove_folder_directory(scope, path)` | `null` |

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
array of numbers. Its arguments are headers, each percent-encoded: `scope`,
`path`, `remove` (`true` to remove the file, when the body is ignored), and
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
a save that has not landed or one that stopped. Replacing a file keeps its
permission bits; a new file is `0600`. Windows has no such bits: there the
scratch directory has the access its parent passes on. The scratch
directory is on the parent's file
system, so a root that is itself a mount point cannot be saved to: its
rename fails as `Io` and the file at the path stays. Then the put takes the
folder's turn: one mutex per canonical
root, kept in the registry and shared by every window and scope of the
folder, and the folder's save lock, an exclusive SQLite transaction on
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
the turn. A put waits up to ten seconds for another process's save; past
that it changes nothing and is `Io`, naming the lock file. The cost is a
read and hash of the destination when `if-match` names a hash. A path that
holds something else changes nothing and answers `"stale"`. On every answer
but `"landed"` the put leaves nothing behind: not its staged file, and not a
directory it made, unless another writer put something in it.

A folder has no repository until its first commit, Sync or Save version
([ADR-0535](../../docs/adr/0535-an-existing-folder-opens-with-its-own-declaration.md)),
and saving never makes one: a put stages beside the root, so it makes
nothing in the root but the files saved and their directories, and nothing in
`.git` is reachable, with or without `HEAD` (`page_files.rs`).

A data file is never written in place: the rename replaces a hard link
rather than writing through it. The one data file written in place is a
recording, by `tauri-plugin-epicenter-recorder`
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
It asks `app.folders().granted_root(scope, window)` for the window's root,
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

This crate runs no `git`. A page's history (status, the log, Save version,
Sync, and settling a Sync) runs in the `epicenter` CLI, one child per
operation, which the shell starts with fixed arguments over the root a
window was granted
([ADR-0559](../../docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md)).
`Folders::granted_root(scope, window)` names that root, refused for a window
without a grant; the Epicenter shell's `history.rs` reads it.
The Git rules (no hooks, no fsmonitor, a scrubbed environment, a remote that
is a network URL, a credential only for an `https` origin, and Git state
checked before each operation) live in the CLI's runner,
`packages/folder/src/git/native-host.ts`.

## Changes outside the page

From a folder's first grant, by whichever window, the plugin watches its root
([ADR-0548](../../docs/adr/0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)),
until shutdown or exit (`watcher.rs`). It uses notify's recommended watcher,
FSEvents on macOS, and `notify-debouncer-full` with a 50 ms debounce; the full
debouncer passes a rescan through, which the mini debouncer drops. Each batch
is one Tauri event, `epicenter-folder://changed`, emitted to each window
permitted into the scope when the batch is reported, by label, and to no
other window:

```ts
type FolderChanged = { scope: string; paths: string[] | null };
```

| What changed | `paths` |
| --- | --- |
| A path outside `.git` | The path, relative to the root with `/`; each once per batch, sorted |
| Any path inside `.git`, including refs, objects, the index, logs, and an older shell's staged files | Nothing is reported |
| A save's staged file, in the scratch directory beside the root | Nothing is reported; the path it is renamed to is |
| Watching began, the operating system dropped events or asked for a rescan (notify's `Flag::Rescan`, FSEvents' `MustScanSubDirs`), a watch error arrived, the root itself changed, or the computer woke from sleep | `null`: anything may have changed |

A sleep is noticed by a clock thread that reads the wall clock every 5
seconds: a jump of more than 30 seconds past that, or a step backward, reports
`null` for every watched scope. A clock set by hand reads the same and costs
one reread. Reading a file is not a change. The watch never follows a link and
keeps no file ID cache, so nothing outside the root is watched or read, and an
event naming a path outside the root is ignored.

The event carries no content: a window rereads through the plugin's storage. A
missed event costs a delay, never data. The page's own saves are reported too,
which at most rereads a file whose content did not change. `FolderChanged` and
`FOLDER_CHANGED_EVENT` are in the generated bindings as a type and a constant
rather than through tauri-specta's events, which would name the event
`plugin:epicenter-folder:<name>`.

Tauri delivers an event emitted to a label to that window's listeners and to
every listener registered for any target, in any window: a page should listen
with `getCurrentWebviewWindow().listen(...)`, not the global `listen(...)`, or
it hears other windows' folders too. A folder that cannot be watched still
opens; the failure is logged and its windows hear no outside change.

## Shutdown

Every put and directory change holds an admission while it runs; a read
holds none. When the app exits, or the shell calls
`app.folders().shutdown()`, the plugin refuses new grants, reads, and work,
and stops watching. It waits for nothing: quitting is
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
- A change made in the moment between a grant and its watch starting is
  reported only by the `null` that watching begins with, which a page that
  subscribes after its grant does not hear; it already reads after the grant.
  Conditional saves turn a stale write, another window's included, into a
  conflict either way.
- The expectation is checked under the root's mutex and the folder's save
  lock. A program that takes neither, anything but this shell and
  `@epicenter/folder/bun`, and changes a path between that check and the
  rename is not seen.
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
