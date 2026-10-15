# 0541. A desktop folder needs no Web Locks, and a commit that loses a race retries

- **Status:** Proposed
- **Date:** 2026-10-15
- **Unbuilt:** passing a non-waiting `locks` to directory folders on the desktop and in Bun; retrying a commit whose branch moved.

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

| Host | Save (check, then write) | Commit | First open |
| --- | --- | --- | --- |
| Desktop page | The shell's checked rename | Git's lock files and `casBranch` | Idempotent: the repository is made by the first commit |
| Bun | Check then rename, not atomic (the one writer nothing serializes) | Git's lock files and `casBranch` | Idempotent |
| Browser (OPFS) | `filesLock`: OPFS has no compare-and-swap | `gitLock`: the browser's `casRef` reads, compares, and writes under it | `openLock` |

**On the desktop and in Bun, `locks` never waits.** `openLock`, `filesLock`, and
`gitLock` stay in the engine for the browser.

**A commit whose branch moved retries once.** A commit is a snapshot of files
still on disk, so a retry captures everything the lost attempt held. A second
failure is reported.

**Hints stay best effort.** `BroadcastChannel` hints may not cross windows; a
window reads again on focus.

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
