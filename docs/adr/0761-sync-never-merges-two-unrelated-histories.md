# 0761. Sync never merges two unrelated histories

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) at its title's principle, "it never merges two": it reads "it never merges two unrelated histories", and offline commits on a folder Epicenter already synced merge as branches of one history.
- **Relates:** [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) (edits made offline on Epicenter's history are a state Epicenter made), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state), [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (the merge rule).

## Context

[ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md)'s title
states its principle as "Sync gives files a history; it never merges two",
and `docs/vision.md` repeats it. Its decision is narrower: "Sync never
merges two unrelated histories." Read alone, the short form says sync never
merges, which is false. Two devices that commit offline on one folder make
two branches, and every round merges them with `settle`
([ADR-0741](0741-epicenter-reconciles-only-states-it-made.md)'s "edits made
offline" row).

## Decision

**Sync never merges two unrelated histories.** ADR-0735's principle reads:
**Sync gives files a history; it never merges two unrelated histories.**

| History | Sync |
| --- | --- |
| commits made offline, on any device, on a folder Epicenter already synced | merges them as ordinary branches of one history, by [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)'s rule |
| a folder's files before its first sync | adds them on top of the account repository's `main` in one commit (ADR-0735) |
| a history Epicenter did not make | refuses it, naming the command that resolves it (ADR-0735) |

Every branch a round merges descends from the account repository's first
commit, so no merge Epicenter runs joins two roots.

## Consequences

- A reader of the principle alone knows offline edits on two devices
  merge, and that only a foreign history is refused.
- No code changes; ADR-0735's decision already said "unrelated".

## Considered alternatives

- **Keep the short form.** It reads as "sync never merges", which
  contradicts every round that joins two devices' offline commits.
- **Edit ADR-0735's title in place.** An accepted record's decision is
  fixed, and its filename is how every citation reaches it.
