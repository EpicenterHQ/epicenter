# 0850. An action changes files, and whoever knows the intent commits them

- **Status:** Proposed
- **Date:** 2026-11-09 (first drafted 2026-11-08 as "Every writer commits exactly what it wrote")
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at "an action is a commit": a run makes no commit of its own, nothing is undone, exit codes are 0, 1, and 2, and a refusal to run is `{ error: { name, message, next? } }` without `code`.
- **Relates:** [ADR-0851](0851-an-app-with-history-has-one-git-remote-its-meeting-point-and-backup.md) (`epicenter sync`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that write a folder), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (LFS), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (what each path becomes), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (a commit per write through `serve`).
- **Unbuilt:** `epicenter serve`'s commit after each write it runs (ADR-0864). Built: `folder.commit`, the answer as `{ returned }`, `{ threw }`, or `{ error }` with exit codes 0, 1, and 2, and the deletions under Consequences. The first draft is recoverable at `9943c668db`.

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

## Decision

**A run commits nothing on its own.** An action writes through `folder`; what
it leaves is uncommitted until something commits it.

**Whoever knows the intent commits.**

```txt
the action        await folder.commit('Add 12 words')   its author decided one run is one change
epicenter serve   capture: captures set dune            one write a client asked for (ADR-0864)
an agent          git commit -m '…'                      after a sequence it understands
anyone            epicenter sync                         everything left (ADR-0851)
```

**`folder.commit(message)` commits everything changed in the app's folder and
nothing outside it.** From the app's folder it runs `git add -A -- .` then
`git commit -m <message> -- .`. Other changes inside the folder, staged or not,
are included. It takes no paths; a `{ paths: string[] }` option can be added
when an app needs one, without changing any caller. An app inside a larger repository (`~/Code/vault/recipes/`)
commits into that repository and touches nothing else in it. Before staging it
checks that this computer has Git LFS's filter (`git config filter.lfs.process`)
when `.gitattributes` routes a path through it, and otherwise throws
`run: git lfs install`, since Git without the filter would store the whole file
(ADR-0856). When Git's `index.lock` is held, it retries for up to 2 seconds,
then throws Git's message. It never pushes; only `epicenter sync` touches a
remote.

**Running an action needs nothing from Git.** An app need not be a repository,
or the top of one. `folder.commit` outside any repository throws Git's own
error. `epicenter new` makes a repository.

**`epicenter` does nothing Git already does.** It runs Git's porcelain and
passes on Git's messages: no Git objects of its own, no temporary index, no
compare-and-swap, no lock held across commands.

**`folder` is a convenience, not a sandbox.** Paths stay normalized and `.git`
stays refused (`normalizePath`). Writes are recorded nowhere and refused for
nothing; `folder.path` is the folder. An action can import `node:fs`, so
`folder` promises no more than that.

**Runs of one app do not take turns.** Two runs at once are two writers, like an
editor and an agent. An app that keeps one record per file (`words/{stem}.md`)
loses nothing to a second writer; one that keeps a single file
(`reading/2026.csv`) can lose an update, as it can to any program.

**A run answers what the action did.**

```txt
{ "returned": <value> }                       exit 0
{ "threw": { "message", "thrown"? } }         exit 1, also when the run ended without an answer
{ "error": { "name", "message", "next"? } }   exit 2, nothing ran
```

`--json` prints it and MCP returns it as `structuredContent`. Each run still
happens in its own process (`child.ts`), so nothing an action prints reaches the
answer.

## Consequences

- Deleted, about 900 of the CLI's 2,600 lines (estimated): `commit.ts`, the
  write log and refusals in `disk.ts`, `file-lock.ts`, the path states and
  refusal reasons in `report.ts`, the subject and body built in `run.ts` with its
  `writeOnly` filter, the `NotRepository`, `MidMerge`, and `LockFailed` errors,
  the head before and after in `child.ts`, `packages/cli/scripts/race.ts`, and
  the tests of all of these.
- An action can overwrite an uncommitted edit. What brings it back is the last
  commit, as for any program that writes the folder.
- History is as good as its committers. An app that nothing commits and nothing
  syncs has none.
- `writeOnly` means only what JSON Schema says; nothing in `epicenter` reads it.
- A test run of an action in an agent's worktree commits only if the action
  calls `folder.commit`.

## Considered alternatives

- **Every writer commits exactly what it wrote (this record's first draft,
  built 2026-11-09).** Machinery on every write for the least frequent writer;
  the race found a bug inside it.
- **Each action in its own checkout, landing by fast-forward.** Actions see only
  committed files, ignored paths need routing, and a spike's linked `.cache/`
  was committed and then destroyed.
- **A snapshot ref before each run, then `git commit --only`.** Keeps a commit
  per action; the refs pile up, and it protects more than a shell does.
- **`sync` in an action's context.** Puts the network inside actions; it can be
  added later without breaking an app, and not removed.
- **A lock per app's runs.** Only `epicenter`'s runs take it, so it is no
  guarantee against the other writers.
- **Undo after a throw (ADR-0842 as built).** Erases a concurrent edit.
