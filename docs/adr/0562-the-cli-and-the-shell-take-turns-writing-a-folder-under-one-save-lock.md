# 0562. The CLI and the shell take turns writing a folder under one save lock

- **Status:** Superseded
- **Date:** 2026-10-16
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the desktop app host; the desktop app hosts, installs, builds, and approves no app and gives a website no native capability, and survives only as a data browser over clones on disk.
- **Amends:** [ADR-0541](0541-a-desktop-folder-needs-no-web-locks-and-a-commit-that-loses-a-race-retries.md) at its Bun row's "saves from separate processes do not" and "in Bun, only saves within one process wait for each other": Bun's saves and the shell's checked renames take turns under one save lock per folder, `.<name>.epicenter-save-lock`.
- **Amended by:** [ADR-0568](0568-a-folder-takes-every-writer-in-turn-under-its-save-lock-and-refuses-none.md) at "`RootLock` stays the one-shell-per-folder lock": `RootLock` is deleted, and a second shell takes turns under the save lock like the CLI.
- **Relates:** [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the `epicenter` CLI writes folders the app may hold open), [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (the merge that settles commits).
- **Unbuilt:** a test of `epicenter sync` and a page saving one file in the same folder at once, with neither save lost.

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
`publishing()` (`packages/tauri-plugin-epicenter-folder/core/src/registry.rs`)
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
