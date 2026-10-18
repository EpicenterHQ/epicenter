# 0624. A repository reports synced, pending, disconnected, or stuck

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Sync still refuses, as `SyncError.Unrepresentable`" and its list: the only refusals are what Git or a client cannot represent, and each is a cause of `stuck`.
- **Relates:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync whose state this reports), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the CLI).
- **Unbuilt:** all of it: the four words in `@epicenter/data`, the CLI reporting each cause, and the full list of what a client cannot represent.

## Context

Sync stops with typed errors: `SyncError.Unrepresentable`
(`packages/folder/src/git/errors.ts`) for a tree holding a link, an
executable, a submodule, a Git attribute filter, an invalid path, or two
paths only their case tells apart
([ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)),
beside `Unrelated`, `Fetch`, `Blocked`, `KeptChanging`, `Publish`, and
`Failed`. Each app decides how to show each one. With every app an
ordinary client syncing on its own schedule
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)),
an app needs to know whether its edits are safe, and a person or an agent
fixing a repository needs to know what is wrong.

## Decision

**An app sees one of four words for a repository:**

```txt
synced         no unsent edits, and the clone matched the server at its last check
pending        edits not yet pushed, with a sync on its way
disconnected   the Git service cannot be reached, or refuses this clone's credential
stuck          sync cannot finish until someone fixes a cause in the repository
```

**Apps learn whether; the CLI and agents learn why.** `@epicenter/data`
gives an app the word and nothing else. The CLI reports the cause behind a
word, for a person or an agent to fix.

**The only refusals are what Git or a client cannot represent, and each is
a cause of `stuck`.** ADR-0592's list is such causes. Nothing about a file's
content, a table's description, or an app's schema is a refusal.

## Consequences

- An app renders one badge from four values, and every app means the same
  thing by each.
- An app cannot tell a person why a repository is `stuck`; the person opens
  the CLI or asks an agent.
- A malformed row never makes a repository `stuck`; it is a `check` line.

## Considered alternatives

- **Typed sync errors in the app API.** Every app then renders and words
  each cause itself, and a new cause is a breaking change to every app.
- **Refusing writes a description does not allow.** A repository becomes
  `stuck` because one app is a field behind another.
