# 0826. History enters and leaves Epicenter as Git

- **Status:** Accepted (2026-11-07)
- **Date:** 2026-11-07
- **Amends:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) at "Git is how history leaves": Git is also how history enters, and a person can name a moment in it.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (standards), [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) and [ADR-0825](0825-the-epicenter-folder-contains-its-folders.md) (one owner per folder; the Epicenter folder contains its folders), [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) (front matter's grammar).
- **Amended by:** [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) at an import that stops midway: it resumes, or is abandoned.
- **Amended by:** [ADR-0828](0828-names-say-folders-and-changes-and-history-is-package-functions-the-epicenter-app-shows.md) at "`epicenter import --git`": an import is a package function over a computer's Git, which the CLI and the Epicenter app both run.

## Context

ADR-0824 stores a folder's history as Epicenter's own log and makes Git the way
it leaves. A person who already keeps a folder in Git, a notes vault on GitHub
for example, had no way in except copying its files and losing its history. A
folder has one owner at a time: Epicenter never syncs a Git working tree, so
Git and Epicenter cannot both sync one folder.

## Decision

**History enters as Git and leaves as Git.** `epicenter import --git <repository
or URL>` replays the first-parent history of a branch, its default unless
named, as changes that keep each commit's author, time, and message, fetching
its LFS objects; it creates the folder, writes its files to a real directory in
the Epicenter folder without `.git`, and records it as synced. The repository
it read is left as it was. Side branches arrive only through merges on the main
line, and submodules are skipped with a warning.

**Importing hands the folder from Git to Epicenter.** Epicenter offers to move
the original aside, its `.git` kept as a backup, and to leave a link at its
path pointing into the Epicenter folder. A Git host stays a mirror through the
deterministic export, pushed by fast-forward; Epicenter to Git is an export,
and Git to Epicenter is an import, so one program owns the folder at a time.

**A person names a moment with `epicenter mark <name>`.** A mark labels the
folder's current change; `history` and `at` reach it by name, and the export
writes it as a Git tag. An imported tag becomes a mark. Saves need no commit
step.

**Imported files keep their bytes.** Front matter in another grammar reads as
body until `epicenter format`, whose rewrite lands as one change.

## Consequences

- A Git repository becomes an Epicenter folder with its history, and an
  Epicenter folder becomes a Git repository with its history.
- Git and Epicenter never sync one folder at once; a folder moves between them.
- Merge commits' side histories and submodules do not survive an import.
