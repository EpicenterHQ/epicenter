# 0625. `epicenter mv` renames a row in one commit

- **Status:** Proposed
- **Date:** 2026-10-19
- **Relates:** [ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md) (a row is addressed by its path, so renaming it changes its id), [ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md) (a row is `<table>/<id>.md` with an optional `<id>/` folder), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (a repository's name is a label).
- **Unbuilt:** all of it: the `mv` command, its argument syntax, which links it rewrites, and `check` listing broken links.

## Context

A row is `<table>/<id>.md`, and its own files are in `<table>/<id>/`
([ADR-0613](0613-a-table-is-a-top-level-directory-described-by-its-table-json.md)).
Its id is its address, so renaming it changes the id and breaks every link
that names the old path
([ADR-0584](0584-each-concept-has-one-noun-in-code-on-the-wire-and-in-prose.md)).
With plain Git, renaming a row is two `git mv`s, and forgetting the second
leaves the row's folder under the old id. The CLI's other commands are
`login`, `sync`, `check`, and `query`
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

## Decision

**`epicenter mv` renames a row, its `.md` and its `<id>/` folder, in one
commit.** It may also rewrite links that name the row's old path. Links it
leaves broken are listed by `check`, for an agent to fix.

**`mv` renames rows only.** A repository's name is a label that changes
without moving anything
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)).

## Consequences

- A row and its folder never land at two different ids in one commit.
- A link `mv` does not rewrite is a `check` line until someone edits it.
- Renaming a row is still a delete and a create to a merge: a clone that
  edited the old id while another renamed it keeps its edit at the old id
  ([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).

## Considered alternatives

- **Plain `git mv` only.** Two commands per row, and the folder is the one
  people forget.
- **A stable id inside each row.** Links survive renames, but every file
  carries a second identity that a hand edit can break.
