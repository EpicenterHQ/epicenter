# 0622. A losing edit stays a parent of the merge commit

- **Status:** Superseded
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) (a folder has one write, a merge by unit where the writer acting wins): the edit that reaches `main` last wins each unit both sides changed, an edit beats a delete it never saw, and Epicenter writes no conflict marker or conflict file.
- **Superseded by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md): notes merge with conflict blocks, front matter by later arrival, a binary conflict copy, and a merge driver for plain Git.
- **Amends:** [ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md) at "one region of body lines", "other UTF-8 text | one region of lines", the line merge `rowTextWins`, "a `.json` file, `epicenter.json` included | one key of an object", "binary, or a side absent | the whole file" for a side absent: all text, `.json` included, merges by diff3 region, and an edit beats a delete it never saw.
- **Amended by:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md) at the `a save` role: a local save no longer merges.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`epicenter sync`), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (`set` and its `from`).
- **Unbuilt:** `check` listing conflict markers left by plain Git.

- **Current edit implementation:** [ADR-0668](0668-one-folder-owned-source-orders-file-publications.md) records the retained-source model implemented in `bd78bfb52b`. Editors and direct file/table commands share each path's publication lane; local writes are unconditional whole-file last-write-wins. Git synchronization keeps its merge rules. Earlier draft-merge and guarded-save descriptions below are historical.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

`merge` in `2c54debe4f44:packages/folder/src/merge-file.ts` takes three versions with
`ours` as the writer acting and a `winner` option, and merges text with a
line merge of its own (`mergeLines`,
`2c54debe4f44:packages/folder/src/git/merge-lines.ts`) that joins two insertions at one
place
([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md),
[ADR-0591](0591-the-merge-reads-a-files-content-and-extension-never-a-definition.md)).
A delete beats an edit it never saw. A file against a directory keeps both,
the file renamed `<path>~<side>`. `mergeMessage` in
`c87a47f8783f:packages/folder/src/git/merge.ts` names each losing unit in an `Overrode:`
trailer. ADR-0591 deleted the merge driver that ran this merge inside plain
Git, so `git pull` on disk merges by Git's own rules
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

Today's save already merges a row's body against the version a tab read.
Branch `claude/v1-gate-tests`, commit `498e051ddb`
(`packages/folder/evidence/two-tab/`), has two tabs edit one row's body:
edits to different paragraphs both survive, and edits to different
sentences of one paragraph, which is one line, keep only one.

## Decision

**Wherever Epicenter's merge runs, the edit that reaches `main` last wins
each unit both sides changed.** It runs in two places, each giving the
merge named roles, where `change` wins:

```txt
              base                           current                  change
sync          the merge base; in a browser   what main holds          this clone's commits; in a
              clone, origin/main                                      browser clone, its unsent edits
a save        the from the app passed, or    the file the clone       the file the save writes
              no file for from: null         holds now
```

| File | Unit |
| --- | --- |
| a `.md` file with frontmatter | one field, its value whole; then one diff3 region of the body |
| other UTF-8 text, `.json` included | one diff3 region |
| binary, or a side absent | the whole file |

- Units only one side changed all survive.
- **Two insertions at one place both stay**, current's first. An insertion
  that holds the other at its start or end stands alone, so an insertion
  sent again, or extended since, is not doubled. Frontmatter merges by
  field, so it has no insertions to join.
- **An edit beats a delete it never saw.** A file one side deleted and the
  other changed is kept, with the change.
- **Epicenter never writes a conflict marker or a conflict file.** Where a
  file and a directory collide at one path, the change wins the path.
- **The losing version stays a parent of the commit that overrode it**,
  and an `Overrode:` trailer in that commit names it, such as
  `Overrode: <losing-oid> field="title" "cards/abc.md"`. On disk that
  commit is a merge commit. A browser clone commits its rebased edits on the
  server's `main`, so the loser is that commit's one parent; a trailer
  carried from a commit that never landed names an ancestor by its oid
  ([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)).
- **A save names nothing it overrode.** What it overrode stays in the
  clone's last commit, unless it was another tab's unsent edit, which is in
  no commit.

**The merge takes named roles:** `merge(path, { base, current, change })`.
Deleted: `ours`, `theirs`, and `winner`. Kept: `mergeLines` with its union
of insertions.

