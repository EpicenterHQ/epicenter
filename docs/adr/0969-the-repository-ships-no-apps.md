# 0969. The repository ships no apps

- **Status:** Accepted
- **Date:** 2026-11-18
- **Supersedes:** [ADR-0912](0912-shared-app-code-comes-from-the-app-we-maintain.md).
- **Relates:** [ADR-0912](0912-shared-app-code-comes-from-the-app-we-maintain.md) and [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md), which name `examples/writing/` as where shared app code is exported to and copied from; that folder no longer exists.

## Context

The monorepo held two Epicenter apps under `examples/`: `examples/tasks/`, a
task list with a Svelte page, and `examples/writing/`, a writing inbox. The
front doors told a new owner to install one with `curl`, and ADR-0912 and
ADR-0929 described `examples/writing/` as the folder app code is exported to
and copied from.

Nothing checked them. They were not workspace members, no typecheck reached
them, and `biome.jsonc` excluded both from lint. Unchecked, they drifted: when
PR #2728 first typechecked the Tasks example, it had type errors against the
current library.

Checking them meant bending the monorepo around them. PR #2728 added
`examples/tasks` to the workspace, which needed a root dependency on
`@epicenter/app`, because the isolated linker in `bunfig.toml` lets a package
import only what it declares, and an app never declares `@epicenter/app`. Its
`bun-plugin-tailwind` brought a second copy of bun into every install. The PR
took all of it back out. Two test files in `packages/app` read the examples'
files from disk.

A real app lives in an Epicenter, next to its records, and is maintained
there.

## Decision

**This repository ships no Epicenter apps, examples included.**

```txt
examples/                          deleted
packages/app writing test          deleted; its behaviors have tests elsewhere
packages/app input-schema test     writes its apps inline
command/README.md                  one walkthrough: a one-file notes app, after "Make an Epicenter"
README.md                          links to that walkthrough; no curl install
apps/landing                       shows the notes app
biome.jsonc                        no examples exclusions
```

App code is no longer copied or exported from `examples/`. ADR-0912 and
ADR-0929 keep their text; where they name `examples/writing/`, read it as a
folder that existed when they were written. ADR-0955 already removed the
commands that copied and exported app code.

## Consequences

A new owner writes their first app from the walkthrough's inline
`epicenter.ts`, or points a coding agent at the
[`epicenter-app` skill](../../.agents/skills/epicenter-app/), a file of
instructions an agent reads.

No whole app with a page, no Svelte build plugin and no UI test remains
anywhere in this repository. They are in Git history before this record's
commit and in the owner's own Epicenter. Nothing replaces them until examples
return, as their own thing outside this repository's workspace and checks.
