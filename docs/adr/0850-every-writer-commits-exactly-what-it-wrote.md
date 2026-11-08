# 0850. Every writer commits exactly what it wrote

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases. Its per-path hash survives as the check at commit.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at what happens when an action throws: what it wrote is committed and labelled, and nothing is undone.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (where actions run), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (pushing), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that write a folder), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (ignored files).
- **Unbuilt:** committing after a throw and the check at commit. `packages/cli/src/run.ts` already writes as an action runs, refuses a write to a path with uncommitted edits, hashes paths, and commits with `--only`; it still undoes changed paths when the action throws.

## Context

ADR-0842 made every action a commit and undid a failed action's changes. The undo
could erase an agent's concurrent edit, and later drafts answered with an action
as a transaction: writes held in memory until success, then exceptions for files
that had to be written at once, a run log, and a convention for partial results.
Four mechanisms for one concern pointed at the premise. Git already undoes; the
runner does not need transactions of its own.

## Decision

**Every writer commits exactly what it wrote.** The rule is the same for the
person, Claude Code, a program such as Whispering, and `epicenter`.

For an action:

- It writes as it runs. A write to a path with uncommitted edits (in the index or
  the working tree) is refused, naming the path ("commit or discard your edit to
  pages/x.md first").
- `epicenter` keeps a hash of the last content the action wrote to each path.
- When the action ends, whether it returned or threw, `epicenter` commits the
  tracked paths whose content still equals that hash, with
  `git commit --only <paths>`, retrying while another Git command holds the index
  lock. A path that changed after the action wrote it is left uncommitted and
  named, so someone else's edit is never filed under the action's name.
- The commit message states the outcome: `mail apply newsletters` or
  `mail apply newsletters (failed: quota exceeded)`. Exit code 3 still reports
  the throw, and `git revert` undoes the commit.
- Gitignored paths are written and never committed.
- An action that acts outside the folder records its progress in its own files as
  it goes; Mail's `apply` marks each message in its batch as it is applied.
- A killed process leaves its writes uncommitted. The next run refuses those
  paths until the person commits or discards them, and `git status` shows them.

Writes made through `folder.path` by another program are outside the action and
are not committed.

## Consequences

- No folder is special, nothing is undone, and nothing is held in memory, so an
  action can write large files.
- A failed action leaves a labelled commit of what it did before failing, which
  `git revert` removes.
- A test run of an action in an agent's worktree commits its data on that branch;
  the agent drops or squashes those commits before merging.
- Build check before shipping: race an action's commits against an agent's
  commits and edits in the same folder 1,000 times, and count changes lost or
  filed under the wrong name. If any are, writing in a folder people edit is
  reopened, with clones only `epicenter` writes as the fallback.

## Considered alternatives

- **Undo after a throw (ADR-0842 as built).** Erases a concurrent edit.
- **One commit or nothing: writes held until the action returns.** Needed a
  write-through exception for files an action must write before acting outside
  the folder, a run log, and a partial-result convention, and held large files in
  memory.
- **Recorded writes, hashes, and phases (ADR-0848).** Repairs a shared write
  instead of committing what is known to be the action's.
- **Clones only `epicenter` writes, beside the person's copy.** No shared index,
  but the vault twice on the Mac, phone writes invisible to the editor until a
  pull, and none of the vault's ignored local state (`.calendar/`, `.photos/`) in
  the clone.
