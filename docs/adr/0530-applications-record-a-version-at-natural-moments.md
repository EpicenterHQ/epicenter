# 0530. Applications record a version at natural moments

- **Status:** Proposed
- **Date:** 2026-10-13
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), withdrawing "only" from "a commit happens only when sync checkpoints before it runs, or when a person saves a version". Saves still never request commits, and the folder package keeps no automatic commit machinery.
- **Unbuilt:** the checkpoint call in every editing application; the choice of moments for each; periodic checkpoints.

## Context

ADR-0529 removed automatic commits, because edits are written as they are
made and a commit per write fills history with near-identical versions. It
also removed the safety net those commits gave: an edit made after the last
version exists only in its file. When an agent or another program damages
that file before the next Sync or Save version, Git holds nothing in between.

## Decision

**An application records a version with `folder.git.commit()` at moments the
person's work naturally pauses.** Examples: leaving an item for another, the
page becoming hidden, and closing the application. The application waits for
its writes to land first, as Save version does. A checkpoint that finds nothing
changed makes no commit, and one that fails is not retried; the next moment
tries again.

The folder package gains no timer, request counter, or worker. Each moment is
the application's, so the application decides which moments count and the
folder's history machinery stays as ADR-0529 left it.

**Periodic checkpoints come later, on the same call.** A commit some time after
the last write, while the application stays open, covers damage that lands
while the person keeps working in one item. It is a scheduling choice in the
application or a shared helper, built once the moments above prove the call
and its cost.

## Consequences

History gains a version per pause rather than per write, so it stays readable
and still covers most damage between Syncs. Damage that lands while an
application sits open on one item, with no pause, is not covered until
periodic checkpoints exist. Every checkpoint is a whole-folder commit, so it
records other writers' changes too, as Save version and Sync already do.

## Considered alternatives

- **A commit per save** (main's ADR-0528 before it was set aside, and
  ADR-0505). Fills history with near-identical versions once every edit is
  written, and needs the coalescing worker in both owners.
- **Periodic checkpoints in the folder package now.** ADR-0529 rejected the
  timer, coalescing, and close behavior they need in both owners; an
  application-level schedule can be tried first.
