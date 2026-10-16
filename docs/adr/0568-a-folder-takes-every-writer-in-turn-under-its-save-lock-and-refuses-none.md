# 0568. A folder takes every writer in turn under its save lock and refuses none

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) at "`RootLock` stays the one-shell-per-folder lock": `RootLock` and `.<name>.epicenter-lock` are deleted, and a second shell takes turns under the save lock like the CLI.
- **Amends:** [ADR-0535](0535-an-existing-folder-opens-with-its-own-declaration.md) at "a second scope on one root is refused `Busy`" and its consequence "The cross-process lock stays, one per folder": two scopes on one root share its publishing mutex, and a second Epicenter process shares its save lock.

## Context

The folder plugin kept two locks beside each folder
(`packages/tauri-plugin-epicenter-folder/core/src/lock.rs`):

```txt
.<name>.epicenter-lock        RootLock   taken at a folder's first grant, held until the shell exits; a second holder is refused Busy
.<name>.epicenter-save-lock   SaveLock   held across one check and one rename or removal, by the shell and by Bun alike
```

ADR-0535 kept `RootLock` because a second Epicenter process "would publish
under its own mutex, not this one", and said that letting two processes edit
one folder "would need the comparison under a lock both share". ADR-0562 then
built that lock: every save, the shell's `publishing()` and Bun's
`holdingSaveLock`, holds `SaveLock` across its check and its change, so the
`epicenter` CLI already writes folders a window holds open.

`RootLock` was left refusing only. Its one effect a person met was a lockout
in one shell: the Folders window lists a folder before its app is installed,
under `data:<name>`, and grants that scope; the app then opens the same
directory under its own scope, and the second scope's grant took `RootLock`
again and answered `Busy` until Epicenter restarted
(`apps/epicenter/src-tauri/src/data_folders.rs`, `own_folder_in`).

## Decision

**Every writer of a folder takes turns under its save lock, and no lock
refuses a second shell or a second scope.**

```txt
.<name>.epicenter-save-lock   SaveLock   the only lock file beside a folder
```

- `RootLock`, `lock_path`, `verify_lock_path`, `LockError`, and
  `GrantError::Busy` are deleted from the folder plugin, and
  `OpenFolderError.Busy` from `@epicenter/folder`.
- A grant prepares and resolves the directory and checks its Git layout. It
  takes no lock; `Folders::shutdown` releases none.
- Two scopes on one root share the root's publishing mutex, which the
  registry keys by canonical root, so the Folders window's `data:<name>` and
  an app's own scope serialize their saves in one shell.
- A second Epicenter shell on the root publishes under its own mutex and the
  same `SaveLock`, as the CLI does; a save it overtook is `Conflict`.

## Consequences

- An app opens its folder while the Folders window holds the same directory
  under a data scope.
- A development build and a release build may open one folder at once; each
  save waits for the other's, at most `SAVE_LOCK_WAIT`.
- Each folder has one lock file beside it. A `.<name>.epicenter-lock` an
  earlier version left is inert.
- Commits still take Git's lock files and `casBranch`, and Sync and Save
  version still take the folder's history lock (ADR-0559).

## Considered alternatives

- **Keep `RootLock`, and give a second scope on one root the first scope's
  handle.** It fixes the lockout in one shell and keeps refusing a second
  shell, which `SaveLock` already makes safe; the refusal protects nothing.
