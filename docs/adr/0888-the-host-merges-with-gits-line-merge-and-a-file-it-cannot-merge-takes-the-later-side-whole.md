# 0888. The host merges with Git's line merge, and a file it cannot merge takes the later side whole

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Relates:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (filing a push), [ADR-0862](0862-notes-merge-field-by-field-and-every-conflict-is-listed-for-repair.md) (the field merge, superseded), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the loser stays a parent; an edit beats a delete it never saw), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) and [ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md) (the old product's conflict blocks and sibling files).
- **Unbuilt:** all of it: the filing merge, the `Replaced:` and `Restored:` trailers, and the status line listing them.

## Context

ADR-0887 has the host merge a clone's pushed branch into `main`. Most pushes
add files with new ids and merge with nothing to decide. A clash is rare: a
device edits a file it did not create, while another edit to the same lines
lands on the host.

The old product merged front matter key by key and bodies word by word
(`packages/definition/src/merge`, about 1,500 lines), and wrote conflict
blocks and sibling files (ADR-0700, ADR-0714). That machinery kept two edits
to adjacent lines of one file. Here nobody owns the screens: a conflict block
in a body would have to be parsed by every UI, action, agent, and program,
and no person is at the host when a push is filed. Measured 2026-11-13: Git's
line merge keeps edits to front matter keys one line apart and reports a
conflict for adjacent ones.

## Decision

**The host merges with Git's line merge. A file Git cannot merge takes the
side with the later edit, whole, and the other side stays in history. A merge
adds nothing to any file or folder.**

```sh
git merge-tree --write-tree -X no-renames main clone/laptop-k3x9
```

- **`-X no-renames`.** Rename detection matched a record the host deleted to
  an unrelated record it created, and applied the clone's edit to the wrong
  file (measured 2026-11-13).
- **A conflicted file takes the later side whole.** Each side is dated by its
  last commit touching that file. On `main`, that is the first-parent commit
  that brought the change in, so a filed edit carries the date the host filed
  it. On the clone's branch, it is that commit's own date, capped at the time
  of this filing. So a device whose clock runs fast can win only clashes in
  its own push, never against an edit already filed. A tie goes to the host.
- **A merged file outside the `key: <JSON>` front matter grammar, where both
  sides were inside it, takes the later side whole.** Git merges two sides
  adding the same key at different lines into front matter that holds the key
  twice (measured 2026-11-13), which the reader would take as all body
  (`packages/app/src/front-matter.ts`).
- **An edit beats a deletion,** as in ADR-0622 and as Git already merges
  without renames.
- **The merge commit names each whole file it replaced or restored,** one
  trailer each:
  `Replaced: recordings/k3x9.md, kept laptop-k3x9's edit of 2026-11-13T10:02Z`
  or `Restored: recordings/k3x9.md, edited on laptop-k3x9 after its deletion`.
  `epicenter <app>` lists the last 7 days of them, read from those trailers;
  nothing stores the list.
- **Only the host merges.** No merge driver is configured anywhere.

## Consequences

- Every reader sees files that parse at all times. ADR-0889's rule, that a
  file only has to satisfy its contract, holds through a merge.
- Between two offline devices that changed the same lines, the one filed
  first wins unless the other's edit was made after that filing.
- Two edits to adjacent lines of one file, made while one device was offline,
  keep only the later one. The other is a parent of the merge commit, and the
  status names it.
- Two edits survive a line merge only when each writer leaves the lines it did
  not change byte for byte. A program writes records with Epicenter's own
  front matter writer (ADR-0889).
- The merge is the few lines around `git merge-tree` that pick a side,
  re-parse, and write trailers. `packages/definition/src/merge` is not lifted.

## Considered alternatives

- **A field merge: front matter key by key, the body by line, then word.**
  Keeps edits to adjacent keys, at the cost of a merge of Epicenter's own to
  write and maintain, for a clash the owner judged rare.
- **Conflict blocks in the body (ADR-0700).** Every program reading the file
  would need the block grammar, and front matter can never hold one.
- **A sibling file for a binary loser (ADR-0714).** A file no contract
  declares.
- **Later arrival wins.** A laptop offline for a week overwrites a phone edit
  made yesterday.
- **Each commit's own date, capped at when the host received it.** The cap
  would have to be stored; the first-parent walk needs nothing stored.
