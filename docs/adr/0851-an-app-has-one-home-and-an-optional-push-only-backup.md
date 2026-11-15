# 0851. An app has one home and an optional push-only backup

- **Status:** Proposed
- **Date:** 2026-11-08 (revised 2026-11-11: one home replaces copies meeting at `origin`)
- **Supersedes:** [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md): one home removes note merging between devices.
- **Amends:** [ADR-0842](0842-an-action-is-a-commit-and-the-repository-is-the-sync.md): checkpoints record pending root files and push without pulling or rebasing.
- **Relates:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md): one private root repository and its checkpoint operation.
- **Built:** root checkpoints in `packages/cli/src/checkpoint.ts`, the manual command, and serve's existing clock.
- **Unbuilt:** a program's offline clone protocol under [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md).

## Context

Earlier designs let devices edit copies that pulled from a meeting point and
merged notes. One home removes those unattended merges. Per-app repositories
then multiplied private backups even though an agent changes code and records
together. The source and live Epicenter now use a single root repository.

## Decision

**An Epicenter lives on one home computer.**
Its code, records, and Git history live there. Phones and agents without the
files call its actions. Programs and agents on the home may edit files directly.

**The root's optional origin is a private push-only backup.**
The person chooses its host: GitHub, another Git service, SSH, or a disk. It
receives every app's records. With no origin, local actions and checkpoints
still work. App listings show no per-app backup status.

**A checkpoint commits once and pushes only to origin.**
`epicenter checkpoint [-m <message>]` records included pending files and the
shared index. `serve` runs the same operation at startup, five minutes after
each scheduled pass finishes, and on stop. It waits at most ten seconds on
shutdown. No separate scheduler is installed.

A push runs only when the branch is ahead of its locally known origin ref or
has no tracking ref. It has a ten-minute deadline. Nothing pulls, rebases,
autostashes, or force-pushes the live tree. An idle pass retries an outstanding
push. Before pushing, the checkpoint refuses unpushed history containing local
credential additions.

**A divergent backup is reported without overwriting it.**
A non-fast-forward refusal leaves the commit local and the remote unchanged.
The next step is inspection: `git -C <root> fetch origin`, then
`git -C <root> log HEAD..origin/<branch>`. The manual command exits 1; serve
logs an unchanged failure once and clears it after success. The ahead count
uses local refs; a checkpoint does not fetch them.

**Restore one root clone, then install each app's code.**
`epicenter init --from <url|path> <folder>` requires a top-level
`EPICENTER.md`. It clones once and installs runnable apps under `apps/*/code`.
Local credentials must be recreated. Recovery within the clone selects
`apps/<app>/code/` or `apps/<app>/data/` by path.

## Consequences

- An origin is optional for operation and private when configured.
- Root history includes code and records, including the marker and guidance.
- Local credentials and ignored caches need another recovery source or renewal.
- A slow or failed push does not delay an action's answer.
- Another device's offline program protocol is undecided; it cannot assume
  an app still has a separate repository to clone.

## Considered alternatives

- **Pull before a run or on a timer.** It changes live files under an agent or
  editor and introduces merge decisions into normal operation.
- **Push after every action.** Actions are not commit boundaries, and slow
  network work would delay their answers.
- **A backup per app's code and records.** It requires separate origins and
  restores for changes an agent makes together.
- **An encrypted Git host supplied by Epicenter.** It introduces hosting and
  key management outside this source change.
