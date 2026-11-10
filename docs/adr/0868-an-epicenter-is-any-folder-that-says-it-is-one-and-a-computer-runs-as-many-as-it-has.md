# 0868. An Epicenter is any folder that says it is one, and a computer runs as many as it has

- **Status:** Proposed
- **Date:** 2026-11-10
- **Supersedes:** [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md) at "`~/Epicenter` exists on your server and is not moved by an environment variable": the Epicenter is found from where you stand, and `~/Epicenter` is only the fallback. [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) at a folder run by path, and `epicenter link`: every app runs inside an Epicenter.
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at the Keychain service `epicenter.<name>`, now `epicenter.<Epicenter id>.<app>`. [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) at the verbs' names: an app with one collection has them as its own. [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) at the public HTTPS address through Funnel: `serve` signs no one in, so it stays on the tailnet until a sign-in is built. [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) at what a commit takes: never `*.local` or `*.local.*` (since amended by ADR-0850: the app's `.gitignore` leaves them out, and a commit refuses one it lets through).
- **Relates:** [ADR-0857](0857-an-app-is-one-epicenter-ts-that-composes-collections-and-actions.md) (an app is its `epicenter.ts`, which places its verbs), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters, `update`), [ADR-0867](0867-the-command-line-spells-an-actions-json-input-and-null-removes-a-field-there-as-everywhere.md) (the command line's input), [ADR-0865](0865-the-epicenter-mac-app-runs-epicenter-serve-so-the-computer-it-is-on-is-your-server.md) (the Mac app that would start each `serve`).
- **Open:** a sign-in for a public address. (Whether a write in an app outside any Git repository exits 3 was settled 2026-11-11 by ADR-0850: no run commits, and such an app is never snapshotted, so it exits 0.)

## Context

`~/Epicenter` was the only list of apps. The author wants one always-on
computer to hold several people's apps (their own, their brother Bryce's, and
the family's), each reached by its own people and agents, and to put an
Epicenter wherever they like. Every call also stuttered: each app has one
collection, so the command was `epicenter tasks tasks set` and the MCP tool
`tasks_tasks_set`. Three reviewers, two Codex and one Claude, each drew their
own layout and command line from the intended use and then argued the
differences to one direction, which this records (2026-11-10).

## Decision

**An Epicenter is a folder holding `epicenter.root.json`. Its apps are the
folders directly inside it with an `epicenter.ts`, each its own Git
repository. `epicenter` works on the Epicenter you are standing in, and
`epicenter serve` offers that one Epicenter on its own port.** A computer runs
as many as it has folders; a folder that holds several is only a grouping.

```txt
/Users/Shared/Epicenters/            a grouping, not an Epicenter
  braden/
    epicenter.root.json              { "id": "…", "port": 4747 }
    AGENTS.md                        guidance for agents; serve sends it as MCP instructions
    tasks/                           an app: its own Git repository
      .git/                          history; remotes upstream (its starter) and origin (its backup)
      .gitignore                     node_modules/  .cache/  *.local  *.local.*
      epicenter.ts                   its collections and actions
      ui/                            its UI project (optional)
      .cache/ui/                     the built UI; rebuildable, never committed
      tasks/<time>.md                data, committed
      token.local.json               this computer only; Epicenter never commits it
    capture/  vocab/  mail/
  bryce/      epicenter.root.json { "port": 4748 }, AGENTS.md, vocab/
  family/     epicenter.root.json { "port": 4749 }, AGENTS.md, groceries/
```

**Which Epicenter.** The nearest folder at or above the current directory
holding `epicenter.root.json`; else `EPICENTER_ROOT`; else `~/Epicenter`.
Where you stand wins over the variable, because a variable exported in a shell
profile is a default, and `cd` into Bryce's Epicenter must reach Bryce's apps.
`serve` starts each run with the Epicenter's folder as its working directory,
so the run finds the same one. A chosen folder without the file is refused,
naming `epicenter init <folder>`. Epicenters do not nest.

**The marker holds an id and a port.** `epicenter init` writes a random `id`
once; nothing shows it. `port` is optional, 4747 when absent, and `--port`
overrides it. The display name is the folder's name. The marker is a file
of its own, not part of any app's `epicenter.ts`, because the two are
different things:
an app is a repository that syncs, and an Epicenter is a grouping on one
computer that never leaves it.

**Secrets belong to an app in one Epicenter.** The Keychain service is
`epicenter.<id>.<app>`. Two Epicenters each with `mail` hold two tokens;
renaming or moving the Epicenter keeps them. Moving an app into another
Epicenter means entering its secrets again, which is right: the app now
belongs to someone else. Deleting `epicenter.root.json` orphans them, so the
marker is as worth keeping as the data.

**An app with one collection has its verbs as its own.** `epicenter tasks
set <path> --done`, the MCP tool `tasks_set`, and `app.set({ path, done })`
from a UI. An app with several keeps each verb under its collection:
`epicenter mail messages list`. The app says which in `defineApp`, by
spreading its collection's verbs at the top or nesting them under its name
(ADR-0857); adding a second collection is a redesign of the app and renames
the first's actions where everyone sees.

**Commits never take `*.local` or `*.local.*`.** Each app's `.gitignore`
leaves them out, so every Git tool honors it. Before staging, Epicenter's
commit refuses when what it would take holds one, naming the file and the
`.gitignore` to fix (ADR-0850, amended 2026-11-11; it first left them out with
its own pathspec, which only its own commits honored). A person can still
`git add -f` one.

**The command line.**

```txt
epicenter                                  this Epicenter's folder and apps; none yet → Run: epicenter new <name>
epicenter <app>                            what the app does
epicenter <app> <verb> [<positionals>] [--field value | --field null] [--input <json>|-] [--json]
epicenter init [<folder>] [--port <n>]     make a folder an Epicenter: epicenter.root.json and AGENTS.md
epicenter new <app> [--from <git url|path>]
epicenter update [<app>]                   merge the starter, list files that no longer fit, build
epicenter build [<app>]                    build the UI, keeping the last one that built
epicenter sync [<app>]                     commit what is left, pull and push origin
epicenter serve [--port <n>] [--host <address>] [--stdio]
epicenter --help | --version
```

`build` is its own verb because the UI project's own `bun run build` empties
`.cache/ui/` before writing it, so a page served meanwhile is missing, and a
failed build leaves none; `epicenter build` keeps the last one that built.

**Separation is ports, not sign-in.** Each Epicenter is served on its own
port, and the tailnet's access rules say who reaches which port. Everyone on
one computer under one user can read every Epicenter's files and Keychain:
separating people from each other's devices and agents is this design;
separating them from the computer's administrator is a separate OS user or a
separate computer, and moving an Epicenter there is moving its folder.

## Consequences

- `epicenter link` and `epicenter <path> <action>` are gone, with the
  alternate-spelling refusal. A symlinked app inside an Epicenter still works.
- The Epicenter folder is in no repository: its `AGENTS.md` and marker are
  backed up only by the computer's own backup. Each app backs up to its
  `origin`; no root-wide origin pattern is kept, since a pattern neither
  creates nor checks a remote and would send a moved app's data to the old
  owner's backup.
- Claude's and ChatGPT's custom connectors connect from their companies'
  servers and need a public HTTPS address with a sign-in. Until one is built,
  an Epicenter is reached from devices on the tailnet: Claude Code and other
  local agents over SSH or the tailnet address, and the UIs in a browser.
- Existing Keychain entries under `epicenter.<app>` are not read. Mail is not
  built, so the author's Studio is expected to have none; that is to be
  checked by the person, not by an agent.
- The MCP tool names and UI calls of Capture, Tasks, and Vocab changed
  (`tasks_tasks_set` to `tasks_set`); a client's saved tool permissions name
  the new tools.

## Considered

- **One Git repository per Epicenter.** One backup instead of several, but
  sharing one app means sharing all, moving an app loses its history, every
  write waits on one index lock, and a starter's `update` would need a subtree
  merge.
- **The marker merged into `epicenter.json`.** One file name for two kinds of
  folder; walking up from an app would read its declaration to learn it is
  not the Epicenter, and editors would offer `port` inside an app.
- **Secrets in the app as `secrets.local.json`.** They would move with the
  app, but a token would be one `cat` away from any agent working in the
  folder. **An id in each app's `.git/config`.** Apps inside a larger
  repository share one config, and a fresh clone loses it.
- **A declared `collection` field for an app's own collection.** It keeps
  names stable when a second collection is added, at the cost of a second
  declaration shape for a case none of the apps has.
- **One `serve` for several Epicenters at `/bryce/…`.** One port for everyone,
  which removes what lets the tailnet's rules tell people apart.
- **`EPICENTER_ROOT` before walking up.** Matches `GIT_DIR`, but nobody exports
  `GIT_DIR` in a profile; a person would `cd` into Bryce's Epicenter and act
  on their own.
