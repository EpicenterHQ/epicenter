# 0852. An app is a Git repository of files and actions

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at Epicenter Cloud, which hosts a remote and a computer rather than being a separate product. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `epicenter new`, which becomes `epicenter add` from a built-in template; at `package.json`, which an app needs only for its own dependencies and editor types; and at the `{ from, sha }` record, which the `upstream` branch already holds.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (your Epicenter), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (the commit rule), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0853](0853-collections-give-four-actions-and-programs-without-the-folder-ask-over-mcp.md) (collections and programs), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binary files).
- **Unbuilt:** the registry, the built-in template as a source, `@epicenter/app` supplied by `epicenter`, and Epicenter Cloud.

## Context

An earlier draft of this record described Epicenter as one contract and four
"slots" (code, remote, your Epicenter, screens), each an open standard with an
Epicenter default. The four were not one kind of thing, and the grouping hid
what an app is. Later passes found the same overload in other words: "verb"
beside "action", a "runner" that meant the CLI, a run, `serve`, and your
Epicenter at once, and "standalone app" as a category of its own.

## Decision

**Epicenter has five nouns.**

| Noun | What it is |
| --- | --- |
| an app | a folder in a Git repository: files plus `epicenter.ts`, which declares collections and actions |
| an action | something a person or program can ask an app to do. Each collection gives `list`, `show`, `save`, and `delete` (ADR-0853); the author writes the rest (ADR-0841) |
| `epicenter` | the program that runs an action in a folder: it checks the input, runs it, makes one commit or nothing (ADR-0850), and pushes. `epicenter serve` is the same program at an address |
| your Epicenter | the computer where `epicenter serve` always runs and the person's sign-ins live (ADR-0849) |
| Git | commits, `origin` (where copies meet), `upstream` (where the code came from), `.gitignore` (so `.cache/`, ADR-0854), and LFS (ADR-0856) |

```txt
vocab/                 a Git repository
  epicenter.ts         its collections and actions
  words/*.md           its data
  .cache/              ignored by Git, so never committed
```

Everything else is a program, and a program reaches an app one of two ways.

**Have the folder: write files and commit what you wrote. Don't have it, or
need a sign-in or an app's rule: ask for an action.** A person's editor, Claude
Code, and Whispering have the folder. Claude elsewhere, the terminal on another
computer, and the Epicenter app ask over MCP (ADR-0853). An action is for an
edit that needs a rule, a sign-in, or the world outside the folder; anything
else can be a plain edit.

**Code arrives one way: `epicenter add <source>`** copies an app's files from a
Git URL into a new repository and keeps the source as its `upstream` branch
(ADR-0841), which records where it came from and at which commit.
`epicenter new <name>` is `add` from a built-in template, which includes
`epicenter.ts`, a `.gitignore` with `node_modules/` and `.cache/`, a
`.gitattributes` (ADR-0856), and a `package.json` for editor types.

**`epicenter` supplies `@epicenter/app`.** An app's `epicenter.ts` imports it
whether or not the folder has `node_modules`, so an app that declares only
collections is one file. An app adds `package.json` for its own dependencies,
and for types in an editor.

**Epicenter provides defaults, each an ordinary instance of an open standard.**
The registry is a list of Git URLs. Epicenter Cloud hosts an app's `origin` (a
repository on Cloudflare Artifacts) and can be your Epicenter (a container
running the same `epicenter serve`). The Epicenter app is a program that asks
over MCP. A person who takes every default installs the Epicenter app, signs
in, and never sees Git; a developer uses any Git host, their own computer, or
their own program without changing an app.

## Consequences

- Leaving a default is changing `origin` or running `epicenter setup` on one's
  own computer.
- An app works in every program that asks over MCP once it is added.
- Reminders (ADR-0855), templates, and the registry are apps and Git URLs, not
  further nouns.
- Verified 2026-11-08 with Bun 1.4.3: a binary from `bun build --compile` that
  registers `@epicenter/app` with `plugin().module()` loads an `epicenter.ts`
  importing it from a folder with no `node_modules`.

## Considered alternatives

- **One contract and four slots (this record's earlier draft).** A category for
  swappable pieces that are not one kind of thing.
- **"Verb" for every action, and "action" for the hand-written ones.** Two words
  for one thing a client sees.
- **Programs only ask for actions, never write files.** A program that writes
  only its own new files would ship `epicenter` (about 70 MB, measured) or
  depend on it, to run three Git commands.
- **Epicenter Cloud as its own product with its own sync.** A second
  implementation of the remote and of your Epicenter.
- **A separate `new` with its own scaffolding.** A second way code arrives.
