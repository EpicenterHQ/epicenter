# 0866. An app starts from a starter kept as its `upstream`, and `epicenter update` merges the starter's changes

- **Status:** Proposed
- **Date:** 2026-11-10
- **Amended:** 2026-11-11: `update` snapshots what is pending before it merges, as `undo` does, instead of refusing an app with uncommitted changes, and no longer lists files that do not fit their collection's fields, since every read of such a file says so in its `problems`.
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (one copy; the install rules this replaces), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (`origin`), [ADR-0852](0852-an-app-is-a-folder-with-a-declared-shape-and-each-job-takes-the-least-powerful-form.md) (`new`, `link`), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (rebuilt files, ignored where their tool writes them), [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (`epicenter.ts`), [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (`*.local`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (the UI).
- **Unbuilt:** starters in repositories of their own, published from the Studio's apps (ADR-0877): Capture, Tasks, and Vocab have the layout in `apps/<app>/`, which builds only inside this repository until `@epicenter/app` is published (ADR-0873). Records under `data/` (ADR-0876).

## Context

`epicenter install <path|git url>` copies the files named in `install.ts`'s
`CODE` list (`epicenter.json`, `epicenter.ts`, a committed `view/`) into
`~/Epicenter/<app>`, commits them with `Source:` and `Source-Commit:`
trailers, and builds the view into `.cache/view/` (ADR-0864). Installing again
overwrites a change made in place, so an app either "has a source" and is
changed there, or "is its own source" and is changed in place. The list missed
`.gitattributes`; the Studio's trailers name a worktree path that will be
deleted; a view in development talks to the installed copy rather than the
source it was built from. Git already tracks where code came from and merges
someone else's changes with one's own: a fork and its upstream.

## Decision

**An app is a Git repository of three kinds of file, each with one author.**

```txt
~/Epicenter/vocab/
  epicenter.ts     the app: its collections and actions       from upstream; yours to change
  package.json     what the actions' types and tests need      from upstream
  ui/              the UI's source, a project of its own       from upstream; yours to change
  README.md        what the app is, for people and agents      from upstream
  .gitignore  .gitattributes                                   from upstream
  data/words/*.md  data                                        yours alone
  ui/dist/        the built UI, served at /vocab/             built on this computer, ignored by ui/.gitignore
  node_modules/    installed packages                          ignored (ADR-0854)
  *.local          kept on this computer                       ignored (ADR-0858)
```

- **A starter is an app with no data.** It is a repository of its own whose
  root is the app's root. It holds no `data/` (ADR-0876).
- The UI is called the UI, and its folder `ui/`: a project with its own
  `package.json`, whose `build` writes `ui/dist/` (ADR-0860). `epicenter
  serve` serves `ui/dist/` at `/<app>/` and nothing else. The UI refers to its
  files by relative paths, so it builds the same under any folder name.
- `epicenter` supplies `@epicenter/app` to `epicenter.ts` when it runs it; the
  root `package.json` serves only whoever edits or tests the actions.
- Records live under `data/`, and everything tracked outside it is code
  (ADR-0876), so `update` merges code and never a record.

**`epicenter new <name> --from <git url|path>` makes an app from a starter.**
It clones the starter into `~/Epicenter/<name>`, renames the clone's remote to
`upstream`, leaves the branch tracking nothing, installs the UI's packages, and
builds it. Making an app from a starter runs the starter's `epicenter.ts`; it
is the decision to trust it, as cloning and running any repository is.
`epicenter new <name>` without `--from` uses the built-in starter, as now.

**`epicenter update [<app>]` brings in the starter's changes.** For each app
with an `upstream`, it:

1. runs `git fetch upstream`;
2. holding the app's lock (ADR-0850), snapshots what is pending as
   `<app>: changed outside epicenter`, so the merge never mixes with an edit
   not yet in history, and merges `upstream`'s branch; on a conflict it
   aborts the merge, leaves the app as it was, and prints
   `git -C ~/Epicenter/vocab merge upstream/main` for whoever resolves it;
3. builds the UI, keeping the last `ui/dist/` that built if this build
   fails. The build installs from the starter's committed `ui/bun.lock`, or
   writes no lockfile when it has none, so it never leaves the app with
   uncommitted changes.

The merge commit records what came in; nothing writes trailers.

**Backups go to `origin` only.** `epicenter sync` and `epicenter serve` push
`HEAD` to `origin` by name and never to `upstream` or a tracked branch. A
change made in someone's app reaches its starter as any fork's does: a
cherry-pick or a pull request in the starter's repository. The starter's
author publishes their own app's changes with `epicenter publish`
(ADR-0877).

**The collections are the contract between a starter and the data.** A starter
that renames or tightens a field owns the change to existing files: every
read of a file that no longer fits says so in its `problems`, and an agent on
the computer repairs them, or the starter ships an action that does. Git merges code; it does not migrate data.

## Consequences

- Deleted: `epicenter install`, the `CODE` list, the overwrite rule, the
  `Source:` and `Source-Commit:` trailers, the empty commit for a moved source,
  serving a committed `view/` in place of a built one, "an app has a source or
  is its own source", and ADR-0864's list of trusted repositories. Every app is
  its own source, and its code is changed where it is.
- `update` can stop on a conflict when both the starter and the app changed the
  same lines. A person who never changes an app's code never meets one, because
  a starter holds no data.
- An app's history includes its starter's commits.
- First-party starters are published from the Studio's apps (ADR-0877) into
  repositories of their own, and build against the published `@epicenter/app`
  (ADR-0873) and the components they copied (ADR-0874), as anyone else's do.
- The Studio's apps are their starters' source, so they have no `upstream`.
- `epicenter sync` is no longer the only command that touches a remote:
  `update` fetches `upstream`.
- The word "view" in the code, the records, and the `epicenter-app` skill
  becomes "UI" when the code is renamed.

## Considered alternatives

- **`epicenter install`, copying listed files (ADR-0864).** A list of what
  counts as code, an overwrite rule, and trailers that do what a remote does.
- **A GitHub template repository.** It shares no history, so an app could never
  take the starter's later changes.
- **Code apart from data, in `~/Epicenter/.apps/<name>`.** Two places per app,
  joined by name.
- **A remote named `source`.** Avoids Git's other "upstream", the branch a
  branch tracks; `upstream` is what `gh repo fork` writes and what agents type.
  The cost is wording: `sync` stops saying "no upstream".
- **A remote named `template`.** A GitHub template shares no history, which is
  the opposite of this.
- **The UI's folder named `view/`.** A view reads as read-only, as a database
  view is; the folder is a frontend project that writes through actions.
