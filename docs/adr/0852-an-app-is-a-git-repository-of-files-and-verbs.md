# 0852. An app is a Git repository of files and verbs

- **Status:** Proposed
- **Date:** 2026-11-08
- **Amends:** [ADR-0844](0844-one-runner-runs-anywhere-and-every-surface-is-a-view-over-it.md) at Epicenter Cloud, which hosts a remote and a computer rather than being a separate product. [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `epicenter new`, which becomes `epicenter add` from a built-in template.
- **Relates:** [ADR-0849](0849-your-epicenter-is-one-always-reachable-computer-that-runs-named-actions.md) (your Epicenter), [ADR-0850](0850-running-an-action-makes-one-commit-or-nothing.md) (the commit rule), [ADR-0851](0851-each-app-has-one-git-remote-its-meeting-point-and-backup.md) (`origin`), [ADR-0853](0853-collections-give-an-app-its-standard-verbs-and-screens-are-clients.md) (collections and screens).
- **Unbuilt:** the registry, the built-in template as a source, and Epicenter Cloud.

## Context

An earlier draft of this record described Epicenter as one contract and four
"slots" (code, remote, your Epicenter, screens), each an open standard with an
Epicenter default. The four were not one kind of thing: code and remote are
both Git remotes, your Epicenter is a computer, and screens are what ask it.
The grouping answered which pieces can be swapped, which the open standards
underneath already answer, and hid what an app is.

## Decision

**An app is a Git repository: files plus verbs.** Its files are its data and
its code. Its `epicenter.ts` names its verbs: each collection gives `list`,
`show`, `save`, and `delete` (ADR-0853), and actions are the verbs the author
writes (ADR-0841). A person can always edit the files by hand; an action is for
an edit that needs a rule, a sign-in, or the world outside the folder. Whatever
a verb writes becomes one commit (ADR-0850).

```txt
vocab/                 a Git repository
  epicenter.ts         its verbs
  words/*.md           its data
  .cache/              ignored by Git, so never committed

origin                 where every copy meets: GitHub, or Epicenter Cloud
upstream               where the code came from: a Git URL, or the registry

your Epicenter         the computer that's always on and holds your sign-ins
every other client     asks it through one address: the terminal, Claude, a screen
```

Git supplies the rest of the vocabulary: clone, remote, commit, and
`.gitignore`. Epicenter adds verbs and your Epicenter (ADR-0849).

**Code arrives one way: `epicenter add <source>`** copies an app's files from a
Git URL into a new repository and keeps the source as its `upstream` branch
(ADR-0841). `epicenter new <name>` is `add` from a built-in template, which
includes `epicenter.ts`, `package.json`, and a `.gitignore` with
`node_modules/` and `.cache/`.

**Epicenter provides defaults, each an ordinary instance of an open standard.**
The registry is a list of Git URLs. Epicenter Cloud hosts an app's `origin` (a
repository on Cloudflare Artifacts) and can be your Epicenter (a container
running the same `epicenter serve`). The Epicenter app is a screen. A person who
takes every default installs the Epicenter app, signs in, and never sees Git; a
developer uses any Git host, their own computer, or their own client without
changing an app.

## Consequences

- Leaving a default is changing `origin` or running `epicenter setup` on one's
  own computer.
- An app works in every client once it is added, because clients see only verbs.

## Considered alternatives

- **One contract and four slots (this record's earlier draft).** A category for
  swappable pieces that are not one kind of thing.
- **Epicenter Cloud as its own product with its own sync.** A second
  implementation of the remote and of your Epicenter.
- **A separate `new` with its own scaffolding.** A second way code arrives.
