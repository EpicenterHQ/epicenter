# 0529. Commits happen only on sync or when a person saves a version

- **Status:** Accepted
- **Date:** 2026-10-12
- **Amends:** [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md), withdrawing automatic commits after saves. That a save succeeds independently of any commit, and that each reports its own outcome, remains.
- **Amended by:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) at "only": a browser clone commits at each sync, and sync runs on its own once edits settle.
- **Relates:** [ADR-0528](0528-applications-edit-files-through-the-query-cache.md) (edits are written at once, without commits)
- **Unbuilt:** removing `commitOnEdit` and the automatic commit worker from the TypeScript history and the desktop owner; "Save version" in Capture, Honeycrisp, and Whispering; Todos' Fetch, Pull, Merge, and Commit and push controls removed in favor of Sync.

## Context

Every published save asked for an automatic commit. The browser, Bun, and
desktop owners each carried a request counter, a coalescing worker, and an
option to turn it off, which 89 test setups did. Writes now happen on every
edit, so a commit per write would fill history with near-identical versions.

## Decision

**A commit happens only when sync checkpoints before it runs, or when a person
saves a version.**

- `folder.git.commit()` is the version action. Capture, Honeycrisp, and
  Whispering show it as "Save version". Vocab shows none.
- Saves never request commits. `commitOnEdit`, `requestAutomaticCommit`, the
  automatic worker, and the desktop owner's `Automatic` machinery are deleted,
  with `GitError.AutomaticHistory` and the staging refusals that option forced.
- The in-app terminal's `git add` and `git commit` are always available.
- Status says "Saved" for a save. The count of files changed since the last
  version is neutral detail, not a warning.
- Todos keeps Sync and "Save version" and drops Fetch, Pull, Merge, and
  Commit and push.
- The Git app reads on open, focus, terminal actions, and after sync instead
  of subscribing to file changes. The folder still offers `onFilesChanged`.

## Consequences

A folder that never syncs has history only when its person saves a version, so
Honeycrisp's per-note history shows fewer entries. Sync's checkpoint can carry
many edits in one commit. Explicit commits keep their locks, capture checks,
and index handling; the watermark that stops sync from claiming an edit that
landed after its capture stays.

## Considered alternatives

- **A commit about a minute after the last write.** Needs a timer, coalescing,
  and close behavior in both the TypeScript and desktop owners.
- **A commit per save, as before.** Fills history with near-identical versions
  once every edit is written.
