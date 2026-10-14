# tauri-plugin-epicenter-folder

The desktop shell's side of an Epicenter folder: it grants one window a
directory, and makes that window's file changes and runs its `git` under
checks the page cannot get around.

The page opens the folder itself, with `@epicenter/folder`'s engine
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
A shell registers a directory under a scope ID for one window. The page names
the scope and nothing else: it never supplies a root or an author.

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the registry, the cross-process lock, the shared path rule, and the checked file changes and `git` runs. No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: the commands, the run-time capability a grant adds, and which page each `git` run belongs to. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands and types, generated from the plugin into `@epicenter/folder`, whose desktop opener is their only user. Do not edit. |
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
    .plugin(tauri_plugin_fs::init())
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

A shell must also:

- give the window the plugin's commands in a capability:
  `{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }`;
- install `tauri-plugin-fs` and set `plugins.fs.requireLiteralLeadingDot` to
  `false`, so `.git` and other dot files inside the granted root are
  reachable;
- list `DIRECTORY_COMMANDS` in the window's capability with no path, so its
  build checks the names; only a grant gives them a directory. No fs command
  that changes files is listed.

The capability only lets a window call the plugin. Which folder it reaches is
decided by `window` in `ScopeConfig`.

## The grant

The page calls `grant_directory(scope)`. A window other than the scope's is
refused as `WindowNotPermitted`, an unregistered scope as `UnknownScope`. The
first grant:

1. creates the root if it is missing (its parent may be a link a person
   chose; the root itself must be a real directory) and resolves it to its
   canonical path;
2. takes the folder's cross-process lock (`lock.rs`), held until shutdown, or
   answers `Busy` when another process holds it;
3. refuses a `.git`, `.git/epicenter`, or scratch directory linked elsewhere,
   or a `.git` file that points at another Git directory.

The window's first grant then adds a capability for that window alone
(`directory_capability`): the fs plugin's reading commands
(`DIRECTORY_COMMANDS`) on the root and everything beneath it. The fs scope
resolves every existing path, links included, before matching, so a link in
the folder that points outside it is refused. A grant returns
`{ root, branch, authorName, authorEmail }`; a later grant, such as a
reloaded page's, returns the same root.

## File changes

The page changes files through this crate (`write_folder_file`,
`rename_folder_path`, `remove_folder_path`, `make_folder_directory`), not the
fs plugin, because an fs scope matches a path that does not exist yet as
text: under a link that already points elsewhere, a new file's path would look
like the folder's. `page_files.rs` checks the whole path on disk first. It
must be under the granted root with no `.` or `..`, and no existing component
on the way may be a link. Then it must be:

- a data path: any file or directory the shared path rule accepts
  (`paths::path_problem`, the same rule as `pathProblem` in
  `@epicenter/folder`). The rule refuses an alias of `.git` in any segment
  (any case, trailing dots and spaces, ignorable code points, `git~1`),
  `HEAD`, and names that do not survive every desktop file system: a
  trailing dot or space, a Windows device name, a `~digit` short name, a
  reserved or control character. Leading dots are ordinary. The shell keeps
  no list of a folder's files; which data paths a folder has is the page's
  business;
- or, inside `.git` (compared case-insensitively), the engine's staging
  directory `.git/epicenter/scratch` and its files, and the private index
  copies `.git/index.tmp-*`.

A data file is written by staging its bytes in scratch and renaming the
staged copy over it (or linking it, for a new file), so a hard link is
replaced, never written through. A directory is removed only when empty;
nothing removes a tree whole. The page writes no Git object: the engine
stores each with `git hash-object -w`, which names and checks it.

## Git

The page keeps the folder's history with the system `git`, which it asks
this crate to run (`run_git`, stopped by `cancel_git`). `page_git.rs` runs a
command only in a root granted to the calling window, only while that root's
`.git` is its own directory (not a link or a `gitdir:` file), and only when
the arguments are exactly one of the operations the folder engine runs, each
value checked for its kind. Push and fetch reach only the URL
`remote.origin.url` names, and a page may set that only to a network URL
(`https://`, `ssh://`, or `user@host:path`), never a local path, a `file://`
URL, or a `transport::address` helper, so a push cannot write another
repository on the computer. Every command runs with `core.hooksPath` naming an
empty directory only this crate writes, fsmonitor off, without the inherited
variables that point Git elsewhere or trace it, and without a terminal
prompt. `GIT_INDEX_FILE` may name only a private index copy in the root's
`.git`.

A push or fetch may carry one credential, a `Basic` or `Bearer` header value
for exactly the folder's `https` origin
([ADR-0521](../../docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).
Git gets it from its environment as `http.<origin>.extraHeader`, with
redirects off and the credential helper list empty, so the token is in no
argument list and no helper is asked or told. Without one, transfers use the
person's own credential helper or SSH.

A run is named by the page's own request number. The plugin keys it by window,
the page loaded in that webview, and that number (`lifecycle.rs`), so a
reloaded page, or a window created later under the same label, never reaches
the runs of the page before it.

## Shutdown

Every file change and `git` run holds an admission while it runs. When the
app exits, or the shell calls `app.folders().shutdown()`, the plugin refuses
new grants and new work, waits up to ten seconds for work already admitted,
then releases every folder's lock. Pages settle their own work before they
approve a quit; the wait covers a change or a `git` run still in flight when
they did. A late change is refused as `ShuttingDown` and writes nothing.

## What is best effort

- A link another program swaps in between a check and the change that
  follows is not defended against; a page cannot make one.
- The cross-process lock is an exclusive SQLite transaction on
  `.<directory>.epicenter-lock` beside the directory, the same file and
  mechanism the Bun hosts use. The system releases it when the process ends,
  however it ends. It is unreliable on some network filesystems.
- Nothing watches the directory. Pages read again on focus and after their
  own commands; conditional saves turn a stale write into a conflict.
- A compromised page keeps the powers the engine needs: it can move the
  branch, reset the index, and change or delete any data path. Each is
  visible and repairable from the reflog and the remote.
- File bytes cross IPC as JSON number arrays. That is acceptable for
  Markdown and slow for large audio saves.
- Whether this crate builds or runs on Windows has not been checked.

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts
cargo build --offline                     # regenerates permissions/ for the listed commands
```
