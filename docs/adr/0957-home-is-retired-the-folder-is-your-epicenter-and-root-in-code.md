# 0957. "Home" is retired: the folder is your Epicenter, and `root` in code

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** the vocabulary of [ADR-0903](0903-the-home-is-a-computer-its-person-controls-owned-or-rented.md), [ADR-0936](0936-one-serve-per-home-runs-every-action.md), [ADR-0940](0940-git-stores-the-home-and-epicenter-does-not-wrap-it.md), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) and [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md). Their decisions stand; their titles keep the word they were written with.
- **Unbuilt:** all of it. Identifiers, docs and the `x-epicenter-home` header still say "home".

## Context

"Home" names two things. ADR-0903 and `docs/vision.md` use it for the computer
a person keeps on. ADR-0936, 0940 and 0942, the command's README, `installHome`
and `loadHomeApp` in `packages/cli/src`, and the `epicenter-home` package name
`init` writes use it for the folder. The starter `AGENTS.md` and `EPICENTER.md`
call that same folder "an Epicenter". So the folder has two names, and "home"
points at two things. It also reads as `$HOME`: "run `bun install` at the top
of the home" can send an agent to `~`.

## Decision

**The word "home" is retired. Each thing gets the plainest word that names
only it.**

| Thing | A person reads | Code says |
| --- | --- | --- |
| The folder `~/Epicenter`, one Git repository and Bun workspace | your Epicenter | `root`; `epicenterRoot()`; `EPICENTER_ROOT` |
| The computer it runs on | the computer | not named |
| One app's folder, `apps/<app>/` | the app | the app folder; `folder.path` |

- `epicenterDir()` becomes `epicenterRoot()`, and each identifier with
  "home" in it takes "root" or loses the word: `loadHomeApp` is `loadApp`,
  `homeEntries` is `rootEntries`, `installHome` is `installRoot`.
- The `x-epicenter-home` header becomes `x-epicenter-root` and keeps its
  job: serve refuses a call meant for another Epicenter that reached its
  port. It carries the root's absolute path, which shows the account name to
  every device on the private network. A name or a hash of the path would do
  the same job; that change is left for its own decision.
- The root `package.json` is named `epicenter`. It is
  private and never published, so the unrelated public `epicenter` package on
  npm does not matter.
- App, action, record, routine, `serve`, `apps/`, `code/`, `data/`, `local/`,
  `epicenter.ts`, `EPICENTER.md` and both package names are unchanged.

## Consequences

- People meet one noun for what they own and reach from their phone: their
  Epicenter. Nothing they type changes.
- About 45 identifiers and some 300 mentions in comments and tests change,
  mostly in `packages/cli`. The command's README, the vision and the
  `epicenter-app` skill are rewritten.
- An existing Epicenter renames one private package name and refreshes its
  `AGENTS.md`. Its folders and commands stay as they are.

## Considered alternatives

- **"Home" means the computer only** (the vision's usage). It keeps a word
  that most code and records use for the folder, so more text changes, and
  the `$HOME` reading remains.
- **"Home" means the folder only** (the code's usage). Fewer edits, but the
  `$HOME` collision stays, and the vision's sentences about the computer need
  a word anyway.
- **"Hub" for the computer.** In sync systems a hub relays between devices,
  which Epicenter never does, and the word would be spent before a sync layer
  could use it. People never need a noun for the computer: they reach their
  Epicenter.
- **"Workspace" for the folder.** Exact for Bun, but people read it as a
  hosted team space, and "the workspace's `workspaces`" is confusing.
