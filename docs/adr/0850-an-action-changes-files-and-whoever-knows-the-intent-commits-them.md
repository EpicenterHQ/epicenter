# 0850. An action changes files, and whoever knows the intent commits them

- **Status:** Proposed
- **Amended by:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on the action answer and its CLI exit code.
- **Date:** 2026-11-09 (first drafted 2026-11-08 as "Every writer commits exactly what it wrote")
- **Supersedes:** [ADR-0848](0848-the-runner-owns-only-what-an-action-wrote.md): recorded writes and run phases.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md): a run makes no commit and undoes no files; exit codes are 0, 1, and 2.
- **Relates:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): the source's root layout and checkpoint boundary.
- **Built:** `folder.update`, the container lock, Result presentation, and the serve-owned checkpoint clock in `packages/cli/src/`.
- **Unbuilt:** the device filing protocol remains separate work. The live history import and cutover are complete.

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

**A call owns the container lock from its first folder write until it ends.**
The lock is a kernel flock on `apps/<app>`, not `code/` or a lock file. A call
waits at most 30 seconds for another writer. Read-only calls take no lock,
including permitted `.local` writes. Closing the descriptor or exiting
releases it. Fetch first and write last to avoid holding up another write.

**One checkpoint records pending code and records at the root.**
`epicenter checkpoint [-m <message>]` takes `hold(root)`, stages included files,
and consumes the shared index in one commit. Its subject is `checkpoint` or
the supplied message. A home runs it on a schedule through a routine
([ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md)); `serve` runs none of its own. A scheduled
checkpoint samples the working tree; it does not claim that an action or agent finished.
The root lock is independent of the app lock, so a checkpoint can capture
part of a running action.

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
`folder.update(path, change)` reads the text, calls `change`, and replaces only
what it read. An outside editor can change it meanwhile, so it retries the
change against the newer text. After ten attempts it throws
`ActionError.Changed`. A callback that throws writes nothing. Collection
writes use this method. `folder.write` remains last-write-wins.

**Annotations describe tools, and the runner enforces only `readOnlyHint`.**
A read-only run's folder writes throw except on a `.local` path under `data/`.
`destructiveHint`, `idempotentHint`, and `openWorldHint` remain MCP hints.

**Running an action needs nothing from Git.**
`folder.path` remains the real app container. Writes through `folder` stay
under `data/` and refuse `.git*` segments. An action may use `node:fs` or a
library; this is a convenience, not a sandbox. Only a folder write obtains
the call's lock.

**A run answers what the action did.**

```txt
{ "returned": <value> }                      exit 0
{ "threw": { "message", "thrown"? } }        exit 1
{ "error": { "name", "message", "next"? } }  exit 2, nothing ran
```

The receiving process runs the action. On the command line, its prints go
to stderr while stdout holds the answer. MCP returns the same envelope as
`structuredContent`.

## Consequences

- Named commits describe an agent's finished change; checkpoints record
  included files without attributing them to calls.
- The shared branch and index affect every app. A checkpoint commits staged
  work along with other pending files.
- Root checkpoints can split an action's writes or capture a partial code edit.
- An action that calls its own app after writing waits on its own lock.
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
- **Wait for file timestamps to stop changing.** An editor's save does not
  identify the end of an agent's change.
- **Use a private checkpoint index.** It creates a second view of the person's
  staged changes rather than making the shared index explicit.
- **Rollback after a throw.** It can erase a concurrent edit.
