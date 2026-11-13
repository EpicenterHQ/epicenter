# 0888. When a push and the host change the same thing, the later edit stays and the other stays in history

- **Status:** Proposed
- **Date:** 2026-11-13
- **Relates:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-and-pushes-to-it-and-the-host-files-what-it-receives.md) (filing a push), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (the field merge, superseded), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the loser stays a parent; an edit beats a delete it never saw), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) and [ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md) (the old product's conflict blocks and sibling files).
- **Unbuilt:** all of it: the merge, lifted from `packages/definition/src/merge` without `withBlocks`; the `Replaced:` lines; and the status line listing them.

## Context

ADR-0887 has the host merge a clone's pushed branch into `main`. Most pushes
add files with new ids and merge with nothing to decide. A clash is rarer:
the same field or the same words changed on both sides while a device was
offline.

The old product merged front matter key by key and bodies by line, then by
word (`packages/definition/src/merge/merge.ts`). It first kept the later edit
quietly with the loser as a parent of the merge (ADR-0622), then wrote
conflict blocks into bodies (ADR-0700) and sibling files for binaries
(ADR-0714), because one editor rendered every block for many people sharing a
folder. Here nobody owns the screens: a body with conflict markers would have
to be parsed by every UI, action, agent, and third-party program, and no
person is at the host when the merge runs.

## Decision

**The host merges each file by its units. When both sides changed a unit, the
later edit stays and the other stays in history. A merge adds nothing to any
file or folder.**

| File | Unit |
| --- | --- |
| Markdown with front matter | each front matter key; the body by line, then by word |
| other text | Git's line merge; on a clash, the whole file |
| binary | the whole file |

- **"Later" is the later of the last commits that touched that file on each
  side,** not the tips of the branches, so an unrelated new commit does not
  make an old edit win. A pushed commit's time counts as no later than when
  the host received it, so a device whose clock runs fast cannot win every
  clash. A tie goes to the host.
- **An edit beats a deletion,** as in ADR-0622: a file deleted on one side and
  changed on the other keeps the change, and the deletion stays in history.
- **A file both sides created, with no version in common, keeps the host's
  version.** The pushed version stays in history. Connecting a folder with its
  own history is this case, not a special one.
- **The merge commit lists what it replaced,** one trailer per unit:
  `Replaced: data/recordings/k3x9.md title, by laptop-whispering 2026-11-13T10:02Z`.
  `epicenter <app>` lists replaced units from the last 7 days, read from those
  trailers; nothing stores the list.
- **Only the host merges.** The host passes each side's commit time to the
  merge it runs; no merge driver is configured on a device.

## Consequences

- Every reader sees valid files at all times: rule 1 of ADR-0889, that a file
  only has to satisfy its contract, holds through a merge.
- An edit can lose without anyone looking at it. It is a parent of the merge
  commit, and the status line names it with the command that shows it.
- "Later" trusts the clock of the device that wrote the edit, bounded by
  when the host received it.
- About 3,000 lines of merge and its tests come over from
  `packages/definition/src/merge`, which writes YAML; the new writer is
  `key: <JSON>` lines, and its property tests change for the quiet rule.

## Considered alternatives

- **Conflict blocks in the body (ADR-0700).** Every program reading the file
  would need the block grammar, and front matter can never hold one.
- **A sibling file for a binary loser (ADR-0714).** A file no contract
  declares, and a second rule beside the one for text.
- **Later arrival wins.** A laptop offline for a week overwrites a phone edit
  made yesterday.
- **Refuse the push (ADR-0846).** The device cannot see the edit it clashed
  with.
