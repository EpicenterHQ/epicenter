# 0627. Every change to the data model is checked against nine principles

- **Status:** Accepted
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (every change to the folder model is checked against ten principles): the folder model and its desktop host are replaced by repositories, tables, and browser clones, and nine principles summarize them.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md), [ADR-0618](0618-epicenter-hosts-no-ai-service.md), [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [ADR-0620](0620-history-in-a-repository-only-grows.md), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md), and [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) decide the principles.
- **Unbuilt:** every record the principles cite is unbuilt in whole or in part; the principles describe the model they build.

## Context

[ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md)
summarized the folder model in ten principles: a folder a person owns and
opens, an app the desktop host installs and hands one folder, and machine
state the host keeps. That model and its host are superseded by the data
layer of
[ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)
through
[ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md), each of
which decides one part.

The principles are a maintained summary: when a record they cite changes,
the principle is restated here in the same change, and the cited record
governs where the two differ.

## Decision

**Every change to the data model is checked against these principles:**

1. Your data is Git repositories, and Epicenter is a path convention on Git
   plus an access list. An agent's commit and an app's save edit the same
   repository; Git is the only record and the only sync format, and no CRDT
   store exists beside it (ADR-0611, ADR-0612, ADR-0613).
2. Every byte Epicenter keeps is a Git object, a working file, an
   access-list row, or a cache. A browser clone holds Git objects, refs,
   and its unsent edits, and nothing else (ADR-0619, ADR-0623).
3. The access list is the only guard on who. The only refusals on what are
   a non-text write from the library, a push that would rewrite history,
   what Git cannot represent, and a new row id that differs from an
   existing one only by case, which a disk clone on a case-insensitive file
   system could not hold apart; everything else is accepted, and a
   browser clone carries untouched any tree entry it cannot represent.
   Rules are files, breaks are `check` lines, repairs are edits or reverts,
   and history only grows (ADR-0612, ADR-0613, ADR-0620, ADR-0621,
   ADR-0623, ADR-0624).
4. Git's nouns win, and Epicenter names only types: its own words say what
   a file is (a table, a row), never a second name for what Git already
   names (ADR-0612, ADR-0613).
5. Every place that edits is its own clone: each app origin keeps its own
   in IndexedDB, where reads and saves are transactions and only sync
   takes turns between tabs. On disk, the person and their agents write
   files with last-write-wins, the data browser saves through the merge,
   and commits happen at `epicenter sync` (ADR-0611, ADR-0622, ADR-0623).
6. One TypeScript merge runs wherever Epicenter merges, in a sync on every
   host and in a save, and the edit that reaches `main` last wins each unit
   both sides changed, an edit beats a delete it never
   saw, Epicenter writes no conflict marker, and the losing version of a
   sync stays a parent of the merge commit (ADR-0622, ADR-0626).
7. The library writes text; binary files come later, through Git LFS
   (ADR-0621).
8. An app is a program you let into a repository, and a website is
   identified by its origin and holds a grant per repository; a signed-in
   device, the CLI and the data browser through it, holds an account grant
   (ADR-0614, ADR-0626).
9. Epicenter builds only the data layer and two tools over it, the CLI and
   the desktop data browser, and hosts no app. Later work adds clients,
   access, or transport, never a data rule (ADR-0611, ADR-0618).

## Consequences

- A change that adds a refusal, a second name for a repository, a record of
  history outside Git, or a rule for one app names the principle it breaks
  and the record that changes it.
- A new hosted product, such as hosted AI, is checked against principle 9:
  it may add a client or a transport and adds nothing to what a repository
  holds or refuses.
