# 0562. The CLI and the shell take turns writing a folder under one save lock

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the full desktop app platform; only a local built-app runner over chosen data repositories remains, without source installation, build approvals, or general native services.
- **Amends:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md) at its Bun row's "saves from separate processes do not" and "in Bun, only saves within one process wait for each other": Bun's saves and the shell's checked renames take turns under one save lock per folder, `.<name>.epicenter-save-lock`.
- **Amended by:** [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at "`RootLock` stays the one-shell-per-folder lock": `RootLock` is deleted, and a second shell takes turns under the save lock like the CLI.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the `epicenter` CLI writes folders the app may hold open), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge that settles commits).
- **Unbuilt:** a test of `epicenter sync` and a page saving one file in the same folder at once, with neither save lost.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

[ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md)
gave each host the referee it has. On the desktop a save is the shell's checked
rename; in Bun a save is a check then a rename, and saves from separate
processes did not take turns. That was safe while one program wrote a folder.

[ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md)
makes the `epicenter` CLI, a Bun process, write folders that Epicenter may have
open: `epicenter sync` while a page saves. The shell's `RootLock`
(`packages/tauri-plugin-epicenter-folder/core/src/lock.rs`), an exclusive SQLite
transaction on `.<name>.epicenter-lock`, is held from a folder's first grant
until the shell exits, so the CLI cannot take it.

## Decision

**Every save to a folder, from the shell or from Bun, holds the folder's save
lock across its check and its change.**

```txt
.<name>.epicenter-lock        RootLock   one shell per folder, held while the shell has it open
.<name>.epicenter-save-lock   SaveLock   one save at a time, held across one check and one rename or removal
```

The save lock is an exclusive SQLite transaction on
`.<name>.epicenter-save-lock` beside the folder. The shell takes it in
`publishing()` (`dda3b5cdaa57:packages/tauri-plugin-epicenter-folder/core/src/registry.rs`)
around each checked rename and removal. `@epicenter/folder/bun`
(`packages/folder/src/bun.ts`, `holdingSaveLock`) takes it around each of its
own, so the CLI and any other Bun process do too. Each waits at most 10 seconds
(`SAVE_LOCK_WAIT`, `SAVE_LOCK_WAIT_MS`); past that the save fails and changes
nothing.

**A check that fails under the lock stays `Conflict`.** The lock makes the
check and the change one step; it does not merge.

**`RootLock` stays the one-shell-per-folder lock.** Commits keep Git's lock
files and `casBranch`, and ADR-0551's merges settle the rest.

## Consequences

- A page's save and a CLI save to one folder never interleave between check
  and rename, so neither overwrites a version it did not read.
- A save can wait up to 10 seconds behind another program's; a program that
  holds the lock longer makes the other save fail, and that save changes
  nothing.
- Each folder has a second lock file beside it.

## Considered alternatives

- **The CLI takes `RootLock`.** It is held while Epicenter has the folder
  open, so the CLI could never write a folder the app has open.
- **No lock between processes, as ADR-0541 had for Bun.** A save from the CLI
  could land between the shell's check and its rename and be overwritten.

## Amendment, 2026-10-31: the save lock lives in the folder's `.epicenter`, and sync takes it

Commit `1e66c2134b` moved the save lock from `.<name>.epicenter-save-lock`
beside the folder to `<root>/.epicenter/save-lock`, and the directory a save
stages its bytes in to `<root>/.epicenter/scratch`, so saving makes nothing
outside the folder. Both hosts make `.epicenter` and `scratch` `0700` when
missing, refuse either, and the lock file, when it is a symbolic link or not
the expected kind (`holdingFolderLock` and `takeFileLock` in
`packages/folder/src/native/directory.ts`, `privateDirectory` in
`directory-node.ts`; `prepare_state_directory` in the folder plugin's
`storage.rs`, `verify` in `lock.rs`), and neither lists `.epicenter`
(`isOwnDirectory` in `directory-store.ts`, `storage.rs`) or reports it from
a watcher (`native/watch.ts`, the plugin's `watch.rs`). The lock is still an
exclusive SQLite transaction, which `rusqlite` and `bun:sqlite` take alike.
`epicenter sync` now takes it too (decision 80): `mergeRemote` in
`packages/cli/src/sync/sync.ts` holds the save lock of every registered
folder in the repository across `git merge origin/main`, the checkouts that
settle it, and the merge commit, after fetching the LFS bytes the merge
checks out, so it never holds the lock across `git fetch`, an LFS transfer,
or `git push`. A save that read a file before the merge then finds it changed
rather than overwriting it, and a sync that cannot take a lock within the
save wait ends `retry` with nothing merged. `T6d` in
`packages/cli/src/sync/sync.e2e.test.ts` shows the merge waiting for a held
save lock. `epicenter init` writes `.gitattributes`, `.gitignore`, and the
bytes of `git lfs pull` without it.
