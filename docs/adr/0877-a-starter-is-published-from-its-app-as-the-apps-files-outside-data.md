# 0877. A starter is published from its app, as the app's files outside `data/`

- **Status:** Proposed
- **Date:** 2026-11-11
- **Unbuilt:** all of it: there is no `epicenter publish`, the first-party starters are folders in this repository (`apps/<app>`), and the Studio's apps were copied from them by hand, with their built UI committed.
- **Relates:** [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters, `upstream`, `update`), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (records under `data/`), [ADR-0873](0873-the-command-is-epicenter-cli-and-an-app-builds-against-epicenter-app-released-together.md) and [ADR-0874](0874-the-ui-kit-is-a-shadcn-svelte-registry-an-app-copies-from.md) (what an app builds against), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (`origin`).

## Context

ADR-0866 makes a starter the source of an app: `new --from` clones it, and
`update` merges its changes in. That is the direction for someone who takes an
app. Its author works the other way. The author changes the app on their own
server, with agents, where its data is, and a starter is what they hand on.

Today each first-party app has two copies: its source in this repository and
the app on the Studio, a hand copy holding `epicenter.ts` and a committed
build of its UI. The copies drift, the Studio's apps cannot change their own
UI, and their history is mostly hand migrations: Tasks has seven commits and
no records.

## Decision

**The app on its author's server is the source. `epicenter publish` makes the
starter from it.**

```sh
epicenter publish vocab git@github.com:braden-w/vocab-starter.git
```

- It takes the app's tracked files outside `data/` at its newest commit
  (ADR-0876), lists them, and asks before writing; `--yes` skips the asking.
- It writes them as one commit on the starter's branch, whose parent is the
  starter's last commit, with the subject `vocab: publish <short commit>`. The
  starter's history is its own, one commit per publish: the app's history,
  which records its data, never leaves.
- The starter's remote is kept in the app as the remote `starter`, so
  `epicenter publish vocab` alone publishes again. `origin` stays the app's
  backup and `upstream` the starter it came from, if any (ADR-0866).
- An app may have both: one made from someone's starter can publish its own.

**First-party starters are published from the Studio's apps.** Capture,
Reading, Tasks, and Vocab are each developed in `~/Epicenter`, and their
starters live in repositories of their own. The copies in this repository's
`apps/<app>` stop being sources; what platform tests need of them stays as
test fixtures.

## Consequences

- One copy of each app, changed where it runs: an agent changes its UI, its
  actions, and its records in one folder, and the app's history is its own.
- A person who took the starter runs `epicenter update` and merges the new
  commit. Their changes reach the author as a pull request on the starter,
  which the author merges into their app, so the next publish carries it.
- Publishing cannot carry a record: `data/` is never read, and `*.local` files
  are never tracked.
- A starter builds on its own: its UI depends on the published
  `@epicenter/app` (ADR-0873) and the components it copied (ADR-0874), never
  on `workspace:` or `catalog:` versions.
- Changing `@epicenter/app` no longer typechecks the first-party apps in this
  repository; their starters build against each release instead.

## Considered alternatives

- **Starters developed in this repository, flowing into apps by `update`.**
  This is today's arrangement: two sources for the author's own apps, which
  drift, and the author's app cannot be changed where it runs.
- **Publishing the app's history with the records filtered out.** Rewriting
  history is slow and easy to get wrong, and each publish would rewrite the
  starter, breaking every `update`.
- **A starter as a branch of the app's own repository.** The private
  repository that backs up the records would also be the one shared.
</content>
</invoke>
