# 0624. A repository reports synced, pending, disconnected, or stuck

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Sync still refuses, as `SyncError.Unrepresentable`" and its list: the only refusals are a non-text write from the library, a push that would rewrite history, and what Git or a client cannot represent; on a clone each of the last is a cause of `stuck`, and a browser clone leaves a link or an executable outside tables untouched instead of refusing it.
- **Relates:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync whose state this reports), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`epicenter status`), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (`status`, `subscribe`, and `connect`).
- **Unbuilt:** all of it: the four words in `@epicenter/data`, `epicenter status` reporting each cause, and the full list of what a client cannot represent.

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
an app needs to know whether its edits are safe and whether it must ask the
person to sign in again, and a person or an agent fixing a repository needs
to know what is wrong.

## Decision

**An app sees one of four words for a repository:**

```txt
synced         no unsent edits, and the clone matched the server at its last check
pending        edits not yet pushed, a sync on its way, or the Git service unreachable
disconnected   the Git service refused or expired this origin's sign-in; the app calls connect()
stuck          sync cannot finish until someone fixes a cause in the repository or the clone
```

An unreachable server is `pending`, because the next sync needs nothing
from the person. A refused or expired sign-in is `disconnected`, because
only `connect()` mends it
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)).

**The causes of `stuck`:**

```txt
case-only twins        incoming names that differ only by case (ADR-0623)
unrepresentable names  a name, a submodule, or an attribute filter a client cannot represent
storage failure        the clone's storage refuses a read or a write
unresolved state       a sync that cannot settle what the clone holds against main
```

**Apps learn whether; the CLI and agents learn why.** `@epicenter/data`
gives an app the word and nothing else. `epicenter status` says why: the
causes of `stuck`, the changes not yet synced, and the age of the last
fetch
([ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md)).

**The only refusals are a non-text write from the library
([ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md)),
a push that would rewrite history
([ADR-0620](0620-history-in-a-repository-only-grows.md)), and what Git or
a client cannot represent; everything else is accepted.** On a clone, what
it cannot represent is a cause of `stuck`. Nothing about a file's content,
a table's description, or an app's schema is a refusal. A browser clone
leaves a link or an executable outside tables untouched rather than
refusing it (ADR-0623).

## Consequences

- An app renders one badge from four values, and every app means the same
  thing by each.
- An app offers to reconnect only on `disconnected`; going offline is
  `pending`, and edits keep landing as working files.
- An app cannot tell a person why a repository is `stuck`; the person runs
  `epicenter status` or asks an agent.
- A malformed row never makes a repository `stuck`; it is a `check` line.

## Considered alternatives

- **Typed sync errors in the app API.** Every app then renders and words
  each cause itself, and a new cause is a breaking change to every app.
- **Refusing writes a description does not allow.** A repository becomes
  `stuck` because one app is a field behind another.
- **An unreachable server as `disconnected`.** Every app then offers a
  sign-in that cannot help while the network is down.
