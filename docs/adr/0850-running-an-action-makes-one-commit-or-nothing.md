# 0850. Running an action makes one commit, or nothing

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes as they happen, per-file hashes, run phases, and undo.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at what happens when an action throws (nothing was written, so nothing is undone) and at when its writes reach the folder (when `run` returns).
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (where actions run), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (pushing after a commit), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (a collection's `save` and `delete` follow the same rule), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (ignored files).
- **Unbuilt:** writes held until `run` returns. `packages/cli/src/run.ts` already notes dirty paths, refuses a write to one, and commits with `--only`; it still writes as the action runs and undoes changed paths when the action throws.

## Context

ADR-0842 made every action a commit in the folder it ran in, refusing writes to
paths the person had already edited. Its undo, which restored every path that
changed during a failed run, could erase an agent's concurrent edit, and later
designs (ADR-0848, then a separate folder only Epicenter wrote) grew around that
one hole. Once an action's writes are held until it succeeds, there is nothing
to undo, and the rule is the same in every folder.

## Decision

**Running an action makes one commit, or nothing.** The commit holds exactly
what the action wrote. An action that writes nothing, such as a search or a
sent email, makes no commit.

- Its `folder` writes and removes are held in memory, and its reads see them.
- When `run` throws, nothing is written.
- When `run` returns, `epicenter` checks that no written path has uncommitted
  edits (in the index or the working tree). A commit of that path would carry
  the person's edit, so nothing is written and the run fails naming the path
  ("commit or stash your edit to pages/x.md first").
- Otherwise it writes the files, then commits the tracked ones with
  `git commit --only <paths>`, named for the action, retrying while another Git
  command holds the index lock. Gitignored paths are written and never committed.
- After a commit it pushes, if the branch tracks a remote branch (ADR-0851).
  On your Epicenter a run also pulls first.

Writes made through `folder.path` by another program are outside the action and
are not held or committed.

## Consequences

- No folder is special: the rule is the same on your Epicenter, in a clone, and
  in an agent's worktree, and the vault stays at `~/Code/vault`.
- Deleted: undo, the run record, and a folder only Epicenter writes.
- A person with uncommitted edits to a file commits or stashes before an action
  that writes it.
- Build check before shipping: race a run's `git commit --only` against an
  agent's commit in the same folder 1,000 times, and count lost changes.

## Considered alternatives

- **Undo after a throw (ADR-0842 as built).** Erases a concurrent edit.
- **Recorded writes, hashes, and phases (ADR-0848).** Repairs a shared write
  instead of holding it back.
- **Only a folder nobody edits commits.** Two kinds of folder and the vault
  twice on the Mac, to guard against a hole that holding writes already closes.
