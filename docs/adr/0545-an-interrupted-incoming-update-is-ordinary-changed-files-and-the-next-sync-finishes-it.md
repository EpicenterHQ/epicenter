# 0545. An interrupted incoming update is ordinary changed files, and the next Sync finishes it

- **Status:** Superseded
- **Date:** 2026-10-15
- **Supersedes:** [ADR-0474](0474-incoming-git-adoption-retains-a-recoverable-plan.md)
- **Superseded by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md): no host runs Epicenter's own Git engine; `epicenter sync` merges with stock `git`.
- **Amends:** [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md), withdrawing `git.recoverIncoming()` and `git.snapshot.pendingIncoming`.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

ADR-0474 had the browser write `.git/epicenter-incoming.json` (an operation id,
the branch, the old and new head) and pin both commits under
`refs/epicenter/incoming/expected` and `refs/epicenter/incoming/next` before it
applied an incoming update (`9d13dd25854e:packages/folder/src/git/opfs-git.ts`). While the
record exists the update is pending: staging, commits, and further incoming
updates are refused until a person runs `git.recoverIncoming()`. The desktop
and Bun keep no record since ADR-0531: `publishIncoming` in
`git/native-backend.ts` applies the files, writes the index, and moves the
branch, and an interrupted update is reconciled by the next Sync.

## Decision

**No host records an incoming update in progress.** The browser applies an
incoming update as the desktop does: files first, then the index, then the
branch. An update cut off partway leaves files that differ from `HEAD`; status
shows them as changed, and the next Sync records them and merges with the
tracking ref. A fast-forward cut off partway holds, at each path, the old version,
the new one, or, in the browser when a file's close fails, an empty file;
in each case the next Sync lands on the remote's tree
(`git/opfs-incoming.test.ts` interrupts the update at six points).

**Removed from the folder contract:** `git.recoverIncoming()`,
`git.snapshot.pendingIncoming`, `RecordedIncoming`, `PendingIncoming`,
`RecoverIncomingResult`, the `IncomingPending` refusal, and the progress variants
of `PublishResult` that only reported how far an update got.

## Consequences

- An interrupted browser Sync no longer freezes commits behind a Recover
  button; it is finished by the next Sync, as on the desktop.
- Deleted, about 2,300 lines: the record and recovery in `opfs-git.ts`, their
  types in `git/backend.ts`, `pendingIncoming` and `recoverNow` in
  `git/history.ts`, `pendingReason` in `git/browser-backend.ts`, most of
  `git/opfs-incoming.test.ts`, the Recover path in Todos (`lib/status.ts`,
  `lib/git.ts`, `AppHeader.svelte`) and in the Git lab.
- A Sync interrupted between files and branch can add one local commit of the
  mixed tree before the merge, which ADR-0474 avoided. The desktop already
  accepts this.

## Considered alternatives

- **Keep the record in the browser only.** One host would need a recovery step
  the others do not, for an interruption the next Sync already finishes.
