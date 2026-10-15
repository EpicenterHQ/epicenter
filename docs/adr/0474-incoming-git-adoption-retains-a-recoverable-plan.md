# 0474. Incoming Git adoption retains a recoverable plan

- **Status:** Superseded
- **Superseded by:** [ADR-0545](0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md)
- **Date:** 2026-10-01
- **Amended by:** [ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md), which deletes the desktop folder owner, so the desktop keeps no `.git/epicenter/incoming.json`; an interrupted desktop update is reconciled by the next Sync
- **Relates:** [ADR-0467](0467-file-workflows-report-each-operations-outcome.md) separates ordinary workflow outcomes; [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md) separates saves and history; [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) defines folder ownership.
- **Unbuilt:** the record and its recovery for the Bun directory opener (`@epicenter/folder/bun`), whose fast-forward reports the steps that landed and keeps no record; its `recoverIncoming()` returns `none`.

## Context

Incoming adoption replaces authored files, changes the staging index and moves
HEAD. Independent OPFS or native writes can stop between these changes.
Checkpointing that mixed tree can create divergence from the fetched target.
A later fetch can move the tracking ref and lose the original recovery target.

Ordinary app saves need no general journal. Incoming Git adoption needs enough
repository-owned evidence to identify an interrupted plan and retain its bytes.

## Decision

**Incoming adoption retains a Git-owned record before changing the working tree.**
The record resides inside `.git/`: `.git/epicenter-incoming.json` in a browser
folder and `.git/epicenter/incoming.json` under the desktop owner. Refs under
`refs/epicenter/incoming/` pin the before and after commits while the record
exists, so the target survives tracking-ref changes and garbage collection. A
repository without a before commit records that absence explicitly.

The durable record has exactly four fields:

```ts
type IncomingRecord = {
  operationId: string;
  branch: string;
  expectedHead: string | undefined;
  nextHead: string;
};
```

The working tree and index are assessed from the pinned trees on each explicit
recovery attempt. Per-file progress and duplicate file bytes are not recorded.
An unreadable nonempty record remains pending, is never deleted automatically,
and names the record for review. A browser record that is empty represents
interrupted admission, before any working-tree change; explicit recovery clears
it as `admissionCleared`.

`git.snapshot.pendingIncoming` reports the record as `recorded` with its four
fields, `unadmitted` for the empty browser record, or `unreadable`.

**Fetch and adoption remain explicit separate actions.**
`git.fetch()` transfers objects and updates remote-tracking refs without changing
authored files. `git.pullFastForward()` evaluates the fetched target and requires
clean portable files, a clean staging index, supported literal paths and a target
that descends from local HEAD. A browser folder's `git.mergeIncoming()` writes a
merge commit over diverged histories and publishes it through the same record;
it adds no automatic merge policy. Opening, focusing, refreshing or pushing does
not start or replay adoption.

**Recovery rolls forward only over the recorded before or after content.**
`git.recoverIncoming()` compares each affected path's current bytes or absence
with the before and after tree entries. A path already at the after state is
skipped. A path still at the before state receives the planned conditional
change. Any other content stops recovery as `RecoveryRefused` and names the
path. Directory and filename collisions stop it too. Recovery never rolls back
over later edits or infers that absence lets it remove another writer's file.

After files satisfy the target tree, recovery publishes the target index and
replaces the branch through compare-and-swap against the recorded expected HEAD.
A branch that already names the target clears the record without writing files
(`cleared`). A competing index or branch change stops recovery; it is not
overwritten from the old plan. Native index publication uses Git's lock
protocol. The record and its pins are removed only after the completed state is
verified (`completed`, with `changedPaths`). A step that fails or whose reply is
lost reports `Partial` or `Unconfirmed` and keeps the record.

**Interrupted adoption blocks mixed checkpoints, while ordinary editing remains available.**
A stopped or unknown attempt retains its record. While it exists, a commit is
`blocked`, and staging, pulls and merges refuse with `IncomingPending`. File
saves continue, and fetch can still retain a new remote observation without
changing the pinned target. Edits to affected paths can make recovery refuse
until a person restores those paths. Opening and status report the pending
record. Only an explicit `recoverIncoming()` resumes, and it evaluates current
files and repository state again.

## Consequences

A process interruption cannot silently become an ordinary mixed-tree commit.
The original before and after bytes remain available for review. Recovery adds
one bounded repository-owned record and commit retention; it does not make a
multi-file working-tree transition atomic or back up every app save. Nothing
abandons a pending update: a record that recovery refuses stays until the named
paths are restored.

Outside writers remain possible. Their changes can stop safe roll-forward and
require manual resolution. The record must survive unknown file, index and
branch replies without treating current content as proof of a particular reply.
Neither backend promises durability across power loss: the browser has no
flush-to-disk guarantee, and native checks are not an operating-system
compare-and-swap against other programs.

## Verification

Interrupt before and after record publication, every file change, index
publication, branch replacement and record clearing. Reopen, expose the pending
state, and explicitly resume. Verify moved tracking refs retain the target;
modified paths, index and HEAD refuse stale recovery; commits refuse a mixed
tree; and matching completed phases are skipped. Cover an initially empty
repository and invalid authored Markdown without generated conflict markers.

Todos exposes recovery as an explicit button; its pending-update fault tests
drive the production browser adapter, on the in-memory OPFS stand-in, against
a real Git remote. Native GUI acceptance of a
desktop app holding a pending record has not been run.

## Considered alternatives

- Record no incoming plan: later checkpoints can create divergence and fetch can
  stop retaining the target needed to finish adoption.
- Journal every app save: extends incoming-specific coordination to unrelated work.
- Replay automatically at startup: can replace current files without review.
- Roll back the old tree: can overwrite edits made after the interruption.
