# 0880. An Epicenter runs its apps as they sit on disk

- **Status:** Proposed
- **Date:** 2026-11-11
- **Built:** a call's commit of what it left in `data/`, `Code-Commit` with `Code-Dirty`, the clock's idle skip, and `epicenter install` (`packages/cli/src/run.ts`, `snapshot.ts`, `http.ts`, `install.ts`); the UI's fingerprint build into `EPICENTER_OUT` (`ui.ts`); the compiled command's copy of `@epicenter/app` and `linkAppPackage` (`app-package.ts`, `scripts/compile.ts`); Capture, Reading, Tasks, and Vocab on the Studio, each one Bun project on Bun's bundler.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a call's commit; the lock; the clock), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (an app's UI), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (code runs where its owner trusts it), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (the command supplies `@epicenter/app`), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (two repositories, `Code-Commit`).

## Context

An Epicenter's code is edited where it runs: on the server, by its owner and
their agents, over SSH or MCP. Its actions already run whatever `epicenter.ts`
is on disk, since each call loads the file in a fresh process. Two other parts
follow commits instead, and each carries machinery for it:

- A UI follows the code repository's `HEAD`: a stamp, a detached worktree, a
  background rebuild when `HEAD` moves. A UI edit shows once committed, while
  an action edit takes effect at once.
- A data commit's `Code-Commit` names `HEAD`, but the action may have run
  uncommitted code, so the trailer can be false.

A call commits exactly the paths it wrote through `folder`, so every write
must go through `folder`, and nothing installs an app's own packages, so
`epicenter.ts` imports nothing but `@epicenter/app` and Node. An app cannot use
Google's SDK, an AI SDK, or a library that writes a file.

The code on an Epicenter is code its owner trusts (ADR-0864). Rules that guard
against an app's own code are not needed; rules that keep history true are.
Whoever can reach an Epicenter can use every app in it.

## Decision

**An Epicenter runs each app as it sits on disk. Git is history, backup and
sharing, never deployment.**

```txt
~/Epicenter/
  EPICENTER.md  AGENTS.md
  tasks/                    one Bun project, one Git repository (the code)
    package.json            everything the actions and the UI import, except @epicenter/app
    bun.lock
    epicenter.ts            may import anything package.json names
    ui/                     optional: source only, built into ui/dist/
      index.html
    data/                   its own Git repository (the data)
```

- **An app is one Bun project.** One `package.json`, one `bun.lock`, one
  `node_modules`, at the app's top, for its actions, its UI and its tests.
  `ui/` is a folder of source, not a project. `epicenter new`, `update`, and
  `install` install from the lock; an agent adding a package runs `bun add`,
  which installs. After `bun add`, run `epicenter install <app>` to restore the supplied @epicenter/app link, which Bun can remove. Nothing installs on a call.
- **`@epicenter/app` comes from the command.** `epicenter` links
  `node_modules/@epicenter/app` to its own copy after every install
  (ADR-0873), and no app lists it. A compiled `epicenter` writes the package
  it carries (its source, `/client`, types and `exports`) to a folder of its
  own, once per version, and links to that.
- **A UI is optional and any framework.** An app with no `ui/` is its actions
  over its files. When an app has one, `serve` builds it when its fingerprint
  changes and serves `ui/dist/` at `/<app>/`:
  - The fingerprint is the path, size and modified time of every file under
    `ui/`, with `package.json`, `bun.lock`, and the `epicenter` version, so an
    upgraded `epicenter` rebuilds every UI against its own client.
  - `serve` checks it on a request for the UI's `index.html`, builds in the
    background, and serves the last good build meanwhile. A failed build is
    remembered by fingerprint and not retried until something changes.
  - The app's `build` script builds it when `package.json` has one, into the
    folder `EPICENTER_OUT` names; otherwise Bun bundles `ui/index.html`. The
    finished folder replaces `ui/dist/` by rename. A build writes relative
    URLs, so it is never told where it is served.
  - The word for it is UI; "view" is retired.
- **Reads reach the whole Epicenter.** An action reads any file under the
  Epicenter with `node:fs` or any library, another app's records included:
  `../tasks/data/tasks/<time>.md`.
- **A call commits what it left in `data/`.** A call's first write through
  `folder` or a collection takes the app's lock and snapshots anything already
  pending in `data/` as `<app>: changed outside epicenter`. Later writes may
  go any way: `folder`, `node:fs`, a library. When the action ends, the call
  commits everything pending in `data/` under its name. A call that never
  writes through `folder` takes no lock and commits nothing; what it wrote is
  snapshotted later.
- **`Code-Commit` says what ran.** Before it loads `epicenter.ts`, a call reads
  the code repository's `HEAD` and whether anything is pending there. Its data
  commit carries `Code-Commit: <HEAD>`, and `Code-Dirty: true` when the code
  had uncommitted changes. A call never commits code.
- **Another app's data changes through that app's actions**, as guidance in
  the `epicenter-app` skill, so its history names what happened. `epicenter`
  does not check it, and has no API yet for one app's action to call
  another's.
- **A read-only call takes no lock and commits nothing,** including when it
  writes a `.local` file, which is never committed.
- **`serve`'s clock stays,** since it is what commits and backs up code edited
  over SSH or MCP. A tick skips an app with nothing pending and nothing ahead
  of `origin`.

## Consequences

- An app may import Google's SDK, an AI SDK, or anything else, and a library
  may write the app's files. Its owner trusts what it installs as they trust
  its code.
- A slow action still blocks other writes only from its first `folder` write
  to its commit: fetch first, write last, as before.
- An edit made by hand to `data/` after a call's first write is committed under
  the call's name, and `undo` of that call reverts it. Edits pending before the
  first write get their own snapshot.
- `Code-Commit` with `Code-Dirty` is what ran, to within the time between
  reading `HEAD` and loading the file. No code commit is made per call.
- A UI edit shows within about a second of the next page load, committed or
  not. Deleting a file under `ui/`, or moving one in with an old modified
  time, changes the fingerprint, since its paths and sizes are part of it.
- The first-party UIs move off SvelteKit and Vite to Bun's bundler, with a
  Svelte compile plugin and a hash router of their own. Measured on Tasks:
  a build in 0.6 s instead of 2.6 s, 65 packages instead of 113, the same
  behavior in a browser.
- Deleted: the UI's detached worktree and commit stamp; `EPICENTER_BASE`;
  `ui/package.json`; SvelteKit and Vite in the starters; the write tracking
  that lists each path a call wrote; the lock on a `.local` write; the rule
  that `epicenter.ts` imports only `@epicenter/app` and Node.

## Considered alternatives

- **Take the lock when a call starts, so writes need no `folder` at all.**
  ADR-0850 removed this on 2026-11-11: a slow action blocks every write to its
  app for its whole run, up to the lock's 30-second wait. A Mail sync
  fetching for a minute would fail every write from the phone meanwhile.
- **Commit pending code before each call, so `Code-Commit` is exact.** An
  agent's partial edit, staging included, becomes a commit per phone tap, and
  a code repository mid-rebase blocks every write.
- **No clock; push after each commit.** Commits happen in each call's own
  process, a command-line call never reaches `serve`, and code edited with no
  call after it would never be committed or backed up.
- **Install from the lock on a call when it is newer.** Two calls install into
  one `node_modules` at once, or under a running action.
- **Refuse a call that changed files outside its `data/`.** After the fact it
  undoes nothing, and an agent's concurrent code edits would be blamed on
  every call.
- **An app runs its last code commit.** True by construction, but trying a
  change means committing it, which does not match editing in place.
- **Bundling a UI on each request with `Bun.serve` HTML imports.** Measured
  2026-11-11 on Bun 1.4.3: its dev mode crashes a Svelte page on a live
  binding, and its production mode writes root-absolute URLs and does not see
  a changed file.
