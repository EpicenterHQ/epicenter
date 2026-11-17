# 0850. An action changes files, and whoever knows the intent commits them

- **Status:** Proposed
- **Amended by:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on the action answer and its CLI exit code.
- **Date:** 2026-11-09 (first drafted 2026-11-08 as "Every writer commits exactly what it wrote")
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md): a run makes no commit and undoes no files; exit codes are 0, 1, and 2.
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on the app lock: its reason, that read-modify-write calls must take turns, is met by one process running every action ([ADR-0936](0936-one-serve-per-home-runs-every-action.md)), where `folder.update` compares and replaces a file with nothing running between.
- **Relates:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): the source's root layout and checkpoint boundary.
- **Built:** `folder.update`, Result presentation, and no lock on an app or a call, in `packages/cli/src/`.
- **Unbuilt:** the device filing protocol remains separate work.

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

**Actions change files and leave Git to checkpoints or a writer's named commit.**
A call makes no snapshot, commit, or code trailer. Its answer says what the
action returned or threw, not whether Git succeeded. A throw leaves the files
already written in place.

**An app has no lock.** Calls, the person and their agents write the same
files, and only calls could take a lock, so a lock per app made actions take
turns with each other and never with the writer most likely to collide. Each
folder write replaces its file in one step, so no reader sees half a file. A
change that depends on what it read uses `folder.update`. One process runs
every action (ADR-0936), and an update has no pause between its read and its
replace, so no second action can come between them. Epicenter gives an
app no lock: two calls of one action both run, and an app for which that is
wrong says so in its own records.

**One checkpoint records pending code and records at the root.**
`epicenter checkpoint [-m <message>]` stages included files and consumes the
shared index in one commit. Its subject is `checkpoint` or the supplied
message. A home runs it on a schedule through a routine
([ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md)); `serve` runs none of its own. A scheduled
checkpoint samples the working tree; it does not claim that an action or agent
finished, so it can capture part of a running action. It takes no lock of its
own: Git's index lock is the only one, and a checkpoint that loses that race
reports nothing to commit.

A checkpoint defers while Git is resolving a merge, rebase, revert, or
cherry-pick. It retries `index.lock` briefly before deferring. It refuses
local credentials Git would include, included embedded repositories,
gitlinks, ignored records under `apps/*/data`, and LFS files without the
filter. The root `.gitignore` is what every Git writer reads. Tracked local
credentials must be removed from the index; an ignore rule cannot hide them.

The optional private root `origin` receives ordinary pushes, with a
ten-minute deadline and no pull, merge, rebase, or force. A pass with no new
commit can retry an outstanding push. App listings carry no Git status.

**A change that depends on what it read uses `folder.update`.**
`folder.update(path, change)` reads the text, calls `change` once, and replaces
the file, with no other update between. It does not look at the file again:
a writer outside Epicenter, such as an editor, is not guarded against. A
callback that throws writes nothing. Collection
writes use this method. `folder.write` remains last-write-wins.

**Annotations describe tools, and the runner enforces none of them.**
`readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are
MCP's hints. An action states them, serve forwards them to MCP clients, and a
client decides from them how careful to be. A read-only action that writes is
the action's own mistake; no call carries a fact about whether it may write.

**Running an action needs nothing from Git.**
`folder.path` remains the real app container. Writes through `folder` stay
under `data/` and refuse `.git*` segments. An action may use `node:fs` or a
library; this is a convenience, not a sandbox. No folder write takes a
lock.

**A call answers what the action did.** The answer and its exit codes are
[ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md)'s:
`{ data, error }`, where `error.kind` is `returned` or `fault` (exit 1) or
`refused` (exit 2, nothing ran). The receiving process runs the action. On the command line, its prints go
to stderr while stdout holds the answer. MCP returns the same envelope as
`structuredContent`.

## Consequences

- Named commits describe an agent's finished change; checkpoints record
  included files without attributing them to calls.
- The shared branch and index affect every app. A checkpoint commits staged
  work along with other pending files.
- Root checkpoints can split an action's writes or capture a partial code edit.
- Two calls of one app can interleave their writes. Epicenter gives a call
  whose several files must stay consistent with each other no lock to take.
- A long action can write its progress as it goes; nothing it holds blocks
  another call of its app.
- A direct edit or interrupted run stays pending until a commit records it.
  No rollback restores an overwritten file automatically.
- Tests use temporary homes and synthetic data rather than a live checkout.

## Considered alternatives

- **A commit per action.** It cannot identify an agent's direct-edit intent
  and can include somebody else's concurrent edit.
- **Track each written path and commit only those paths.** It adds a write
  report, path filtering, and undo attribution that direct file edits bypass.
- **Hold the app lock for the whole run.** A slow service request blocks all
  other writes before there is any file change to coordinate.
- **Hold the app lock from a call's first write until it ends.** It was
  built, and it outlived its reason: it made calls take turns while each call
  made a commit. Once checkpoints took over commits it protected only calls
  from each other, not from the person's own edits. Apps worked around it:
  Vocab and Zhongwen saved a turn only after the model finished, and an
  action that wrote and then called its own app waited on itself.
- **Wait for file timestamps to stop changing.** An editor's save does not
  identify the end of an agent's change.
- **Use a private checkpoint index.** It creates a second view of the person's
  staged changes rather than making the shared index explicit.
- **Rollback after a throw.** It can erase a concurrent edit.
