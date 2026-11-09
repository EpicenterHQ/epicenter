# 0850. Every writer commits exactly what it wrote

- **Status:** Proposed
- **Date:** 2026-11-08
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases. Its per-path record survives as the Git object each write stores.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at what happens when an action throws: what it wrote is committed and labelled, and nothing is undone.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (where actions run), [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (pushing), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that write a folder), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (ignored files).
- **Built:** 2026-11-09, in `packages/cli/src/commit.ts` and `run.ts`: the check before each write lands, each write stored as a Git object, the commit built from those objects with the branch moved by compare-and-swap, the labelled commit after a throw, and `writeOnly` inputs kept out of the body. The undo is deleted. Acceptance C1 to C9; `packages/cli/scripts/race.ts` is the race. Repaired 2026-11-09 after the final review (F1 to F6): the per-path `{ base, mode, object }` record, the Git environment on every command, each run in its own process (`child.ts`), and one report for every run.

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

- It writes as it runs. Immediately before each write lands, `epicenter` checks
  the path: it must have no uncommitted edits (in the index or the working tree),
  or, if the action wrote it earlier in this run, still hold what the action
  wrote. Otherwise the write is refused, nothing is written to the path, and the
  path is named.
- Once a write lands, `epicenter` stores its bytes as a Git object
  (`git hash-object -w --path`, so the path's filters apply as `git add` would)
  and records `{ base, mode, object }` for that path: the blob and file mode the
  index held before the run's first write there, and the object the path holds
  now, `null` for a deletion. A write keeps the file's mode, so an executable
  stays executable.
- When the action ends, whether it returned or threw, `epicenter` compares each
  recorded path with HEAD. HEAD still holding `base` means the path is the run's
  to commit; HEAD already holding `object` means it is already in history;
  anything else means a commit made during the run changed it too. It builds the
  commit from HEAD plus exactly the run's objects, with their modes, in a
  temporary index, and moves the branch only if it still points at that HEAD
  (compare-and-swap). It then updates the index for those paths. What is on disk
  when Git looks is never what gets committed, so an edit someone saved after
  the action's write stays an uncommitted change on top, and is named.
- If a commit made during the run changed one of the action's paths, that path
  is left out and named; `epicenter` never merges.
- Two locks, held for different spans. The app's turn, a lock file in its `.git`
  directory, is held from before the action starts through the commit, so runs
  of one app take turns; the push happens after it is released. Git's own index
  lock is held only while committing: from reading HEAD, through building the
  commit and the compare-and-swap, to the index update, so no `git add` or
  `git commit` interleaves. Nothing else `epicenter` runs takes the index lock.
- Every Git command `epicenter` runs sets `GIT_LITERAL_PATHSPECS=1`, so a path
  such as `notes/*.md` is a name and never a pattern; `GIT_OPTIONAL_LOCKS=0`, so
  a read such as `git status` never takes the index lock; and
  `GIT_TERMINAL_PROMPT=0`, so a push never waits for a password nobody can type.
  `git check-ignore` is the exception to the first: Git refuses literal
  pathspecs there, and `epicenter` passes it one path at a time.
- The commit message states the outcome: `vocab words save` or
  `vocab words save (failed: quota exceeded)`, the failure's first line
  cut to about 60 characters. The body is the input as JSON, then the full
  error. `git revert` undoes the commit.
- Every run answers with one report: what the action returned or threw, the
  writes refused, the commit (or `null`, or why it failed), what each written
  path became, and what the push did. `--json` prints it and MCP returns it. Exit
  codes: 0 ran; 2 did not run; 3 ran and failed, meaning it threw, a write was
  refused, the commit failed, or the run ended without a report. ADR-0842's exit
  code 1, a finding, is gone: a refused write is the run failing, and nothing
  else reported a finding. A command that did not run answers
  `{ "error": { "name", "message", "next"? } }`, replacing ADR-0842's `code`.
- An input marked `writeOnly` stays out of the commit body.
- Gitignored paths are written and never committed.
- An action that changes the world does not record its progress in the folder:
  its verbs are safe to repeat on the targets they are given, so a run that
  fails partway is finished by running it again (ADR-0859).
- A killed process leaves its writes uncommitted. The next run refuses those
  paths until the person commits or discards them, and `git status` shows them.

**The limit, stated.** The check and the write landing are two steps, so an
editor save in the instant between them can be overwritten. The guarantee
covers writes made through the action's `folder`; writes made through
`folder.path`, by the action or another program, are not recorded and not
committed.

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
  reopened, with clones only `epicenter` writes as the fallback. The race is
  evidence, not proof; the deterministic tests that pause an action before and
  between its writes (acceptance C4) are what show the guarantee.
- An agent's `git add` or `git commit` that arrives while `epicenter` holds the
  index lock fails as it would against any Git command, and the agent retries.

## Considered alternatives

- **Undo after a throw (ADR-0842 as built).** Erases a concurrent edit.
- **A hash of what the action wrote, checked before `git commit --only`.** A
  hash shows the bytes match; it cannot show who wrote them, and an editor's save
  between the check and Git reading the file would be committed under the
  action's name.
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