**One merge implementation runs in browser and disk clients.** A browser sync and
`epicenter sync` on disk run the same TypeScript `merge`, `epicenter sync`
over the local `.git`
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)),
and each writes its own Git commit, with `Overrode:` trailers when units
compete. The disk host writes a merge commit; the browser writes a one-parent
commit on the server's `main`. Epicenter registers no Git merge driver: no
`merge.epicenter.driver` config and no committed `.gitattributes` line.
Plain `git pull` stays plain Git. Its conflict markers are not yet reported
by `check`, and `epicenter sync` does not yet refuse to commit them.

**Every Epicenter save is one merge of the whole file:**
`merge(path, { base: from, current, change })`. `current` is the file the
clone holds, `change` is the file the save writes, and `from` is the row or
text the app's edit started from
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)). A unit
the save did not change keeps what `current` holds, so two tabs editing
different paragraphs of one row both keep their edits; with `from: null`,
the save wins every unit it changes.
The Epicenter desktop app saves the same way and writes no file last-write-wins.
Whole-file inputs give the merge the context to identify changed units;
they do not choose one whole-file winner. Independent frontmatter fields
and non-overlapping body regions survive both saves and synchronization.
Separate paragraphs are examples of independent regions; two replacements
of the same region still compete under the rule above.
The file a save writes keeps the existing file's key order, with keys new
to it appended alphabetically
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).

## Consequences

- The last clone to sync wins every unit both changed, even with an edit a
  week old; what it overrode is one parent away.
- A row deleted on one clone comes back when another clone edited it
  without seeing the delete.
- A row folder edited on one clone while its row was deleted on another
  comes back without its `.md`, since the edit beats the delete; `check`
  lists it as a row folder that has no row.
- Two thoughts added at the end of one capture on two devices both stand,
  in the order the merge met them. Two edits to one thought compete, and
  the change's stands.
- A `.json` file two sides each added a key to at one place can come out
  invalid, with a missing comma; `check` names it, and an edit repairs
  it.
- `epicenter sync` and a browser sync merge the same two commits the same
  way; only plain `git pull` leaves conflict markers.
- Two tabs that edit different paragraphs of one row both keep their
  edits. Two that edit one line keep the later save's line, and the earlier
  one survives only if a sync committed it first.
- The Epicenter desktop app's save keeps an agent's edit to another unit of the
  file it saves, where it used to overwrite the whole file.
- A `.json` file two clones edited in one region keeps the change's
  region; the rare merge that leaves invalid JSON, such as a `table.json`,
  is a `check` line and is repaired by an edit.

## Considered alternatives

- **A whole-file winner for text.** Two writers changing different fields
  or paragraphs lose an independent edit. Smaller storage or sync machinery
  does not justify changing the merge unit.
- **A delete beats an edit it never saw (ADR-0576).** An edit made without
  knowing of the delete disappears from the working tree.
- **Two insertions at one place competing.** Two thoughts added on two
  devices before a sync lose one, the most common concurrent edit
  Epicenter Captures makes.
- **Git's `merge-file --union`.** It also keeps both sides of a region both
  sides changed, so two edits of one thought stand as two thoughts.
- **A `.json` file merged key by key (ADR-0591).** A third algorithm for one
  kind of file, kept to avoid a rare invalid merge that `check` already
  names.
- **Conflict files beside the path (`<path>~<side>`).** Every app has to
  show and resolve a state that a parent of the overriding commit already
  records.
- **The person decides each conflict.** Sync then stops until someone
  answers.
- **Git's own merge in `epicenter sync`.** `epicenter sync` and a browser
  sync merge the same two commits differently, and every overlap on disk is
  a conflict marker.
- **A Git merge driver, `merge.epicenter.driver`.** Each machine registers
  it and each repository opts in with a `.gitattributes` line; Git calls
  no driver for a file one side deleted, a file against a directory, or a
  rename; Git writes the merge commit, so it carries no `Overrode:`
  trailer; and Git also runs the driver for `git revert`, `cherry-pick`, and
  `stash pop`, where letting the current side win can keep the very change
  a revert means to undo, so a repair by revert could fail silently.
- **A save whose body always replaces the row's.** Two tabs editing
  different paragraphs of one row lose one tab's edit.
- **Fields set as named, outside the merge.** A save then has two rules,
  a merge for the body and an overwrite for fields, and an app that sends
  back a field it read undoes another writer's change to it.
