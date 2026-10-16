# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: it grants a directory to the
windows registered for it, and makes each window's reads and file changes
under checks the page cannot get around. It runs no `git`: the folder's
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
| `core/` | `epicenter-folder-core`: the registry, the cross-process save lock, the shared path rule, and the checked reads and file changes. No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: the commands, and the watcher that tells a scope's windows what changed (`watcher.rs`). |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `write_folder_file` are not in them (see Reads and File changes). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows. `core/src/paths.rs` and `paths.ts` in `@epicenter/folder` both read it. |
| `fixtures/page-file-changes.json` | Every file change the engine makes in `@epicenter/folder`'s real-Git tests; `page_files.rs` allows each. |

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
per root (see File changes), so a save that carries the hash it read, or a
create, that another window overtook is refused as `Conflict` (or `Exists`)
instead of silently replacing it. An overwrite replaces whatever is there, by
contract. Only a scope's windows change once
it is registered. Two scopes may hold one root, as the Folders window's
`data:<name>` and an app's own scope do; they share the root's mutex.

A shell must also give the window the plugin's commands in a capability:
`{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }`. That
is all the window needs; no fs plugin is installed. The capability only lets
a window call the plugin. Which folders it reaches is decided by `windows` in
`ScopeConfig` and by `permit`.

## The grant

The page calls `grant_directory(scope)`. A window the scope does not name is
refused as `WindowNotPermitted`, an unregistered scope as `UnknownScope`. The
first grant, from whichever of the scope's windows asks first:

