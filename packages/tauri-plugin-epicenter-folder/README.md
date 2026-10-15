# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: it grants one window a
directory, and makes that window's reads and file changes and runs its `git`
under checks the page cannot get around.

The page opens the folder itself, with `@epicenter/folder`'s engine
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
A shell registers a directory under a scope ID for one window. The page names
the scope and nothing else: it never supplies a root or an author.

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the registry, the cross-process lock, the shared path rule, and the checked reads, file changes, and `git` runs. No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: the commands and the `git` runs each window's page started. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. `read_folder_file` and `write_folder_file` are not in them (see Reads and File changes). Do not edit. |
| `fixtures/path-rules.json` | The paths the shared path rule refuses and allows. `core/src/paths.rs` and `paths.ts` in `@epicenter/folder` both read it. |
| `fixtures/page-file-changes.json` | Every file change the engine makes in `@epicenter/folder`'s real-Git tests; `page_files.rs` allows each. |
| `fixtures/page-git-calls.json` | Every `git` call the engine makes in the same tests; `page_git.rs` allows each. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Registering folders in a shell

Install the plugin once. Register each folder from trusted Rust code after the
shell has resolved its paths, which is in `setup`, not before:

```rust
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let todos = resolve_todos_directory(app)?;
        app.folders().register(ScopeConfig {
            scope: "so.epicenter.todos".into(),
            folder: FolderConfig::new(
                todos,
                Author { name: "Todos".into(), email: "todos@localhost".into() },
            ),
            window: "todos".into(),
        })?;
        Ok(())
    })
```

`FolderConfig` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `root` | required | The folder's directory. The first grant creates it if it is missing. |
| `author` | required | The fallback for whichever of `user.name` and `user.email` Git's configuration does not set. |
| `branch` | `main` | The local branch history is recorded on. |

Everything else, the remote included, is the repository's: the page's engine
reads it from Git's configuration.

A scope belongs to exactly one window: one live editor per folder. A scope's
configuration cannot change once registered. Two scopes cannot hold one root
at once, since the second cannot take its lock.

A shell must also give the window the plugin's commands in a capability:
`{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }`. That
is all the window needs; no fs plugin is installed. The capability only lets
a window call the plugin. Which folder it reaches is decided by `window` in
`ScopeConfig`.

## The grant

The page calls `grant_directory(scope)`. A window other than the scope's is
refused as `WindowNotPermitted`, an unregistered scope as `UnknownScope`. The
first grant:

1. creates the root if it is missing (its parent may be a link a person
   chose; the root itself must be a real directory) and resolves it to its
   canonical path, a plain drive path on Windows rather than a `\\?\` one;
2. takes the folder's cross-process lock (`lock.rs`), held until shutdown, or
   answers `Busy` when another process holds it;
3. refuses Git state that would send writes elsewhere (`root::verify_layout`):
   `.git` as a link or a file that points at another Git directory, a
   `.git/commondir` file, a link at or inside `.git/objects` (one level),
   `.git/refs`, or `.git/logs`, and a linked `.git/epicenter` or scratch
   directory.

A grant returns `{ root, branch, authorName, authorEmail }`; a later grant,
such as a reloaded page's, returns the same root. It adds nothing to the
app's access control: the window reaches the folder only through this
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

`write_folder_file` writes only a new staged file or index copy, and only
with `create-new`, so nothing already at the path, such as a hard link another
program planted, is written through. A data file is never written in place:
the engine writes a staged copy and renames it over the path
(`rename_folder_path`), which replaces a hard link rather than writing
through it. A directory is removed only when empty; nothing removes a tree
whole.

`rename_folder_path` and `remove_folder_path` also take `expected`, what the
page expects at the path it changes: `"absent"` (a new file or a move's
destination), `"present"` (a file, whatever its bytes), `{ "sha256": "<hex>" }` (a
file whose bytes hash to that lowercase SHA-256), or `"any"` (an overwrite,
the folder's declaration, an incoming Sync write, a staged file). The plugin
checks the path and then renames or removes it while holding one mutex per
canonical root, kept in the registry and shared by every scope and window on
that root, so no other change through the plugin lands between the check and
the change. The cost is a read and hash of the destination when `expected`
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
permission, and `directory-tauri.ts` invokes it by name. The page writes no Git object: the engine stores each with
`git hash-object -w`, which names and checks it.

## Git

The page keeps the folder's history with the system `git`, which it asks
this crate to run (`run_git`, stopped by `cancel_git`). `page_git.rs` runs a
command only in a root granted to the calling window, and only when the
arguments are exactly one of the operations the folder engine runs, each
value checked for its kind. Before every command it checks the root's Git
state again, as the grant did (`root::verify_layout`), since another program
may change `.git` while the folder is open. Push and fetch reach only the URL
`remote.origin.url` names, and a page may set that only to a network URL
(`https://`, `ssh://`, `user@host:path`, or plain `http://` to this
computer's loopback, `127.0.0.1` or `localhost`), never a local path, a
`file://` URL, or a `transport::address` helper, so a push cannot write
another repository on the computer. Every command runs with `core.hooksPath`
naming `.git/epicenter/no-hooks`, which must be a real, empty directory: if
another program put anything there, or a link in its place, every command is
refused until it is removed. Commands also run with fsmonitor off, without
the inherited variables that point Git elsewhere or trace it, and without a
terminal prompt. `GIT_INDEX_FILE` may name only a private index copy directly
in the root's `.git`, compared name by name so either separator counts.

