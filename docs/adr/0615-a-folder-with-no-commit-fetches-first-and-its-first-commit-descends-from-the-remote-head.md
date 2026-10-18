# 0615. A folder with no commit fetches first, and its first commit descends from the remote head

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at step 1, "It records saved files in a checkpoint commit (ADR-0529), so the local head is `L`, and fetches the remote head `R`": a folder whose branch has no commit fetches before it records anything, and its first commit is made against `R`.

## Context

`runSync` in `packages/folder/src/git/history.ts` began every run with a
checkpoint (`commitNow`), then fetched. A folder whose branch had no commit
got a parentless first commit from that checkpoint, and the run that made it
was allowed to merge with an unrelated remote over an empty base, into a
merge commit with two parents, two roots in one history. The allowance was
one variable, `unrelated`, true only when this run's checkpoint was
`committed` with `parent === undefined`.

Two things broke on it:

- A first Sync whose fetch failed kept its root commit. The retry's
  checkpoint was `unchanged`, so `unrelated` was false, and every later Sync
  answered `Unrelated`. An app's own folder always had something to commit,
  its `.gitignore`, so a new folder offline on its first Sync was stranded.
- Two folders under one name, connected to one remote, were joined by a
  merge with two roots, and nothing asked.

## Decision

**A folder whose branch has no commit (`backend.readBranch()` answers
`undefined`) fetches before it records anything.** The condition is the
branch, never whether a fetch ever succeeded, so a failed fetch leaves
nothing behind and the next Sync starts the same way.

| Remote | The first commit |
| --- | --- |
| no branch | the checkpoint's root commit, pushed |
| a head `R` | `mergeFirstCommit`: the folder's files, captured as a tree no commit holds (`captureFirst`), merged with `R`'s tree over an empty base, this folder the writer acting, as a commit whose one parent is `R`, pushed, then published |
| a head `R` whose tree already holds the merge | none: the folder takes `R` as it is |

The merge is `mergeHistories`' own (`git/merge.ts`), so a path both added
differently merges by unit, and each unit `R` lost is an `Overrode:` trailer
naming `R`. With no base nothing is deleted, so the folder's files never lose
a whole file. A remote file that would land where this folder has a file
`.gitignore` excludes stops Sync as `Blocked`, before anything is sent.

**After the first commit, every merge has a base.** The run-local allowance
is deleted. Histories that share no commit are `Unrelated`, writing nothing,
unless the caller passes `allowUnrelatedHistories`, which a person grants:
Todos' "Combine them" and the CLI's hidden `sync --allow-unrelated`.

**`refs/epicenter/publishing` records the tree the files began at.** The
marker commit's parents stay `[from, to]`, or `[to]`; its tree, which nothing
read before, is now the files' tree when the publish began: `from`'s, the
captured tree of a folder with no commit, or the empty tree. An interrupted
first publish resumes against what the files held.

## Consequences

- A new folder syncing offline is never stranded: it holds no commit until
  a fetch has answered.
- Every history a folder makes has one root, the first device's, unless a
  person agreed to combine two.
- A folder with no commit records its files only when a Sync reaches the
  remote. A person who wants a version offline saves one with
  `git.commit()`, and from then on the folder has a history of its own: an
  unrelated remote is `Unrelated` until combined.
- A same-named folder still joins an existing remote without asking, as one
  commit on its head rather than a second root. What the remote lost is in
  the trailers, and its version stays in history as the parent.
- A marker written before this change names `to`'s tree, so resuming it
  would see nothing to write. No such marker is migrated.

## Considered alternatives

- **Keep the checkpoint first, and remember that the first fetch never
  happened.** A persistent marker was tried and reverted in #2580: one more
  piece of state that can disagree with the branch, which already says
  whether a commit exists.
- **Overlay the folder's files on `R`.** A path both sides added would be
  this folder's whole file, and the remote's units would vanish without a
  trailer. The three-way merge already settles a path both added.
- **Keep the two-parent merge for a first commit.** It is what joined two
  roots without consent, and its allowance existed only for the run that made
  the root.
