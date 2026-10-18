# 0541. A desktop folder needs no Web Locks, and a commit that loses a race retries

- **Status:** Superseded
- **Date:** 2026-10-15
- **Superseded by:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md): the desktop host; Epicenter builds no desktop host, no app registry or installed apps, and no native capabilities.
- **Amended by:** [ADR-0562](0562-the-cli-and-the-shell-take-turns-writing-a-folder-under-one-save-lock.md) at the Bun row's "saves from separate processes do not" and "in Bun, only saves within one process wait for each other": Bun's saves and the shell's checked renames take turns under one save lock per folder, `.<name>.epicenter-save-lock`.

## Context

The folder engine asks its host for named locks through the `locks` parameter,
and `directory-adapter.ts` names three per folder from its root: `openLock`,
`filesLock`, and `gitLock`. On the desktop they are the page's `navigator.locks`,
which coordinate only pages of one origin, and whether they reach across Tauri
windows is unverified. Meanwhile the shell checks every publishing rename
against the page's expectation under one mutex per folder (`rename_folder_path`,
`Registry.publishing`), and system Git takes its own lock files and moves the
branch by compare-and-swap (`casBranch`). A commit whose branch moved is
reported and not retried.

## Decision

**A file is never silently overwritten; everything else may fail and be retried,
because the files on disk are the truth.**

**Each host supplies the referee it has.**

| Host | Save (check, then write) | Commit | Repository creation |
| --- | --- | --- | --- |
| Desktop page | The shell's checked rename | Git's lock files and `casBranch` | Opening creates none, for any opener (ADR-0548): the first commit, staging, or remote runs `git init`, and runs it once more if the first attempt throws, since two concurrent `git init` runs can race on Git's template copy |
| Bun | Check then rename, not atomic; saves within one process take turns under an in-process lock, saves from separate processes do not | Git's lock files and `casBranch` | As on the desktop |
| Browser (OPFS) | `filesLock`: OPFS has no compare-and-swap | `gitLock`: the browser's `casRef` reads, compares, and writes under it | The first Git write, under `openLock` |

**On the desktop, `locks` never waits; in Bun, only saves within one process
wait for each other.** `openLock` and `gitLock` stay in the engine for the
browser, and `filesLock` for the browser and Bun's in-process lock.

**A commit whose branch moved retries once.** A commit is a snapshot of files
still on disk, so a retry captures everything the lost attempt held. A second
failure is reported.

**Freshness is [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)'s:** one channel, `folder.onFilesChanged`, fed by one detector of outside changes per host; the desktop's is the shell's file watcher, not `BroadcastChannel` hints, which do not cross windows.

## Consequences

- Nothing on the desktop depends on whether Web Locks cross Tauri windows, so
  that question needs no answer.
- Two windows that click Save version together both succeed, one after the
  retry, instead of one failing with a moved branch.
- In the browser, two tabs saving one file within the same moment still get a
  `Conflict` from the second save, as a `FileError` in the result, not an
  overwrite.

## Considered alternatives

- **Keep Web Locks on the desktop.** They order saves the shell already
  checks, and do nothing across origins.
- **Drop the browser's locks too.** The browser has no other referee: two tabs
  could overwrite each other's save or drop a commit from the branch.
- **One tab per folder in the browser**, one lock held while open with a
  takeover prompt. New interface, to remove three locks that already work.