A push or fetch may carry one credential, a `Basic` or `Bearer` header value
for exactly the folder's `https` origin
([ADR-0521](../../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).
Git gets it from its environment as `http.<origin>.extraHeader`, with
redirects off both in general and for that URL by name (a repository's own
`http.<origin>.followRedirects=true` would otherwise win), and the credential
helper list empty, so the token is in no argument list and no helper is asked
or told. Without one, transfers use the person's own credential helper or
SSH.

The page names each run with a random ID (`crypto.randomUUID()`), and the
plugin keys it by window label and that ID (`git_runs.rs`), so no run is
reachable from another window, or from a page with another ID. When a page
starts loading in a window, or the window is destroyed, every run registered
for it belongs to the page before, which is gone: each is cancelled. A
`cancel_git` that arrives before its `run_git` is remembered, and the run is
refused as it starts; a page change forgets those. Cancelling kills `git`
and the helpers it started, such as `git-remote-https`.

## Shutdown

Every file change and `git` run holds an admission while it runs. A read
holds none: it changes nothing, so a quit need not wait for it, and one
asked for after shutdown begins is refused. When the app exits, or the shell
calls `app.folders().shutdown()`, the plugin refuses new grants and new
work, waits up to ten seconds for work already admitted, then releases every
folder's lock. Pages settle their own work before they
approve a quit; the wait covers a change or a `git` run still in flight when
they did. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the read or change
  that follows is not defended against; a page cannot make one.
- The cross-process lock is an exclusive SQLite transaction on
  `.<directory>.epicenter-lock` beside the directory. A Bun script opening
  the same directory (`@epicenter/folder/bun`) does not take it. The system
  releases it when the process ends, however it ends. It is unreliable on
  some network filesystems.
- Nothing watches the directory. Pages read again on focus and after their
  own commands; conditional saves turn a stale write into a conflict.
- The expectation is checked under the root's mutex in this process only. A
  Bun script or another program that changes a path between that check and
  the rename is not seen.
- A compromised page keeps the powers the engine needs: it can move the
  branch, reset the index, and change or delete any data path. Each is
  visible and repairable from the reflog and the remote.
- A file save crosses IPC as a raw body, but `git`'s input and output
  (`run_git`) cross as JSON number arrays, and the engine stores each object
  through that input. That is acceptable for Markdown and slow for
  committing large audio files.
- Whether this crate builds or runs on Windows has not been checked. There,
  cancelling a run kills `git`'s process tree with `taskkill /T`.

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts
cargo build --offline                     # regenerates permissions/ for the listed commands
```
