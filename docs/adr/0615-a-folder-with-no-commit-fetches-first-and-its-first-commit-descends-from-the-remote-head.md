# 0615. A folder with no commit fetches first, and its first commit descends from the remote head

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) at step 1, "It records saved files in a checkpoint commit (ADR-0529), so the local head is `L`, and fetches the remote head `R`": a folder whose branch has no commit fetches before it records anything, and its first commit is made against `R`.
- **Relates:** [ADR-0609](0609-a-new-data-folder-copies-its-apps-template-once.md) commits a new folder's template copy as its first commit, which would leave no folder without a commit; see the open decision below.

## Context

`runSync` in `packages/folder/src/git/history.ts` began every run with a
checkpoint (`commitNow`), then fetched. A folder whose branch had no commit
got a parentless first commit from that checkpoint, and the run that made it
was allowed to merge with an unrelated remote over an empty base, into a
merge commit with two parents, two roots in one history. The allowance was
one variable, `unrelated`, true only when this run's checkpoint was
`committed` with no parent.

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
| a head `R` | `recordFirst`: the folder's files, captured as a tree no commit holds, merged with `R`'s tree over an empty base by `mergeFirstCommit`, this folder the writer acting, as a commit `C` whose one parent is `R`; published, then pushed |
| a head `R` whose tree already holds the merge | none: the folder takes `R` as it is |

`recordFirst` captures, merges, and publishes in one hold of the backend's
protection (`exclusive`), so no other commit, such as a version a person
saves, lands between the capture and the branch moving to `C`. `C` is a
checkpoint, not a merge commit: once the branch holds it, Sync sends it as
it sends any local commit ahead of the remote. ADR-0576's rule that a merge
commit is pushed before anything here changes still holds, since `C` is not
one. A run cut off after the publish, or a push that fails, leaves `C` as
the local head, and the next Sync pushes or merges it like any other.

The merge is `mergeHistories`' own (`git/merge.ts`), so a path both added
differently merges by unit, and each unit `R` lost is an `Overrode:` trailer
naming `R`. With no base nothing is deleted, so the folder's files never lose
a whole file. A remote file that would land where this folder has a file
`.gitignore` excludes stops Sync as `Blocked`, before anything is written or
sent.

**After the first commit, every merge has a base.** The run-local allowance
is deleted. Histories that share no commit are `Unrelated`, writing nothing,
unless the caller passes `allowUnrelatedHistories`, which a person grants:
Todos' "Combine them" and the CLI's hidden `sync --allow-unrelated`.

**`refs/epicenter/publishing` records the tree the files began at.** The
marker commit's parents stay `[from, to]`, or `[to]`; its tree is now the
files' tree when the publish began: `from`'s, the captured tree of a folder
with no commit, or the empty tree. An interrupted first publish resumes
against what the files held.

**Open decision for the owner: ADR-0609's template copy stays uncommitted
until the first Sync.** ADR-0609 commits a new folder's template copy as its
first commit. Under that rule no folder is ever without a commit, so a
second device's new folder always has a history of its own and meets the
first device's remote as `Unrelated`. This record proposes that the copy is
written as files only, and enters history through the first Sync like any
other file. ADR-0609 is unbuilt, so nothing implements either reading yet.

## Consequences

- A new folder syncing offline is never stranded: it holds no commit until
  a fetch has answered.
- Every history a folder makes has one root, the first device's, unless a
  person agreed to combine two.
- A folder with no commit records its files only when a Sync reaches the
  remote. A person who saves a version offline (`git.commit()`) gives the
  folder a history of its own: an unrelated remote is then `Unrelated` until
  combined.
- A same-named folder still joins an existing remote without asking, as one
  commit on its head rather than a second root. What the remote lost is in
  the trailers, and its version stays in history as the parent.
- A remote with no branch that gains one between the fetch and the push
  rejects the push of the folder's root commit, and the retry meets
  `Unrelated`, as before this record.
- Markers written before this change are not read as such: this is a clean
  break, and no released build left one.

## Considered alternatives

- **Keep the checkpoint first, and remember that the first fetch never
  happened.** A persistent marker was tried and reverted in #2580: one more
  piece of state that can disagree with the branch, which already says
  whether a commit exists.
- **Overlay the folder's files on `R`.** A path both sides added would be
  this folder's whole file, and the remote's units would vanish without a
  trailer. The three-way merge already settles a path both added.
- **Push `C` before publishing it, as a merge commit is.** While the branch
  still has no commit, any retry (an edit the publish finds, a close between
  push and publish) captures again and merges the files with `C` over an
  empty base, merging text a second time and undoing deletes.
- **Keep the two-parent merge for a first commit.** It is what joined two
  roots without consent, and its allowance existed only for the run that made
  the root.
