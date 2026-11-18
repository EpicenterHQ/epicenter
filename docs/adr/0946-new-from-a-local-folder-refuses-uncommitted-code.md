# 0946. `new --from` a local folder refuses uncommitted code

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md) at "`notCopied` is absent for it": there is no `notCopied`. A local source with uncommitted code is refused instead.
- **Relates:** [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md) (export refuses uncommitted code the same way)

## Context

`epicenter new <name> --from <folder>` copies the folder's committed tree. When
the folder on disk differed from that commit, `new` copied anyway, exited 0,
and listed up to five files it had left out. Under `--json` the difference was
`source.notCopied`: an array, an empty array, `null` when Git could not
compare, or absent for a GitHub folder. Computing it took three Git calls, a
merge of their output, the copy's path filter, and a test that made a commit
during the copy.

The common case it served went wrong anyway. Someone refreshes an export,
forgets to commit it, and copies the folder: they get the previous version, a
finished app to delete, and a warning they may not read. `export` answered the
same question with one `git status` and a refusal.

## Decision

**A local source must be its commit.** Before it creates anything, `new` runs
`git status --porcelain --untracked-files=all -- <folder>` in the source
checkout. Any output refuses the copy with `<from> has uncommitted changes;
commit them, then copy.` A GitHub folder has no working tree and is not
checked. `source` in `--json` is `{ commit }`.

## Consequences

- Copying from a checkout with a stray untracked file or an edited tracked
  file is refused even when the commit is fine. Commit, `git stash -u`, or
  copy from a clean clone.
- The check covers the folder as Git sees it, not the copy's filter, so a
  changed tracked file under `data/` or `ui/dist/` refuses too. Files the
  source ignores do not.
- A commit made in the source during the copy is no longer reported. The copy
  takes whatever commit it cloned, and `SOURCE.md` names it.
