# 0622. A losing edit stays a parent of the merge commit

- **Status:** Proposed
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) (a folder has one write, a merge by unit where the writer acting wins): the edit that reaches `main` last wins each unit both sides changed, an edit beats a delete it never saw, and Epicenter writes no conflict marker or conflict file.
- **Amends:** [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "one region of body lines", "other UTF-8 text | one region of lines", the line merge `rowTextWins`, and "binary, or a side absent | the whole file" for a side absent: text merges by diff3 region, and an edit beats a delete it never saw.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`epicenter sync` runs `git pull --no-rebase`), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows).
- **Unbuilt:** all of it: `merge(path, { base, current, change })`; diff3 regions in place of `mergeLines`; an edit beating a delete; the change winning a path where a file and a directory collide; and `check` listing conflict markers.

## Context

`merge` in `packages/folder/src/merge-file.ts` takes three versions with
`ours` as the writer acting and a `winner` option, and merges text with a
line merge of its own (`mergeLines`,
`packages/folder/src/git/merge-lines.ts`) that joins two insertions at one
place
([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md),
[ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md)).
A delete beats an edit it never saw. A file against a directory keeps both,
the file renamed `<path>~<side>`. `mergeMessage` in
`packages/folder/src/git/merge.ts` names each losing unit in an `Overrode:`
trailer. The CLI now syncs with plain `git pull --no-rebase`
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)),
which merges by Git's rules, not Epicenter's.

## Decision

**Wherever Epicenter merges, the edit that reaches `main` last wins each
unit both sides changed.** Epicenter merges in two places: a browser
clone's sync, where this clone's commits are the change against what
`main` holds, and a save, where the fields it names are the change against
the row as it is now.

| File | Unit |
| --- | --- |
| a `.md` file with frontmatter | one field, its value whole; then one diff3 region of the body |
| other UTF-8 text | one diff3 region |
| a `.json` file | one key, as [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) states |
| binary, or a side absent | the whole file |

- Units only one side changed all survive.
- **An edit beats a delete it never saw.** A file one side deleted and the
  other changed is kept, with the change.
- **Epicenter never writes a conflict marker or a conflict file.** Where a
  file and a directory collide at one path, the change wins the path.
- **The losing version stays a parent of the merge commit**, and an
  `Overrode:` trailer names it, such as
  `Overrode: <losing-oid> field="title" "cards/abc.md"`.

**The merge takes named roles:** `merge(path, { base, current, change })`,
where `change` wins. Deleted: `ours`, `theirs`, and `winner`, and
`mergeLines` with its union of insertions.

**Epicenter decides only where Epicenter merges.** Plain Git on disk merges
with Git's own rules, and the conflict markers it leaves are listed by
`check`.

## Consequences

- The last clone to sync wins every unit both changed, even with an edit a
  week old; what it overrode is one parent away.
- A row deleted on one clone comes back when another clone edited it
  without seeing the delete.
- Two different insertions at one place in a body compete: the change's
  stands, and the other is in the losing parent.
- `git pull` on disk and a browser sync can merge the same two commits
  differently, and only the plain-Git result can hold conflict markers.

## Considered alternatives

- **A delete beats an edit it never saw (ADR-0576).** An edit made without
  knowing of the delete disappears from the working tree.
- **Epicenter's own line merge that joins insertions (ADR-0591).** A second
  text algorithm Git does not have, so the two merges disagree on more than
  who wins.
- **Conflict files beside the path (`<path>~<side>`).** Every app has to
  show and resolve a state that one parent of the merge commit already
  records.
- **The person decides each conflict.** Sync then stops until someone
  answers.
