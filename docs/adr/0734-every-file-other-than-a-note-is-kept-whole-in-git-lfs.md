# 0734. Every file other than a note is kept whole in Git LFS

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Supersedes:** [ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md) (a file's extension decides how every folder merges it): one rule for every folder, with no binary-extension list, size cap, or migration between lists.
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (every file that is not a `.md` note and not a hidden path is Git LFS), [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) (Epicenter syncs folders other programs made), [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (your own git is plain Git).
- **Amended by:** [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) at conflict copies: the later write to an attached file wins, and the loser stays in history.
- **Amended by:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at files other than notes kept in Git LFS: every file's bytes are kept by their SHA-256, inline or in the blob store by size.
- **Unbuilt:** the screen line in Epicenter.

## Context

`REPOSITORY_ATTRIBUTES` in `packages/definition/src/contract/storage.ts`
writes one rule into every synced folder's `.gitattributes`, and
`epicenter init` keeps it as a marked block (`packages/cli/src/sync/setup.ts`):

```txt
* filter=lfs diff=lfs merge=lfs -text
*.[mM][dD] !filter !diff merge=epicenter text
.* (hidden paths)  !filter !diff !merge !text
```

`storedWithLfs(path)` in the same file is `!isHiddenPath(path) && !isNotePath(path)`.
The server refuses a push that breaks it (`packages/server/src/routes/receive.ts`)
and a web write that breaks it (`packages/server/src/routes/files.ts`).

For a file other than a note, both writers keep both versions when two
devices change it. When a sync's merge leaves such a file unmerged,
`settleUnmerged` in `packages/cli/src/sync/sync.ts` keeps the remote version
at its path and writes the local one beside it as
`<stem> (conflict <hash7>)<ext>` (`conflictSibling` in
`packages/definition/src/merge/settle.ts`). The server does the same for a
web write that loses a compare-and-swap.

[ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md)
proposed replacing that rule with a list of binary extensions: listed files
in LFS, every other file merged by Git's line merge, and a size cap on
files outside LFS. Its own consequences named the costs. The list is a
durable format: a folder synced under one list and read under another stores
a file two ways, so changing the list needs a migration. Conflict markers
can land in a `.json` or `.canvas` file, which then fails to parse until a
person or agent repairs it. None of the list, the cap, or the migration was
built.

## Decision

**Notes merge by Epicenter's rule; every other file is kept whole through
Git LFS.** The rule is the same for every folder Epicenter syncs, whichever
program made it.

| File | Stored | When two devices change it |
| --- | --- | --- |
| `*.md` | Git text | `settle` merges front matter key by key and the body by diff3 (`packages/definition/src/merge/settle.ts`) |
| any other file that is not hidden | Git LFS | the remote version stays at its path; the local one lands beside it as `<stem> (conflict <hash7>)<ext>` |
| a hidden path | Git, untouched | Git's defaults |

- **`REPOSITORY_ATTRIBUTES` and `storedWithLfs` stay as written.** No
  binary-extension list, size cap, or per-extension migration exists.
- **A file is never merged by line unless it is a note.** A `.json`, `.csv`,
  or `.canvas` file is never written with conflict markers by Epicenter.

On a person's own folders, Epicenter's screen says:

```txt
Files other than notes are kept whole; if two devices change one, both versions are kept.
```

## Consequences

- A `.json` or `.canvas` file always parses after a sync; a person who edits
  one on two devices before syncing gets two files to reconcile by hand.
- A text file other than a note has no line history in `git log -p`; its
  history is a series of LFS pointers.
- Every non-note file costs LFS storage and an LFS transfer, including small
  text files such as a `.csv` of a few lines.
- The rule never changes with a list, so no folder needs a migration when
  Epicenter learns a new format.
- A person's own `git` merges a note by line (ADR-0733) and a file in LFS as
  Git does; Epicenter's conflict copies come only from Epicenter's sync and
  server.

## Considered alternatives

- **A binary-extension list (ADR-0714).** A durable list that needs
  migrations when it changes, and conflict markers in structured text files.
- **A list of text extensions merged by line.** The same migration cost
  with the list inverted, and the same markers in `.json`.
- **Decide by content (a NUL byte).** A file could change storage between
  commits as its content changes, and the server would read every file's
  bytes.
- **A per-folder choice between rules.** Every sync, the server, and the
  Epicenter app would need to know a folder's kind.
