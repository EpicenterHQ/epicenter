# 0877. An app's code and its data are two repositories, and sharing an app shares its code

- **Status:** Accepted (2026-11-11)
- **Date:** 2026-11-11 (first drafted the same day as "A starter is published from its app, as the app's files outside `data/`")
- **Built:** 2026-11-11 in `packages/cli`: the data repository (`src/data.ts`), made by `new`, `new --from`, or the first commit to it (not by `build`); calls committing there with `Code-Commit`; snapshots of both, refusing code while `data/` is not ignored; `sync` and the clock pushing each to its own `origin`; `history` of both; `undo` of data with `codeSince`; `update <app> [<remote>]`; the listing's warning; on the Studio, Capture, Reading, Tasks, and Vocab are developed in `~/Epicenter`, each a code repository and a data repository with private backups, and this repository's `apps/<app>` copies are deleted.
- **Relates:** [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters, `upstream`, `update`), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (snapshots, the app's lock, `undo`), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (`origin`, `sync`), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (LFS), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`*.local`), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (what an app builds against).

## Context

An app's author changes it where it runs, on their own server with their
agents, and someone else takes it and runs their own copy (ADR-0866). The code
travels; the records never do (ADR-0876). In one repository the two share a
history, and that history records every write to the records, so it cannot be
shared. A starter then has to be made by copying the code into a repository of
its own, one squashed commit per publish. A starter made that way shares no
history with the app it came from: a change the other person makes comes back
only as a cherry-pick, and the next publish carries it again as new.

Today each first-party app also has two copies: its source in this repository
and the app on the Studio, a hand copy holding `epicenter.ts` and a committed
build of its UI. The copies drift, the Studio's apps cannot change their own
UI, and their history is mostly hand migrations.

## Decision

**An app is two Git repositories: the app's folder holds its code, and
`data/` inside it holds its data.**

```txt
~/Epicenter/vocab/            the code repository
  .gitignore                  data/  node_modules/  ui/dist/
  epicenter.ts  package.json  README.md
  ui/
  data/                       the data repository
    .gitignore                *.local  *.local.*
    .gitattributes            binary files through LFS (ADR-0856)
    words/<time>.md
    google.local.md
```

- **`epicenter` makes the data repository.** `new`, `new --from`, and `build`
  make `data/` a repository when it is not one, with its `.gitignore` and
  `.gitattributes`. Its author edits them after that.
- **Each repository has its own writers.** A run writes only data (ADR-0876),
  and its call commits there. People and agents edit the code. Anything
  pending in either repository is snapshotted as
  `<app>: changed outside epicenter` by `serve`'s clock, by `sync`, and before
  `undo` and `update`, as now. The app's one lock (ADR-0850) covers both.
- **Each data commit names the code it was written under,** with a
  `Code-Commit: <sha>` trailer: the code repository's `HEAD` when the commit
  was made.
- **`epicenter` refuses to cross the line.** A Git call for the data refuses
  unless `data/` is the top of its own repository. A code commit refuses while
  `data/` is not ignored. A run refuses any path with a segment that begins
  `.git`, at any depth.
- **A record's path does not change.** It is `data/words/<time>.md` in every
  answer (ADR-0876). `epicenter` drops the `data/` prefix only inside its Git
  calls to the data repository and adds it back to what it prints.
- **Backups are private and automatic; sharing is deliberate.** Each
  repository's `origin` is its private backup, and `sync` and `serve`'s clock
  push both, to `origin` only. Sharing an app is pushing its code repository to
  a remote of the author's choosing, which nothing in `epicenter` does on its
  own. What is shared is the code's real history, snapshots included, so a
  code commit's message describes the code and never a record.
- **Taking an app and taking changes stay ADR-0866's.** `new --from <url>`
  clones a code repository, keeps its remote as `upstream`, and makes an empty
  data repository. `update <app> [<remote>]` merges a remote's branch into the
  code repository, `upstream` by default, snapshotting first and aborting on a
  conflict. An author takes a change back the same way:
  `epicenter update vocab brother`.
- **`undo` reverts data; Git reverts code.** When the commit `undo` reverts
  names a code commit other than the code repository's `HEAD`, its answer
  lists the code commits made since, so whoever undid a record rewrite sees
  the field change it went with. `history` shows both repositories' commits in
  time order, each marked code or data.

**First-party apps are developed on the Studio.** Capture, Reading, Tasks,
and Vocab are changed in `~/Epicenter`, and their code repositories are what
others take. This repository holds the platform and no apps: its
`apps/<app>` copies are deleted, and the platform's tests make the apps they
need in a temporary home.

## Consequences

- Git keeps records out of the code: once `data/` is a repository, `git add`
  in the code repository records it as one commit hash at most, never its
  files.
- Deleted: `epicenter publish`, the `starter` remote, and the squashed starter
  history this record first proposed. A starter is any app's code repository.
- Forks and pull requests work in both directions, because every copy of an
  app's code shares one history.
- Code and data no longer change in one commit. A field rename is a code
  commit, then data commits, written by an action or an agent, that name it.
  A read does not report a mismatch between them: a key no field declares goes
  to `other`, and a missing optional field is no problem. After an undo or a
  restore, `Code-Commit` is what says which code the data was written for.
- Restoring is two clones: the code's backup, then the data's backup into
  `data/`. The listing warns when the data's newest `Code-Commit` is not in the
  code's history.
- An app has two backups, and the listing reports each.
- A secret pasted into code is shared with the code. Secrets belong in `data/`
  as `*.local` files (ADR-0876).
- `git clean -ffdx` in the code repository deletes `data/`, with any history
  not yet pushed. The `epicenter-app` skill says so.
- Each Studio app's current repository becomes its data repository, history
  included, with its code files removed in one commit; its code starts a new
  repository.
- An app's code builds wherever `epicenter` is installed: `epicenter`
  supplies `@epicenter/app` (ADR-0873), the view owns the components it copied
  (ADR-0874), and nothing names a `workspace:` or `catalog:` version. Changing `@epicenter/app` no longer
  typechecks the first-party apps in this repository.

## Considered alternatives

- **A starter published from the app, one squashed commit per publish** (this
  record's first draft). The starter shares no history with the app, so a
  change made in someone's copy returns only as a cherry-pick, and the next
  publish carries it again.
- **Code and data on two branches of one repository,** the data branch
  checked out at `data/` as a worktree. One `git push --all` or wrong refspec
  publishes the records.
- **`data/` as a submodule.** Every data commit changes the code repository's
  recorded commit, and `.gitmodules` puts the private data URL in the shared
  repository.
- **The app's history with the records filtered out.** Commit messages and
  paths from before `data/` still name records, and each filter rewrites the
  history others merged.
- **Copying code with its source commit and merging file by file** (an
  `epicenter add`). `epicenter` would own a merge Git already does, and the
  author still needs a repository without records to copy from.
- **One data repository for the whole Epicenter.** Git does not track files
  inside a nested repository, so `~/Epicenter/.git` cannot hold
  `<app>/data/` while `<app>` is a repository.
- **Code pushed to a shared `origin` on `serve`'s clock.** Every unfinished
  edit an agent makes would reach everyone who takes the app.
