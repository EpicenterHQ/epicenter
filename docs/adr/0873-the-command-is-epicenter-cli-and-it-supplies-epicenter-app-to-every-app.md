# 0873. The command is `@epicenter/cli`, and it supplies `@epicenter/app` to every app

- **Status:** Proposed
- **Date:** 2026-11-11; revised the same day, when publishing `@epicenter/app` was dropped
- **Unbuilt:** all of it but the first point: `epicenter` supplies its `@epicenter/app` to `epicenter.ts` (a Bun plugin in `packages/cli/src/bin.ts`), but not to a view's build or an app's editor, and `@epicenter/cli` is `private` and unpublished.
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app's `epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a view reaches actions through `@epicenter/app/client`), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what gets published), [ADR-0877](0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md) (an app's code is its own repository).

## Context

Two things leave the monorepo: the `epicenter` command, and the library an
app is written against.

- `packages/cli` is the command (`bin: epicenter`). It depends on
  `better-auth`, the MCP SDK and the rest of the server.
- `packages/app` is `defineApp`, `defineCollection`, `defineAction`, `field`
  and the rest an `epicenter.ts` imports, plus `@epicenter/app/client`, which
  a view uses to call actions.

The command already supplies its own copy of `@epicenter/app` to every
`epicenter.ts` it loads, through a Bun plugin. An app needs the library in
two more places: its editor, to type-check `epicenter.ts` and the view, and
its view's build, whose `/client` must speak the protocol of the `serve` that
answers it.

The first draft of this record published `@epicenter/app` to npm for those
two, at one version with the command, with a check that warns when an app's
installed copy differs from the command's. That made two copies of the
library per app, and with them a publish, a version bump in every app, and a
drift check, all to keep the copies equal.

On npm, unscoped `epicenter` belongs to someone else (0.5.0, 2022), and npm
does not transfer a name for inactivity. The `@epicenter` scope is ours. Its
earlier, unrelated packages, `@epicenter/cli` 0.0.1 to 0.1.0 among them, are
deleted (ADR-0875); npm never reuses a version number a package once had.

## Decision

**There is one copy of `@epicenter/app` on a computer: the one inside the
`epicenter` command, which supplies it everywhere an app uses it.**

- `epicenter.ts` gets it when `epicenter` loads the file, as now.
- A view's build gets it: before `epicenter` installs and builds `ui/`, it
  links `ui/node_modules/@epicenter/app` to its own copy.
- The editor gets it: `epicenter` links `node_modules/@epicenter/app` in the
  app's folder to its own copy when it makes, updates, or builds the app.
- An app's `package.json` and `ui/package.json` do not name `@epicenter/app`;
  their `bun.lock` files pin third-party packages only.
- `@epicenter/cli` is the one published package, from its first release above
  0.1.0, when a computer other than the Studio runs `epicenter`. Until then
  the Studio runs the command from this repository.
- The command is spelled `epicenter` wherever a person reads it; the package
  name appears only in install instructions.

## Consequences

- A view is always built against the library of the `serve` that answers it,
  so the two cannot drift, and nothing checks for it.
- Changing `@epicenter/app` reaches every app at the next build. Nothing is
  published or bumped per app.
- An app's code builds only where `epicenter` is installed. An app means
  nothing without it.
- An app written against a newer `@epicenter/app` than someone's command has
  fails to build or load until they update `epicenter`, as an `epicenter.ts`
  already does.
- A view's build links only `@epicenter/app`, so it installs nothing of the
  server: no Better Auth, no MCP SDK.

## Considered alternatives

- **Publish `@epicenter/app` at the command's version** (this record's first
  draft). Each app installs a second copy of the library, kept equal to the
  command's by releases, bumps, and a warning.
- **One package, `@epicenter/app`, with the `epicenter` bin.** Every view
  build would install the whole server.
- **Disputing the unscoped `epicenter` name.** npm does not transfer a name
  for inactivity alone.
