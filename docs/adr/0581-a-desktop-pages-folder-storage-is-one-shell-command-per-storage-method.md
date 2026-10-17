# 0581. A desktop page's folder storage is one shell command per storage method

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md) at its read and change commands (`read_folder_file`, `read_folder_directory`, `stat_folder_path`, `write_folder_file` and its siblings), at "a read may reach anything there, `.git` included", at a change inside `.git` being "the engine's staging files and private index copies", at a publish carrying "nothing, a file, a file with a given SHA-256, or anything", and at the desktop page's file storage being "a directory handle built on seven calls": the page names data paths only, and the shell stages, checks, and publishes each put itself.
- **Amended by:** [ADR-0586](0586-you-open-a-folder-never-an-app.md) at each command's `scope` argument: it is a folder's directory name.
- **Relates:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) defines the storage port these commands answer; [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) and [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) define the save lock a put takes.

## Context

A desktop page's folder storage was `createDirectoryStorage` in
`directory-store.ts` over `tauriDirectoryPrimitives` in `directory-tauri.ts`:
seven file calls, each a folder plugin command over absolute paths
(`read_folder_directory`, `stat_folder_path`, `read_folder_file`,
`write_folder_file`, `rename_folder_path`, `remove_folder_path`,
`make_folder_directory`). `stat_folder_path` answered no stored spelling, so
the store's literal-name walk (`find`) listed each parent of a path to tell
`todos/a.md` from `Todos/a.md` on a case-insensitive disk. A read of a file
`d` directories deep cost `2d + 1` calls, a put `2d + 3` or `2d + 4`, and
reading every file of one directory sent each file's whole parent listing
across IPC once per file. `openDirectoryFolder` also swept stale staged
files through the same calls.

The commands were only ever called by `@epicenter/folder`, which the shell
ships or an installed app bundles at a version built for that shell.

## Decision

**A desktop page's storage is the folder plugin answering each method of
`FolderStorage` (`packages/folder/src/boundary.ts`) with one command.** The
page builds it as `hostStorage(tauriHostFiles(scope))`
(`packages/folder/src/tauri-files.ts`); the shell's side is
`packages/tauri-plugin-epicenter-folder/core/src/storage.rs`:

| `FolderStorage` | Command | IPC calls |
| --- | --- | --- |
| `list()` | `list_folder(scope)` | 1 |
| `children(directory)` | `read_folder_children(scope, directory)` | 1 |
| `read(path)` | `read_folder_file(scope, path)`, raw bytes back | 1 |
| `put(path, bytes, ifMatch)` | `put_folder_file`, raw body; headers `scope`, `path`, `remove`, `if-match` | 1 |
| `mkdir(path)` | `make_folder_directory(scope, path)` | 1 |
| `rmdir(path)` | `remove_folder_directory(scope, path)` | 1 |

Paths are folder-relative and pass `path_problem`; the page never names
`.git` or the root. `storage.rs` gives the outcomes the Bun directory
storage gives: a path through or naming a link is `InvalidPath`, a name
stored under another spelling is absent to a read and `InvalidPath` to a
change, and a refusal is a `StorageError` named as the page's `FileError`.
`put_folder_file` stages the bytes under `.git/epicenter/scratch` and
renames them over the path, or removes the file. `grant_directory` sweeps
staged files more than an hour old by the time in their name
(`isStaleScratch`).

**The page-to-shell command set is not a cross-version contract.** A shell
update may replace these commands outright, and an installed app built for
the old ones is rebuilt. The shell keeps no second command set, no version
field, and no shim for an older page.

**The save lock stays in the shell, taken once per put or directory
removal.** `put_folder_file` holds the root's publishing mutex and the
folder's save lock (`PageWork::publishing`) across its check, the parent
directories it makes, and its rename or removal; staging its bytes holds
neither. `remove_folder_directory` holds them across its check and removal.
`make_folder_directory` takes neither. A save lock another process holds
past `SAVE_LOCK_WAIT` is `Io`, a failure that changed nothing. Only the page
decides `Unconfirmed`, when an invoke rejects without the shell's answer.
Letting the page hold the lock across several changes, so a page could run
Sync itself, is a separate decision.

## Consequences

- A desktop read and a desktop put are one IPC call each, at any depth; the
  literal-name walk runs in Rust, which reads each name's stored spelling by
  resolving the path on macOS and Windows and by listing each parent
  elsewhere.
- The desktop bundle carries `tauri-files.ts` and no `directory-store.ts`,
  `directory-node.ts`, or directory primitives.
- `directory-tauri.ts`, `page_reads.rs`, the Rust `Expectation` and
  `ChangeError`, the private index copy kind in `page_files.rs`, and
  `fixtures/page-file-changes.json` are deleted. The Bun host keeps
  `directory-store.ts` and its primitives.
- A failure the shell reports for a put, a save lock that timed out
  included, is `Io`; before, every failure of a rename or removal was
  `Unconfirmed`.
- A change whose invoke rejects without the shell's answer is
  `Unconfirmed`, and costs no further call. Tauri 2 sends a call again over
  `postMessage` when its custom-protocol request fails, so such a rejection
  is almost always one the command never ran for; the page cannot show it,
  and the path's state afterwards is no receipt. The engine's write reads an
  `Unconfirmed` put back once. A call sent again after it landed answers
  what its second run found, `stale` for a put.
- An app built for an older shell fails its storage calls until it is
  rebuilt.

## Considered alternatives

- **Return each entry's stored name from `stat_folder_path`.** Removes the
  parent listings but keeps a read at `d + 2` calls and a put at `d + 4`.
- **Keep the old commands beside the new ones for installed apps.** Two
  command sets to test and secure, for apps that are rebuilt with the shell.
- **Move the save lock to the page** so it can hold it across a Sync. Needs
  a lock lease across IPC and a page that may die holding it; decided
  separately.
