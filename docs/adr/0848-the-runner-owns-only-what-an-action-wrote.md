# 0848. The runner owns only what an action wrote

- **Status:** Accepted (2026-11-08)
- **Date:** 2026-11-08
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at what an action's commit and undo cover: the paths the action wrote, not every path that changed while it ran.
- **Relates:** [ADR-0846](0846-epicenter-owns-no-infrastructure-and-each-repository-has-one-meeting-point.md) (who runs actions, and when).
- **Unbuilt:** all of it. Today's `packages/cli/src/run.ts` commits every path that changed during the run and, when an action throws, restores or deletes every path that changed and was clean before, which can revert or delete an edit an agent makes at the same moment. `readOnly` is a hint `run.ts` ignores, a failed commit leaves the action's writes uncommitted with no record, and the lock waits up to a day.

## Context

An app's folder is one working tree that the person, their agents, and actions
all write. ADR-0842 committed and undid by comparing the folder before and
after a run, which cannot tell an action's write from a concurrent one. On an
always-on machine where `tick` runs every minute and agents edit all day, that
window is routine: an action that throws on a Gmail rate limit while Claude
Code edits `mail/lib.ts` reverts the edit, and deletes the agent's new file.
A council found this in the shipped code; it also found that `readOnly` is not
enforced and that a killed or uncommitted run leaves nothing to repair from.

## Decision

**The runner owns only what the action wrote.** The folder's methods record
each write and removal. An action that writes through `folder.path` declares
the subtree it writes. The commit, and any undo, covers only those paths. A
path the action did not write is never committed, restored, or deleted; a
change to one is reported.

**A run keeps a record, under the app's lock, with its phase.** For each written
path it stores a hash of what the action wrote (or "removed"), taken right after
the write.
- `running`: the next lock holder undoes the recorded writes.
- `ran, commit pending`: the next lock holder commits the recorded paths and
  never undoes them, because the action's effect outside the folder already
  happened.
Either way, a path is undone or committed only while the file still matches its
recorded hash; otherwise it is left alone and reported, and dropped from the
record. A file written but not yet recorded when the process died is left and
reported, never removed. A commit that fails in process is retried a few times,
then left to the next holder.

**`readOnly` is enforced before it is trusted.** A read-only run's folder has no
`write` or `remove`; changes through `folder.path` are checked afterwards and
fail the run. It skips the app's lock; its cache stays writable (SQLite with
WAL and a busy timeout), and `cache.clear()` always takes the lock.

**Unattended runs never import uncommitted code, and say so.** `tick` and the
front door refuse (exit 2) when the app's code differs from its last commit:
tracked or untracked `*.ts` and `*.js`, `package.json`, and the lockfile.
`tick` records each refusal, and the `epicenter` listing and the front door's
page show it ("mail: 8am triage refused, commit your edit first"). Terminals and
agents run the working tree. Agents develop in worktrees, so `~/Epicenter` is
the deployed copy; an agent that edits in place will see its app's schedules
refused until it commits, which is intended.

## Considered alternatives

- **Commit by comparing before and after (ADR-0842 as written).** Captures and
  destroys concurrent edits.
- **Actions commit from a throwaway worktree with `update-ref`.** Removes the
  shared tree, but an action must see the person's uncommitted state (Mail's
  hand-edited batch is gitignored), so the action runs in the folder.
- **Undo without hashes.** A later hand edit of a path a killed action had
  written would be reverted or committed under the action's name.

## Consequences

- Tests: an edit an agent makes during a failing action survives, a new
  untracked file included; a killed action's file edited by hand survives the
  next run; a commit that fails after `run` returns is completed by the next
  action.
