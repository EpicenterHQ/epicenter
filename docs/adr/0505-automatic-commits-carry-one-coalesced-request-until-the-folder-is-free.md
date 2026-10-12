# 0505. Automatic commits carry one coalesced request until the folder is free

- **Status:** Proposed
- **Date:** 2026-10-05
- **Amends:** [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md), withdrawing "an unavailable runner or shared lock skips the attempt, with no pending pass" and "the owner retains no automatic request for execution afterward". A save that finds the folder's Git work busy leaves one pending request that runs when the work ends. Save independence, local-only automatic history, no timer, no retry of a failed commit, and no final commit at close remain.

## Context

ADR-0468 made each successful save make one immediate automatic commit
attempt that ran only if the folder's Git work was free at that instant. The
TypeScript history entered the backend with `tryExclusive`, which asked this
tab's queue and then the Web Lock with `ifAvailable`; the native
`FolderOwner` spawned a thread per save that took the file gate and the Git
lock with `try_lock` and returned the decision over a channel.

A save made while another tab, a pull, a path listing, or the previous commit
held that work was therefore never committed until a later save or an
explicit `commit()`. The last save of a burst, the one most likely to land
while the burst's first commit was still running, was the one most often left
out. Nothing told the person why, and nothing would commit it on its own.

## Decision

**A successful, non-empty save asks for an automatic commit; requests not yet
answered are one pending obligation.** It stores no file bytes or paths. Only
saves published through the handle or owner ask: `noteEdit`, external
changes, partial or unconfirmed publications, and incoming updates do not.
Every opened folder asks; there is no setting that turns this off.

```txt
requested   newest request, numbered by the saves that made them
answered    newest request a whole-folder checkpoint started for,
            or a failed admission gave up on
pending     answered < requested
```

| Owner | Where it lives | Where a save numbers its request |
| --- | --- | --- |
| Browser and Bun | `createHistory` in `packages/folder/src/git/history.ts` | `requestAutomaticCommit()`, after the publication result |
| Desktop | `Automatic` under `FolderOwner`'s leaf mutex in `packages/tauri-plugin-epicenter-folder/core/src/owner.rs` | inside the file gate the batch published under |

**At most one worker per handle or owner carries the obligation, and it waits
for the existing protection.** The worker waits as an explicit commit does:
`backend.exclusive` with the closing signal, or the native `enter_both`. Saves
made while it waits or commits only renumber the obligation. When the
protection is released, the worker captures the folder as it is then and
commits the latest files without another save. No queue, timer, debounce,
leader, or second waiter exists. `tryExclusive`, `Admitted`, and the mutex's
`tryRun` are removed. The browser requests its Web Lock directly: the same
lock queues requests within a tab and across tabs, and cancels waiters when
closing starts. It checks closing again at callback entry. The Bun backend
keeps its process-local mutex because it has no Web Lock.

**Every whole-folder checkpoint answers the requests made before it starts.**
`commit()`, `commitAndPush()`, and the automatic worker set `answered` to
`requested` inside the protection, before the blocker check, the parent pin,
and the capture. An automatic worker that enters and finds nothing pending
records nothing: it does not overwrite the explicit commit's `lastCommit`
with a redundant `unchanged`. Browser and Bun saves can race the capture
and authorize a later `unchanged` pass; tree equality prevents an empty commit.
After every awaited step the worker checks for
pending requests and releases itself in one step that a request cannot fall
between, so a save that asks while a checkpoint runs is never lost.

**A failure answers its requests and is not retried.** A `blocked`, `failed`,
`branchMoved`, or `unconfirmed` checkpoint is recorded in
`snapshot.lastCommit`; only a newer save asks again. A request to enter the
protection that is refused other than by closing gives up on the requests made
before it asked and records `failed`; this holds for an explicit commit too,
which therefore answers the saves before it. A desktop worker whose thread
cannot be spawned frees its place, records `failed`, and gives up on the
requests it was started for; a request made meanwhile starts another worker.

**Closing ends the obligation.** `close()` and `shutdown()` refuse a worker
still waiting for the protection; it never moves the branch afterward. A
checkpoint already inside the protection finishes and is recorded. Nothing is
committed because of closing.

**Automatic commits never push.** Only `push()` and `commitAndPush()` start
outgoing transport.

## Consequences

- A save made while the folder's Git work is busy is committed once it ends,
  without another save. The cost is at most one waiting promise per browser or
  Bun handle, and one sleeping thread per desktop owner, while that work runs.
- One checkpoint can include many saves. Intermediate versions saved while the
  worker waited need not enter history, as under ADR-0468.
- `activity.commit` stays active while a request waits for another tab's Web
  Lock or other Git work, not only while a commit runs.
- A refused explicit commit suppresses the automatic commit of the saves made
  before it. The failure is visible, and the next save asks again.
- A save whose request is still waiting at close stays uncommitted, as a
  skipped one did.

## Considered alternatives

- Keep skipping a busy attempt. Leaves the last saves of a burst uncommitted
  until an unrelated edit, which is what this record fixes.
- A pending boolean instead of request numbers. A request to enter the
  protection can be refused before its work runs; with one flag, clearing it
  loses saves made during the wait, and keeping it retries the same failure.
- A generic pass runner with a follower queue. It adds a second ordering
  beside the backend's protection and more lifetime states than one counter
  pair and one worker.
- Retrying a failed commit on a timer. Restores the scheduling obligation
  ADR-0468 rejected, for failures that usually need a person.
