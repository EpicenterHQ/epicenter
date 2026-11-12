# 0885. An Epicenter's apps live in `apps/`, which its repository ignores with one line

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amends:** [ADR-0884](0884-an-epicenter-is-a-repository-that-lists-the-repositories-inside-it-and-init-from-rebuilds-it.md) (the `.gitignore` lines epicenter rewrote are gone), [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app was a direct child of the Epicenter).
- **Relates:** [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's code ignores `data/` with one line).

## Context

ADR-0884 made the Epicenter's folder a repository and had `epicenter` keep
each app out of it by rewriting a marked block of the `.gitignore` before each
backup: `/vocab/`, `/mail/`, one line per app. That made the `.gitignore` a
file two writers share, a person and the clock, and made the list of
repositories and the ignore lines two outputs that only one walk kept in step.
An app is already built the other way round: its code repository ignores
`data/` with one fixed line, and whatever is in `data/` is the data's
repository's business.

## Decision

**Apps live in `<Epicenter>/apps/<name>`. The Epicenter's `.gitignore` leaves
out `apps/` with one line it never rewrites, and a repository anywhere else in
the Epicenter stops its backup.**

```txt
~/Epicenter/              the Epicenter's repository
  EPICENTER.md AGENTS.md  tracked
  Zhongwen/               tracked: not an app
  repositories.json       { "apps/vocab": "<origin>", "apps/vocab/data": "<origin>" }
  .gitignore              apps/, *.local, *.local.*, node_modules/, .DS_Store
  apps/
    vocab/                code repository
      data/               data repository
```

- **`apps/` is the app list.** `epicenter` lists, runs, and serves each folder
  in `apps/` with an `epicenter.ts`; `new` makes `apps/<name>`. An app's name
  is still its folder's name, and its URL is still `/<name>/`.
- **The `.gitignore` is the person's.** `init` writes it once; the snapshot
  refuses while it does not ignore `apps/`, naming the line to add, as an
  app's code snapshot does for `data/`.
- **A repository outside `apps/` is refused,** with `mv <it> <Epicenter>/apps/`
  as the step: there is no other place the backup knows to leave it out.
- **`repositories.json` is still written from a walk,** so the restore list
  stays current; `init --from` clones into `apps/` and installs each app there.

## Consequences

- The marked block, its parser, and the race check for a repository that
  appeared during a walk are gone.
- An existing Epicenter moves its apps into `apps/` once and replaces the
  marked block with `apps/`.
- A folder in `apps/` that is not a repository is not backed up by anything.
- Relative paths between apps, such as `../tasks/data/tasks/...`, are
  unchanged: apps are still siblings.
