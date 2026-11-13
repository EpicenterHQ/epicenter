# 0893. A record's path is its path in the app's data repository

- **Status:** Accepted (2026-11-13)
- **Date:** 2026-11-13
- **Amends:** [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) at "A record's path does not change. It is `data/words/<time>.md` in every answer": it is `words/<time>.md`. [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) at "A collection's path starts with `data/`" and "A record's path is the same everywhere: the file's path from the app's folder": a path is relative to `data/`, and the rest of ADR-0876 stands.
- **Relates:** [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (`data/` is a repository), [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (a clone is that repository).
- **Unbuilt:** all of it: `defineCollection`'s paths, a run's `folder`, and the first-party apps' collections, which today start with `data/` (`packages/app/src/collection.ts`, `context.ts`).

## Context

ADR-0876 put an app's records under `data/` and wrote every collection path
from the app's folder, `data/recordings/{id}.md`, so that what an action
returns is what an agent opens. `defineCollection` refuses a path without the
prefix. ADR-0877 made `data/` a repository of its own, and ADR-0887 gives a
program a clone of exactly that repository, where the same record is
`recordings/<id>.md`.

The prefix carries no information: every collection path has it, and code
exists to check that it does. And an agent on the host never opens a path
relative to an app's folder: from `~/Epicenter` the record is
`apps/whispering/data/recordings/<id>.md`, a prefix it already adds.

## Decision

**A record's path is its path in the app's data repository,
`recordings/<id>.md`, everywhere: in a contract, an action's input and
result, a run's `folder`, a UI's routes, Git history, and a clone.**

- **A collection declares `recordings/{id}.md`.** `defineCollection` refuses a
  path that starts with `data/`, saying to drop it.
- **A run's `folder` is the data repository.** `folder.read('recordings/x.md')`
  reads `<app>/data/recordings/x.md`. A run reads and writes only there:
  reads no longer reach the app's code files, and nothing a run writes can
  reach code, by construction rather than by a check.
- **`data/` is where the host mounts the data repository** in an app's
  folder (ADR-0876, ADR-0877). The rest of ADR-0876 stands: records under
  `data/`, code everywhere else.

## Consequences

- One name per record for actions, agents over MCP, programs, clones, and
  history. A third party reads the contract's paths as the paths in its
  folder.
- The prefix check in `collection.ts` and the run's path check go; a run's
  writes are confined by `folder`'s root.
- Each first-party app drops `data/` from its collections once, and a UI's
  hash routes lose it.
- An agent on the host adds `apps/<app>/data/` to a path an action returns,
  where it added `apps/<app>/` before.

## Considered alternatives

- **Keep paths from the app's folder (ADR-0876).** Every clone and program
  strips `data/`, and Git history inside the data repository names a path no
  contract states.
- **Put the data repository at the app's top, code under one folder.** ADR-0876
  declined it: tools expect `package.json` at a project's root.