1. creates the root if it is missing and the folder is an application's
   (a missing data folder's root is refused `Missing`); its parent may be a
   link a person chose, and the root itself must be a real directory. It
   resolves the root to its canonical path;
2. refuses Git state that would send writes elsewhere (`root::verify_layout`):
   `.git` as a link or a file that points at another Git directory, a
   `.git/commondir` file, a link at or inside `.git/objects` (one level),
   `.git/refs`, or `.git/logs`, and a linked `.git/epicenter` or scratch
   directory.

A grant returns `{ root }`. A later grant, such as a reloaded page's or
another window's, returns the same root. Nothing keeps out a second scope on
the root or a second Epicenter process: each save takes the folder's save
lock, which every writer shares
([ADR-0568](../../docs/adr/0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md)).
The `epicenter` CLI refuses a data folder's first `git init` inside another
repository's working tree whatever the page asks. The grant adds nothing to
the app's access control: the window reaches the folder only through this
plugin's commands, each of which looks up the root the scope was granted.

## Reads

The page reads through this crate: `read_folder_directory` lists a
directory as `{ name, kind }` entries, `stat_folder_path` describes a path
as `{ kind, size, mode }` or `null` when nothing is there, and
`read_folder_file` returns a file's bytes. A kind is `file`, `directory`,
`link`, or `other`. `page_reads.rs` checks the path on disk first: it must be
the granted root or beneath it, with no `.` or `..`, and no existing
component on the way to it may be a link. The final component may be one:
listing and describing report it as `link` and never follow it, and reading
a file or listing a directory through it is refused. A read may reach
anything under the root, `.git` and other dot files included. A name that is
not text is left out of a listing. `mode` is the Unix mode, file type bits
included, and `null` on Windows.

`read_folder_file` returns the bytes as a raw response, an `ArrayBuffer` to
the page, rather than as a JSON array of numbers. The generated bindings
cannot type a raw response, so the command is left out of them; the plugin
dispatches it beside the typed commands, under the same permission, and
`directory-tauri.ts` invokes it by name.

## File changes

The page changes files through this crate (`write_folder_file`,
`rename_folder_path`, `remove_folder_path`, `make_folder_directory`).
`page_files.rs` checks the whole path on disk first. It must be under the
granted root with no `.` or `..`, and no existing component on the way may
be a link. Then it must be:

- a data path: any file or directory the shared path rule accepts
  (`paths::path_problem`, the same rule as `pathProblem` in
  `@epicenter/folder`). The rule refuses an alias of `.git` in any segment
  (any case, trailing dots and spaces, ignorable code points, `git~1`),
  `HEAD`, and names that do not survive every desktop file system: a
  trailing dot or space, a Windows device name, a Windows short name such as `GIT~1`, a
  reserved or control character. Leading dots are ordinary. The shell keeps
  no list of a folder's files; which data paths a folder has is the page's
  business;
- or, inside `.git` (compared case-insensitively), the engine's staging
  directory `.git/epicenter/scratch` and its files, and the private index
  copies `.git/index.tmp-*`.

A folder has no repository until its first commit, Sync or Save version
([ADR-0535](../../docs/adr/0535-an-existing-folder-opens-with-its-own-declaration.md)),
but its first save stages in `.git/epicenter/scratch` before that. So
`make_folder_directory` makes `.git` itself on the way to scratch when `.git`
is absent, which is exactly when no repository exists; `git init` later fills
in the same directory. `.git` is never a change's target, and nothing else in
it becomes reachable, with or without `HEAD`.

`write_folder_file` writes only a new staged file or index copy, and only
with `create-new`, so nothing already at the path, such as a hard link another
program planted, is written through. The engine never writes a data file in
place: it writes a staged copy and renames it over the path
(`rename_folder_path`), which replaces a hard link rather than writing
through it. The one data file written in place is a recording, by
`tauri-plugin-epicenter-recorder`
([ADR-0543](../../docs/adr/0543-a-recording-streams-into-its-folder-from-the-moment-it-starts.md)).
It asks `app.folders().granted_root(scope, window)` for the window's root,
checks the path with `page_files::data_path` (the same rule and link check
as a change), and creates the file with `create_new`. A directory is removed only when empty; nothing removes a tree
whole.

`rename_folder_path` and `remove_folder_path` also take `expected`, what the
page expects at the path it changes: `"absent"` (a new file or a move's
destination), `"present"` (a file, whatever its bytes), `{ "sha256": "<hex>" }` (a
file whose bytes hash to that lowercase SHA-256), or `"any"` (an overwrite,
the folder's declaration, a staged file). An incoming Sync write carries the
hash of the file it replaces, or `"absent"`. The plugin checks the path and
then renames or removes it while holding one mutex per canonical root, kept
in the registry and shared by every window and scope of the folder, and the
folder's save lock, an exclusive SQLite
transaction on `.<directory>.epicenter-save-lock` beside it (`lock.rs`). A
Bun process opening the same directory (`@epicenter/folder/bun`, and so the
`epicenter` CLI) takes the same save lock around each of its own checks and
renames, as does any other Epicenter shell, so no other change through the
plugin or the Bun host lands between the check and the change
([ADR-0562](../../docs/adr/0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md)).
The save lock is held for nothing else. A change waits up to ten seconds for
another process's; past that it changes nothing and is `Failed`, naming the
lock file. The cost is a read and hash of the destination when `expected`
names a hash. A path that holds something else changes nothing and is
refused as a `ChangeError` the page tells apart: `Conflict` with
`actualSha256` (the hash of the file there, or `null` when none is),
`Exists`, or `NotFound`. Every other refusal or failure is `Failed` with its
message. A refused rename leaves its staged source for the page to remove.

`write_folder_file` takes the file's bytes as the request's raw body, so
content crosses IPC as it is rather than as a JSON array of numbers. Its arguments are headers, each percent-encoded:
`scope`, `path`, and `create-new` (`true` or `false`). A JSON array of bytes,
Tauri's `postMessage` fallback, is accepted too.
The generated bindings cannot type a raw request, so the command is left out
of them; the plugin dispatches it beside the typed commands, under the same
permission, and `directory-tauri.ts` invokes it by name. The page writes no Git object: the `epicenter` CLI
stores each with `git hash-object -w`, which names and checks it.

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
checked again before each operation) live in the CLI's runner,
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
| `.git` itself, `.git/HEAD`, `.git/packed-refs`, or a ref under `.git/refs/` | `".git"`: history moved |
| Anything else in `.git`: objects, the index, logs, lock files, `.git/epicenter/scratch`, `.git/index.tmp-*` | Nothing is reported |
| Watching began, the operating system dropped events or asked for a rescan (notify's `Flag::Rescan`, FSEvents' `MustScanSubDirs`), a watch error arrived, the root itself changed, or the computer woke from sleep | `null`: anything may have changed |

A sleep is noticed by a clock thread that reads the wall clock every 5
seconds: a jump of more than 30 seconds past that, or a step backward, reports
`null` for every watched scope. A clock set by hand reads the same and costs
one reread. Reading a file is not a change. The watch never follows a link and
keeps no file ID cache, so nothing outside the root is watched or read, and an
event naming a path outside the root is ignored.

The event carries no content: a window rereads through the plugin's reads. A
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

Every file change holds an admission while it runs; a read
holds none. When the app exits, or the shell calls
`app.folders().shutdown()`, the plugin refuses new grants, reads, and work,
and stops watching. It waits for nothing: quitting is
immediate ([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Every save is an atomic rename, so a change cut off at exit leaves the old
file or the new one. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the read or change
  that follows is not defended against; a page cannot make one.
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
