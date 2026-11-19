# 0969. The repository ships no apps

- **Status:** Proposed
- **Date:** 2026-11-18
- **Relates:** [ADR-0912](0912-shared-app-code-comes-from-the-app-we-maintain.md) and [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md), which name `examples/writing/` as where shared app code is exported to and copied from; that folder no longer exists.

## Context

The monorepo held two Epicenter apps under `examples/`: `examples/tasks/`, a
task list with a Svelte page, and `examples/writing/`, a writing inbox. The
front doors told a new owner to install one with `curl`, and ADR-0912 and
ADR-0929 described `examples/writing/` as the folder app code is exported to
and copied from.

An example in this repository has to be typechecked, installed, linted and
kept true by the monorepo. Each of those bent the monorepo around it: a
workspace entry to install it, `biome.jsonc` exclusions to lint it, and tests
that read its files. A real app lives in an Epicenter, next to
its records, and is maintained there.

## Decision

**This repository ships no Epicenter apps, examples included.**

```txt
examples/                          deleted
README.md, command/README.md       write a small notes app inline; no curl install
apps/landing                       links to that inline app
packages/app writing test          builds its app inside the test
biome.jsonc                        no examples exclusions
```

App code is no longer copied or exported from `examples/`. ADR-0912 and
ADR-0929 keep their text; where they name `examples/writing/`, read it as a
folder that existed when they were written. ADR-0955 already removed the
commands that copied and exported app code.

## Consequences

A new owner writes their first app from the front door's inline `epicenter.ts`,
or asks a coding agent with the `epicenter-app` skill. The deleted examples stay
recoverable from Git history.

The monorepo no longer typechecks, installs or lints any app. The library's
own tests cover what the examples exercised.

Examples may return later as their own thing, outside this repository's
workspace and checks.
