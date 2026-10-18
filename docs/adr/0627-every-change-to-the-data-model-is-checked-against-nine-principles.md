# 0627. Every change to the data model is checked against nine principles

- **Status:** Proposed
- **Date:** 2026-10-19
- **Supersedes:** [ADR-0590](0590-every-change-to-the-folder-model-is-checked-against-ten-principles.md) (every change to the folder model is checked against ten principles): the folder model and its desktop host are replaced by repositories, tables, and browser clones, and nine principles summarize them.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md), [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md), [ADR-0618](0618-epicenter-hosts-no-ai-service.md), [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md), [ADR-0620](0620-history-in-a-repository-only-grows.md), [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md), [ADR-0625](0625-epicenter-mv-renames-a-row-in-one-commit.md), and [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) decide the principles.
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
   plus an access list (ADR-0611, ADR-0612, ADR-0613).
2. Every byte Epicenter keeps is a Git object, a working file, an
   access-list row, or a cache (ADR-0619).
3. The access list is the only guard on who. The only refusals on what are
   what Git or a client cannot represent, and everything inside is accepted.
   Rules are files, breaks are `check` lines, repairs are edits or reverts,
   and history only grows (ADR-0612, ADR-0613, ADR-0620, ADR-0624).
4. Git's nouns win, and Epicenter names only types: its own words say what
   a file is (a table, a row), never a second name for what Git already
   names (ADR-0612, ADR-0613, ADR-0625).
5. Every place that edits is its own clone, with one writer at a time
   (ADR-0611, ADR-0623).
6. Wherever Epicenter merges, the edit that reaches `main` last wins each
   unit both sides changed, an edit beats a delete it never saw, no conflict
   marker is written, and the losing version stays a parent of the merge
   commit (ADR-0622).
7. The library writes text; binary files come later, through Git LFS
   (ADR-0621).
8. An app is a program you let into a repository, and a website is
   identified by its origin (ADR-0614, ADR-0626).
9. Epicenter builds only the data layer. Later work adds clients, access, or
   transport, never a data rule (ADR-0611, ADR-0618).

## Consequences

- A change that adds a refusal, a second name for a repository, a record of
  history outside Git, or a rule for one app names the principle it breaks
  and the record that changes it.
- A new hosted product, such as hosted AI, is checked against principle 9:
  it may add a client or a transport and adds nothing to what a repository
  holds or refuses.
