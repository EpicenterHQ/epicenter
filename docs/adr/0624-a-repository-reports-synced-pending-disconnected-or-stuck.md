# 0624. Local data reports its synchronization state

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amended by:** [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) with a local state for datasets that have no synchronization destination; the four existing values apply after connection.
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Sync still refuses, as `SyncError.Unrepresentable`" and its list: the only refusals are a non-text write from the library, a push that would rewrite history, and what Git cannot represent; a browser clone carries untouched any tree entry it cannot represent, and on a disk clone what its file system cannot represent is a cause of `stuck`.
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at the browser's sync states and recovery: a web app reports only files not uploaded yet.
- **Relates:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the sync whose state this reports), [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (`epicenter status`), [ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md) (`status`, `subscribe`, and `connect`).
- **Unbuilt:** public reporting of the five states, actionable same-origin browser diagnostics and recovery, `epicenter status` reporting disk causes, and the full list of what a disk clone's file system cannot represent. The public diagnostic shape remains undecided.

## Context

Sync stops with typed errors: `SyncError.Unrepresentable`
(`c87a47f8783f:packages/folder/src/git/errors.ts`) for a tree holding a link, an
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

**An app sees one synchronization state for its open local data:**

```txt
local          no sync destination is configured; local saves work normally
synced         no unsent edits, and the clone matched the server at its last check
pending        edits not yet pushed, a sync on its way, or the Git service unreachable
disconnected   the Git service refused or expired this origin's sign-in; the app calls connect()
stuck          sync cannot finish until someone fixes a cause in the repository or the clone
```

The local state is normal under ADR-0633 and does not mean work awaits upload.
An unreachable configured server is `pending`, because the next sync needs nothing
from the person. A refused or expired sign-in is `disconnected`, because
only `connect()` mends it
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)).

**The causes of `stuck`:**

```txt
case folding       on a disk clone whose file system folds case, incoming names that differ only by case
storage failure    the clone's storage refuses a read or a write
unresolved state   a sync that cannot settle what the clone holds against main; on disk, also a file
                   holding conflict markers or a path plain Git left unresolved (ADR-0611)
```

**A state summarizes progress; recovery also needs an actionable cause.**
The app must be able to explain `stuck`, name the affected path when known,
and offer recovery where the local data lives. A desktop CLI or agent can
inspect disk files but cannot open another origin's private browser database.
Browser recovery therefore stays within that origin. Depending on the cause,
it can offer source repair, retry after storage becomes available, or export
of readable saved data. It does not require discarding unsent work or
reopening an empty dataset. Storage failure does not guarantee every byte
can still be read or edited.

The public diagnostic shape remains undecided. A state badge does not require
every app to handle a closed union of synchronization errors or a general
issue-list API. On disk, `epicenter status` can also report the cause, changes
not yet synced, and the age of the last fetch (ADR-0611).

**Local save checks and synchronization prerequisites have different owners.**
A selected schema's disagreement never refuses a save. Local file-operation
errors belong to ADR-0626; the text-write boundary belongs to ADR-0621.
History protection belongs to ADR-0620, and unresolved native Git content
belongs to ADR-0622: plain Git conflict markers can block an Epicenter commit
without blocking source repair. This state contract does not repeat an
exhaustive refusal list.

A browser clone preserves untouched tree entries it cannot expose as ordinary
files under ADR-0623. On disk, incoming names the filesystem cannot hold
separately cause `stuck`; the local path checks still prevent creating case
twins under ADR-0626.

## Consequences

- An app renders one badge from five values, and every app means the same
  thing by each.
- An app offers to reconnect only on `disconnected`; going offline is
  `pending`, and edits keep landing as working files.
- A browser app explains its local failure without depending on a desktop tool
  that cannot inspect its data. Disk clients can also use the CLI or an agent.
- Schema nonconformance is a row issue, not `stuck`. Unresolved native Git
  content can block a commit while source remains available for repair.

## Considered alternatives

- **A closed union of sync causes every app must render.** Couples every app
  to every new cause. Keep the state stable and leave diagnostic presentation
  and its public shape separate.
- **Only the CLI explains failures.** It cannot inspect an origin-private
  browser database, leaving its person without a usable repair route.
- **Refusing writes a description does not allow.** A repository becomes
  `stuck` because one app is a field behind another.
- **An unreachable server as `disconnected`.** Every app then offers a
  sign-in that cannot help while the network is down.
