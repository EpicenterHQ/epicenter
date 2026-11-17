# 0880. An Epicenter runs its apps as they sit on disk

- **Status:** Proposed
- **Date:** 2026-11-11
- **Amended by:** [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md): a UI is what the app's own `bun run build` writes to `ui/dist/`, and `serve` only serves it; actions still run as they sit on disk.
- **Amended:** 2026-11-11: a call runs in the process that received it, the command line's or `serve`'s, not in a child `epicenter` per call; each load first drops the modules the process loaded from under the app's folder, so the next import reads the files as they are now. Deleted with the child: its report file, the `--report` and `--read-only-call` flags, signal forwarding, its IPC channel for yields, and `serve --stdio`. Given up: a call that outlives the `serve` that started it, and isolation from an action that exits, hangs, or changes the process's working directory or environment; the code is its owner's (ADR-0864), and `serve`'s job restarts it.
- **Built:** imports and module invalidation under code/, code-package installation, UI fingerprint builds (removed by ADR-0944), the compiled app package, the container write lock, and root checkpoints in packages/cli.
- **Migrated:** the live Epicenter history import and code/data directory cutover described in [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md).
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (a call's commit; the lock; the clock), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (an app's UI), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (code runs where its owner trusts it), [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (the command supplies `@epicenter/app`), [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) (`data/`), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (historical repository split).

## Context

An Epicenter's code is edited where it runs: on the server, by its owner and
their agents, over SSH or MCP. Its actions already run whatever `epicenter.ts`
is on disk, since each call loaded the file in a fresh process. Two other parts
follow commits instead, and each carries machinery for it:

- A UI follows the code repository's `HEAD`: a stamp, a detached worktree, a
  background rebuild when `HEAD` moves. A UI edit shows once committed, while
  an action edit takes effect at once.
- The former data commit trailer names `HEAD`, but the action may have run
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
~/Epicenter/                         one private Git repository
  EPICENTER.md  AGENTS.md
  apps/tasks/                       stable container and write lock
    code/                           one Bun project
      epicenter.ts  package.json  bun.lock
      node_modules/                 includes supplied @epicenter/app link
      ui/                           source; build goes in ui/dist/
    data/                           records and local credentials
```

- **An app's code/ is one Bun project.** One `package.json`, one `bun.lock`, one
  `node_modules`, under `code/`, for its actions, its UI and its tests.
  `ui/` is a folder of source, not a project. `epicenter new` and
  `install` install from the lock; an agent adding a package runs `bun add` in `code/`,
  which installs. After `bun add`, run `epicenter install <app>` to restore the supplied @epicenter/app link, which Bun can remove. Nothing installs on a call.
- **`@epicenter/app` comes from the command.** `epicenter` links
  `node_modules/@epicenter/app` to its own copy after every install
  (ADR-0873), and no app lists it. A compiled `epicenter` writes the package
  it carries (its source, `/client`, types and `exports`) to a folder of its
  own, once per version, and links to that.
- **A UI is optional and any framework.** An app with no `ui/` is its actions
  over its files. When an app has one, `serve` builds it when its fingerprint
  changes and serves `code/ui/dist/` at `/<app>/`:
  - The fingerprint is the path, size and modified time of every file under
    `ui/`, with `package.json`, `bun.lock`, the `epicenter` version, and where
    its own `@epicenter/app` is with the files in its `src/`, so an upgraded
    `epicenter`, one run from another checkout, or an edit to the client
    rebuilds every UI against the client of the `serve` that answers it.
    `serve` relinks every installed app to its own `@epicenter/app` when it
    starts.
  - `serve` checks it on a request for the UI's `index.html`, builds in the
    background, and serves the last good build meanwhile. A failed build is
    remembered by fingerprint and not retried until something changes.
  - The app's `build` script builds it when `package.json` has one, into the
    folder `EPICENTER_OUT` names; otherwise Bun bundles `ui/index.html`. The
    finished folder replaces `ui/dist/` by rename. A build writes relative
    URLs, so it is never told where it is served.
  - The word for it is UI; "view" is retired.
- **A call runs where it arrives, from the files as they are.** The command
  line runs a call itself, and so does `serve`. Each load of an app first
  drops every module the process loaded from under the app's `code/`, its
  `node_modules` included, then imports `code/epicenter.ts`, so an edit to it, or
  to anything it imports, reaches the next call. Measured 2026-11-11 on Bun
  1.4.3: an edit to `epicenter.ts`, a file it imports, and a package in its
  `node_modules` each reached the next import, and 300 reloads grew the
  process by 8 MB. A run already holding the old modules keeps them.
- **Reads reach the whole Epicenter.** An action reads any file under the
  Epicenter with `node:fs` or any library, another app's records included:
  `../tasks/data/tasks/<time>.md`.
- **A call makes no Git commit.** Its first folder write takes the container
  lock, held until the action returns, throws, or stops. The call leaves its
  writes pending. A call with no folder write takes no lock.
- **Another app's data changes through that app's actions**, as guidance in
  the `epicenter-app` skill, so its rules check the write. `epicenter`
  does not check it, and has no API yet for one app's action to call
  another's.
- **A read-only call takes no lock and commits nothing,** including when it
  writes a `.local` file, which is never committed.
- **The clock checkpoints the root.** At startup, every five minutes after a
  scheduled pass completes, and on stop, serve records included code and data
  in one commit and pushes the root origin when needed. Its root lock is
  independent of the container lock, so this is sampled history.

## Consequences

- An app may import Google's SDK, an AI SDK, or anything else, and a library
  may write the app's files. Its owner trusts what it installs as they trust
  its code.
- A slow action still blocks other writes only from its first `folder` write
  until it ends: fetch first, write last.
- Direct edits and interrupted writes remain pending for a root checkpoint.
  No code trailer attributes those bytes to an action.
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
- **Commit pending code before each call to name the loaded code exactly.** An
  agent's partial edit, staging included, becomes a commit per phone tap, and
  a code repository mid-rebase blocks every write. This alternative is historical; actions no longer consult Git.
- **No clock; push after each commit.** A command-line call never reaches
  `serve`, and code edited with no call after it would never be committed or
  backed up.
- **A child `epicenter` per call (built, replaced 2026-11-11).** A fresh
  process read the files as they were, kept an action's prints off the
  answer, and finished its commit if `serve` died. It cost a report file,
  flags to say what the child was, signal forwarding, and, for yields, an IPC
  channel whose last message was lost when the child exited at once (20 of
  20 runs with a 200 KB message). Dropping the app's modules before each load
  gives the first; the command line sends prints to stderr during a call for
  the second; the root checkpoint records what an interrupted call left.
- **A Bun Worker per call.** Measured 2026-11-11: a fresh module graph per
  Worker, `process.env` and globals kept apart, `process.exit` ending only the
  Worker. But `process.chdir` in a Worker moved the whole process's directory,
  and a crash still ends `serve`, so it isolated little more than one process
  does, behind a message protocol.
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
