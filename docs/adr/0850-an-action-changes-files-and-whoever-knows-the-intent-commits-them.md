# 0850. An action changes files, and whoever knows the intent commits them

- **Status:** Proposed
- **Date:** 2026-11-09 (first drafted 2026-11-08 as "Every writer commits exactly what it wrote")
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md) at "an action is a commit": a run makes no commit of its own, nothing is undone, exit codes are 0, 1, and 2, and a refusal to run is `{ error: { name, message, next? } }` without `code`. [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) at how a commit leaves out `*.local`: the app's `.gitignore` does, and a commit refuses one it lets through.
- **Relates:** [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (`epicenter sync`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (programs that write a folder), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (LFS), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (what each path becomes), [ADR-0859](0859-an-action-changes-the-folder-or-the-world-and-a-world-verb-is-safe-to-repeat.md) (the folder and the world), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (the snapshots `serve` takes).
- **Amended:** 2026-11-10: a write commits itself, named for the call, however it arrives, and writes to one app take turns; `folder.commit` is removed. 2026-11-11: runs never commit, history is snapshots, a change that depends on what it read says so with `folder.update`, and the write lock is deleted. The commit per call held a lock for the whole run, so a slow action blocked every other write to its app, and it still swept a hand edit pending in the folder into the call's commit under the call's name. 2026-11-11, later: each writer gets its own commit boundary. A call commits exactly the paths it wrote; an agent names its own edits with `epicenter sync <app> -m`; `serve` backs up on a 5-minute clock instead of guessing when outside edits have gone quiet, and pushes only on that clock. The app's `.gitignore` alone keeps `*.local` out of commits, and a commit refuses one it lets through. 2026-11-11, last: only `sync` and `serve`'s clock push, by one rule (ahead of the tracking ref, or none yet), so `undo` no longer pushes; a snapshot's message is its subject alone, and `history` reads each commit's paths from Git; a failed commit names its next step; `update` snapshots before it merges.
- **Built:** `folder.update` (`packages/cli/src/disk.ts`, `packages/app/src/memory.ts`), commits (`packages/cli/src/snapshot.ts`), the runs that report their writes (`run.ts`), the call's commit from the command line and `serve`, `sync` and `sync -m`, `serve`'s backup clock (`http.ts`), the app's status, and the answer as `{ returned }`, `{ threw }`, or `{ error }` with exit codes 0, 1, and 2. The first draft is recoverable at `9943c668db`; the commit per call and its lock at `965f4873c4`; snapshots with `Also changed:` and the quiet check at `3e6f1fca38`.

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

The first amendment of 2026-11-11 then made every commit a snapshot of
everything pending, named for the call when there was one, with other paths
under `Also changed:`. That still put a hand edit in the call's commit, so
undoing the call undid the edit too. And `serve` guessed when outside edits
were finished by checking that their sizes and modification times had not
changed for a minute. No such moment exists: an editor saves whenever it
likes, and an agent's sequence of edits is done when the agent says so.

Git needs a commit boundary, and only a writer that knows its intent can
supply one. There are three kinds of writer, and each has a different one.

## Decision

**Each writer commits its own boundary.**

```txt
a call             Epicenter sees it and its paths: its commit holds exactly the
                   paths it wrote, named for the call
an agent           knows its intent, and Epicenter cannot see it: it commits its
                   own edits, with `epicenter sync <app> -m "<what it did>"` or
                   `git commit`
an editor          no boundary exists (Obsidian, a text editor): serve's clock
                   commits what is pending as `<app>: changed outside epicenter`,
                   for backup
```

**A call's commit holds exactly the paths it wrote.** Each run that is not
read-only reports its call (`tasks: add Water the plants`), the paths it wrote
through `folder`, and whether it threw. The parent that started it (the command
line, or `serve` before it answers) runs one `git status` of those paths, which
drops what is unchanged, ignored, or created and then deleted; then `git add -A`
and `git commit` of what is left, with each path given literally. Every other
pending or staged change stays as it was. The subject is the call, or
`<call> (threw)` when the run threw, and there is no body. A run whose paths
are all unchanged makes no commit.

**A snapshot with no call takes everything pending.** `epicenter sync`, the
first step of `epicenter undo` and of `epicenter update`, and `serve`'s clock
commit everything pending in the app's folder and nothing outside it: `git add -A` and `git commit` with
the pathspec `.`. The subject is `<app>: changed outside epicenter`, or
`<app>: <message>` from `epicenter sync <app> -m <message>` (one line), with
no body: `epicenter history` reads every commit's paths from Git
(`git log --name-only`), so a snapshot need not list them. An app inside a
larger repository (`~/Code/vault/recipes/`) commits into that repository and
touches nothing else in it.

**`serve` backs up on a clock.** When it starts, every 5 minutes, and when it
stops (waiting at most 10 seconds), `serve` does for each app what
`epicenter sync <app>` does: a snapshot of what is pending, then a push to
`origin`, only when the branch is ahead of its `origin` tracking ref or there
is none yet. A call's commit waits for the next tick to be pushed. A tick
skips an app while a call to it runs, and a call waits for the app's snapshot
already running before its run starts, so a snapshot never takes part of what
a call writes under another name. A failure is logged on stderr once until it
changes. `sync` from the command line
pushes at once by the same rule, and no other command pushes (ADR-0851).

**The app's `.gitignore` owns what never leaves this computer.** The template
and every starter ignore `*.local` and `*.local.*` (ADR-0858). Before staging,
a commit refuses when what it would take holds such a file, naming it and the
app's `.gitignore`; it never filters one out silently.

Every commit checks, before staging, that this computer has Git LFS's filter
(`git config filter.lfs.process`) when `.gitattributes` routes a path through
it, and otherwise stops with `git lfs install` as the next step (ADR-0856).
It refuses while a merge, rebase, revert, or cherry-pick is underway, with
`git -C <folder> status` as the next step. When Git's `index.lock` is held, it
retries for up to 2 seconds. A commit failure changes no action answer: its
caller reports why and the failure's next step, else `epicenter sync <app>`.
Status derives the pending path count from `git status` and the unpushed
commit count from `origin/<branch>..HEAD` when that tracking ref exists.

**A change that depends on what it read uses `folder.update`.**
`folder.update(path, change)` reads the file, calls `change` with its text
(`undefined` when there is none), and writes what `change` returns only if the
file is still what `change` saw; otherwise it starts over, with a random wait
of at most 64 ms, and after 10 seconds of that throws `{ name: 'Changed' }`. A
`change` that throws writes nothing. It writes the new text beside the target
under a random name, then claims the text it replaces with a claim file named
for that text, which only one update can make, so two updates of the same text
never both write; rereading before the rename alone lost 5 of 50 concurrent
`set`s of one file, since another process can rename between the reread and
the rename. The claim is held only to check, rename, and release, so one older
than 2 seconds is taken for one a crash left. Every collection write (`add`,
`set`, `edit`, and the first write of a one-file collection) goes through it,
so the action, by way of its collections, owns the correctness of a
read-modify-write. `folder.write` stays a plain write, and
the last one wins.

**Annotations describe a tool to its clients; the runner enforces only
`readOnlyHint`.** A read-only run's writes through `folder` throw before
doing anything, except to a `.local` path (ADR-0870), and it never commits.
`destructiveHint`, `idempotentHint`, and `openWorldHint` are for MCP clients.

**Running an action needs nothing from Git.** An app need not be a repository,
or the top of one; a folder in no repository is never committed. `epicenter new` makes a repository.

**`epicenter` does nothing Git already does.** It runs Git's porcelain and
passes on Git's messages: no Git objects of its own, no temporary index, and
no lock held for a run. Git's `index.lock` serializes commits; `update`
serializes changes to one file with a compare-and-swap guarded by its claim
file, held only to check and rename.

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

## Why each layer is here

- `folder.update` and a collection's `update`: two writers of one file at once
  both land, without a lock. Each writes only over the text it read, and reads
  again when another writer got there first.
- A call's commit of exactly its paths: history says which call changed which
  files, and undoing one call undoes only that call. The runner can do this
  because it knows the boundary: the run reports its paths.
- `sync -m` for agents: a writer that knows its intent, but that Epicenter
  cannot see, declares it, and the snapshot is backed up in the same command.
  A plain `git commit` works too.
- The ignore file as the one owner of `*.local`: every Git tool honors it, an
  agent's own `git commit` and the person's alike. A commit here only checks,
  so a `.gitignore` that lacks the lines is found, not hidden.
- The clock: edits with no boundary would otherwise never reach history or the
  backup. Its interval is how old an unbacked change can get, not a guess at
  what an edit means.
- A push-only backup, on the clock and from `sync`: a copy off this
  computer that never fetches, merges, or force pushes, so it never changes the
  home (ADR-0851).
- Derived status: the pending and unpushed counts come from Git each time, so
  they are never stale, however a problem is fixed.
- Undo as `git revert`: one commit is one intent, so reverting it is a new
  commit that loses nothing, and undoing the undo brings it back.
- The underway refusal: a commit never takes half of a merge, rebase, revert,
  or cherry-pick.

## What is not here and why

- No lock: Git's `index.lock` serializes commits, and `folder.update`
  serializes changes to one file. A lock per app made one slow action block
  every other write.
- No queue beyond one commit at a time per app in a process, and one backup at
  a time in `serve`: there is nothing to replay.
- No call log: the call's paths travel in the run's report and end in its
  commit.
- No stored error: status and each failure are derived again from Git.
- No quiet detection: it guessed a boundary that does not exist.
- No fetch or rebase: the backup is push-only, and the home never changes
  because of it.

## Consequences

- No lock: two writes to one app run at once, and a slow action blocks no one.
- Two calls at once on different files make two commits, each with its own
  file.
- A throw's writes are committed under the call, marked `(threw)`, so
  `epicenter undo` reverts them as one.
- A hand edit to a file a call later writes lands in the call's commit. The
  call's paths are known; whose bytes are in them is not.
- An agent's direct edits stay pending until it commits them, `sync` runs, or
  `serve`'s next tick, which names them changed outside epicenter.
- While `serve` runs, everything is in the backup within 5 minutes; a call's
  commit is not pushed sooner.
- Plain `write` is last-write-wins. An action that reads a file and writes it
  back with `write` can lose a change made meanwhile.
- An action can overwrite an edit not yet in history. What brings it back is
  the last commit, as for any program that writes the folder.
- An app whose `.gitignore` lacks `*.local` gets no commit from Epicenter that
  would take one, and says why, until the line is added.
- A test run of a write in an agent's worktree commits there; run tests in a
  temporary `HOME`.
- A run killed before it answers leaves its writes pending, and its call
  unreported, so the next snapshot lists them as changed outside epicenter.

## Considered alternatives

- **Every writer commits exactly what it wrote (this record's first draft,
  built 2026-11-09).** Machinery on every write for the least frequent writer;
  the race found a bug inside it.
- **A snapshot of everything pending at each call (this record from the first
  2026-11-11 amendment until the second).** Names a hand edit for the call it
  happened to precede, and undoing the call undoes the edit with it.
- **Quiet detection: snapshot outside edits once their sizes and modification
  times stop changing (built 2026-11-11).** Guesses a boundary that does not
  exist; an editor saves whenever it likes, and only an agent knows when its
  sequence is done.
- **A snapshot before and after each call.** Labels concurrent calls wrongly:
  a second call's writes land between the first call's two snapshots.
- **Excluding `*.local` with the commit's own pathspec (ADR-0868 as built).**
  Only Epicenter's commits honored it; an agent's `git commit -a` or the
  person's took the file. The ignore file is honored by every Git tool.
- This record's earlier rejection of a commit per call naming exactly its
  changes no longer holds. It said such a commit claims an attribution it
  cannot know and needs path filtering for ignored paths and paths created and
  then deleted. The run now reports its paths, so the attribution is known up
  to the limit above, and one `git status -- <paths>` does the filtering.
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
