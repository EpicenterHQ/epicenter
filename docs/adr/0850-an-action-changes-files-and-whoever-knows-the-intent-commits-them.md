# 0850. An action changes files, and whoever knows the intent commits them

- **Status:** Proposed
- **Date:** 2026-11-09 (first drafted 2026-11-08 as "Every writer commits exactly what it wrote")
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at "an action is a commit": a run makes no commit of its own, nothing is undone, exit codes are 0, 1, and 2, and a refusal to run is `{ error: { name, message, next? } }` without `code`.
- **Relates:** [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (`epicenter sync`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that write a folder), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (LFS), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (what each path becomes), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (the snapshots `serve` takes).
- **Amended:** 2026-11-10: a write commits itself, named for the call, however it arrives, and writes to one app take turns; `folder.commit` is removed. 2026-11-11: runs never commit, history is snapshots, a change that depends on what it read says so with `folder.update`, and the write lock is deleted. The commit per call held a lock for the whole run, so a slow action blocked every other write to its app, and it still swept a hand edit pending in the folder into the call's commit under the call's name.
- **Built:** `folder.update` (`packages/cli/src/disk.ts`, `packages/app/src/memory.ts`), the snapshot and its call log (`packages/cli/src/snapshot.ts`), the runs that log their writes (`run.ts`), the snapshots after a write from the command line and `serve`, of quiet outside edits in `serve`, and in `sync`, the app's status, and the answer as `{ returned }`, `{ threw }`, or `{ error }` with exit codes 0, 1, and 2. The first draft is recoverable at `9943c668db`; the commit per call and its lock at `965f4873c4`.

## Context

The first draft of this record made `epicenter` commit exactly what each action
wrote. It was built: a check before each write landed, each write stored as a
Git object, a commit built from those objects in a temporary index, the branch
moved by compare-and-swap, Git's index lock held across the commit, and a lock
per app so runs took turns. A 1,000-run race against an agent committing in the
same folder found a real bug inside that machinery (`commitWrites` released
Git's index lock for large indexes, fixed in `c6bbf437c7`).

The machinery protected the rarest writer. In `~/Code/vault`, the author's most
used personal software, 479 commits since 2026-10-01 were each written by the
agent that made the change, with a message naming its intent ("Develop November
4 journal and dinner conversations"). An action knows its own effect; the
caller knows that twelve `vocab add` calls are "Tuesday's lesson".

The amendment of 2026-11-10 then made each write one commit named for the call,
with a lock per app held from before the run until its commit. Two things were
wrong with it. The lock made the run the unit of exclusion, so one slow action
(an import, a call to an outside service) held every other write to its app.
And the commit still took everything pending in the folder, so an agent's
direct edit was recorded under whichever call came next, with a name that
claimed it.

Three questions had been answered by one mechanism: what the history says, how
a change that depends on what it read stays correct, and what a tool's
annotations promise. Each has its own owner.

## Decision

**The folder's history is snapshots, named by what is known.** A run never
commits. The runner and `serve` take snapshots: a snapshot commits everything
pending in the app's folder and names it by the calls that wrote since the last
one.

```txt
the command line   after a write run it ran itself
epicenter serve    after each write call, one at a time per app; over HTTP,
                   also every minute for an app whose pending changes are the
                   same as a minute ago (outside edits gone quiet), and a push
                   after each snapshot that commits
epicenter sync     before it pulls and pushes (ADR-0851)
an agent           git commit -m '…', for a sequence it understands
```

Each run that is not read-only appends one line to the app's call log
(`git rev-parse --git-path epicenter-calls`) naming the call
(`tasks: add Water the plants`) and the paths it wrote through `folder`. A
snapshot renames the log aside before reading it, so a run that ends meanwhile
starts a new log. The one call whose writes are pending names the snapshot;
otherwise it is `<app>: <n> changes`, and its body lists the calls. Pending
paths no logged call wrote are listed as `Changed outside epicenter: <paths>`.

A snapshot takes everything pending in the app's folder and nothing outside it:
`git add -A` and `git commit` with the pathspec `.`, never `*.local` or
`*.local.*` (ADR-0868). An app inside a larger repository
(`~/Code/vault/recipes/`) commits into that repository and touches nothing else
in it. Before staging it checks that this computer has Git LFS's filter
(`git config filter.lfs.process`) when `.gitattributes` routes a path through
it, and otherwise stops with `run: git lfs install` (ADR-0856). When Git's
`index.lock` is held, it retries for up to 2 seconds. Nothing pending makes no
commit. A snapshot that fails changes no answer: it writes why to
`git rev-parse --git-path epicenter-snapshot-error`, leaves everything pending
and the calls logged, and `epicenter <app>` shows the pending count and that
reason with `epicenter sync <app>` until a snapshot succeeds.

**A change that depends on what it read uses `folder.update`.**
`folder.update(path, change)` reads the file, calls `change` with its text
(`undefined` when there is none), and writes what `change` returns only if the
file is still what `change` saw; otherwise it starts over, up to 10 times, then
throws `{ name: 'Changed' }`. A `change` that throws writes nothing. The file
it writes beside the target before renaming it over is named for the text it
replaces and made only when no other is, so two updates of the same text never
both write; rereading before the rename alone lost 5 of 50 concurrent `set`s
of one file, since another process can rename between the reread and the
rename. Every
collection write (`add`, `set`, `edit`, and the first write of a one-file
collection) goes through it, so the action, by way of its collections, owns
the correctness of a read-modify-write. `folder.write` stays a plain write, and
the last one wins.

**Annotations describe a tool to its clients; the runner enforces only
`readOnlyHint`.** A read-only run's writes through `folder` and `secrets` throw
before doing anything, and it is never logged or snapshotted.
`destructiveHint`, `idempotentHint`, and `openWorldHint` are for MCP clients.

**Running an action needs nothing from Git.** An app need not be a repository,
or the top of one; a folder in no repository is never snapshotted and keeps no
call log. `epicenter new` makes a repository.

**`epicenter` does nothing Git already does.** It runs Git's porcelain and
passes on Git's messages: no Git objects of its own, no temporary index, no
compare-and-swap, and no lock of its own. Git's `index.lock` serializes
commits; `update` serializes changes to one file.

**`folder` is a convenience, not a sandbox.** Paths stay normalized and `.git`
stays refused (`normalizePath`). `folder.path` is the folder. An action can
import `node:fs`; what it writes that way is a change from outside epicenter.

**A run answers what the action did.**

```txt
{ "returned": <value> }                      exit 0
{ "threw": { "message", "thrown"? } }        exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }  exit 2, nothing ran
```

`--json` prints it and MCP returns it as `structuredContent`. Each run still
happens in its own process (`child.ts`), so nothing an action prints reaches the
answer.

## Consequences

- No lock: two writes to one app run at once, and a slow action blocks no one.
- A throw's writes are pending changes like any; the snapshot after the call
  names it.
- An agent's direct edits can be swept into a snapshot, listed as changed
  outside epicenter, rather than claimed by a call.
- A snapshot reverts as a unit; reverting one call among several is a
  hand edit.
- Plain `write` is last-write-wins. An action that reads a file and writes it
  back with `write` can lose a change made meanwhile.
- An action can overwrite an edit not yet in history. What brings it back is
  the last snapshot, as for any program that writes the folder.
- History is as good as its snapshots. An app that nothing snapshots and
  nothing syncs has none.
- `writeOnly` means only what JSON Schema says; nothing in `epicenter` reads it.
- A test run of a write in an agent's worktree commits there; run tests in a
  temporary `HOME`.
- A run killed before it answers leaves its writes pending, and its call
  unlogged, so the next snapshot lists them as changed outside epicenter.

## Considered alternatives

- **Every writer commits exactly what it wrote (this record's first draft,
  built 2026-11-09).** Machinery on every write for the least frequent writer;
  the race found a bug inside it.
- **A commit per call naming exactly its changes (pathspec commits, or each run
  staged on its own).** Claims an attribution it cannot know, since a path an
  action wrote may also hold a hand edit, and needs path filtering for ignored
  paths and for paths created and then deleted.
- **Holding a lock for the run (this record from 2026-11-10 to 2026-11-11).**
  A slow action blocks every other write to its app, and the commit after it
  still takes what others left in the folder.
- **Rerunning a call on conflict by its MCP annotations.** Annotations are
  hints to clients, not contracts; `idempotentHint` cannot make a rerun safe.
- **Only epicenter writes the folder.** Unenforceable: an agent, an editor, and
  `node:fs` all write it.
- **Each action in its own checkout, landing by fast-forward.** Actions see only
  committed files, ignored paths need routing, and a spike's linked `.cache/`
  was committed and then destroyed.
- **`sync` in an action's context.** Puts the network inside actions; it can be
  added later without breaking an app, and not removed.
- **Undo after a throw (ADR-0842 as built).** Erases a concurrent edit.
