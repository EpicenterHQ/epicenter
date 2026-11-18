# 0956. Bare `epicenter` reports apps and routines, and Git reports the repository

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md) at "Bare `epicenter` reports" ("and one line from Git: how long ago the last commit was, how many files are uncommitted, how many commits are not on origin, and any Git repository nested under `apps/`"), and at the consequences "bare `epicenter` is where that shows" and "Bare `epicenter` names it": the report has no Git line, and `git status -sb` shows the same facts.

## Context

ADR-0940 made Git the home's store and kept one line of Git status in the bare
`epicenter` report, as the place a stopped checkpoint would show. That line
took its own module: the last commit's age, a count of uncommitted files, the
commits ahead of origin, and a walk of `apps/` for nested repositories. Each
is a Git read the owner can run directly, and Git's own answer says more: it
names the uncommitted files instead of counting them. The nested walk
duplicated a warning Git gives itself: `git add` names an embedded
repository when it meets one.

## Decision

Bare `epicenter` reports the version, the apps, any problems loading them,
and the routines. It says nothing about the repository, and `--json` has no
`repository` field.

Git reports on the home's repository:

```sh
git status -sb               # branch, commits ahead of origin, each uncommitted file
git log -1 --format=%cr      # how long ago the last commit was
```

A repository nested under `apps/` is named by `git add` when the owner
commits.

## Consequences

- `repository.ts` and `originOf` leave the CLI.
- How long ago the home was last committed shows in Git and in any Git app,
  not in the bare report. An owner who wants both runs
  `epicenter && git status -sb`.
- A false warning about a repository under an app's ignored `local/` is gone
  with the walk that raised it.
