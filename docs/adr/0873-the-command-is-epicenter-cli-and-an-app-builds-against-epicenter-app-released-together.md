# 0873. The command is `@epicenter/cli`, an app builds against `@epicenter/app`, and both release together

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) (an app's `epicenter.ts`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a view reaches actions through `@epicenter/app/client`), [ADR-0866](0866-an-app-starts-from-a-starter-kept-as-its-upstream-and-update-merges-the-starters-changes.md) (starters), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (what gets published).

## Context

Two things leave the monorepo: the `epicenter` command, and the library an
app is written against.

- `packages/cli` is the command (`bin: epicenter`). It depends on
  `better-auth`, the MCP SDK and the rest of the server.
- `packages/app` is `defineApp`, `defineCollection`, `defineAction`, `field`
  and the rest an `epicenter.ts` imports, plus `@epicenter/app/client`, which
  a view uses to call actions. It depends on `typebox`, `wellcrafted` and
  `nanoid`.

The command already supplies its own copy of `@epicenter/app` to every
`epicenter.ts` it loads, through a Bun plugin (`packages/cli/src/bin.ts`). So
an app's actions always run against the library the running command ships,
whatever the app's folder has installed. What an app's folder installs
matters in two places: type checking its `epicenter.ts`, and building its
view, whose `/client` must speak the protocol of the `serve` that answers it.

On npm, unscoped `epicenter` belongs to someone else (0.5.0, 2022). npm's
dispute policy does not count inactivity, so it is not ours to get. The
`@epicenter` scope is ours; `@epicenter/cli` 0.1.0 is an earlier, unrelated
release, and `@epicenter/app` is unpublished.

## Decision

**Two packages, one version, released together.**

| Package | Who installs it | What it holds |
| --- | --- | --- |
| `@epicenter/cli` | the person, once per computer (`bun add -g @epicenter/cli`) | the `epicenter` command and `serve`; depends on `@epicenter/app` at its own exact version |
| `@epicenter/app` | each app folder and its view, as a dev dependency | the definition API and `@epicenter/app/client`; nothing from the server |

- The command keeps supplying its own `@epicenter/app` to every `epicenter.ts`
  it runs. An app's installed copy is for types and for building its view.
- When an app's folder has an `@epicenter/app` whose version differs from the
  command's, `epicenter` says so on stderr, naming both versions and the
  command that brings the app in line. It runs the app anyway.
- The first release of `@epicenter/cli` from this monorepo is a breaking
  version above 0.1.0.
- The command is spelled `epicenter` wherever a person reads it; the package
  name appears only in install instructions.

## Consequences

- A view built outside the monorepo installs `@epicenter/app` from npm instead
  of a `workspace:` link. Today the live apps carry a prebuilt `ui/dist` and
  no `ui/package.json`, because their views could only build inside the
  monorepo. With this package published, and the UI kit as a registry
  (ADR-0874), an app folder can build its own view.
- Installing `@epicenter/app` pulls nothing from the server: no Better Auth,
  no MCP SDK.
- Releasing one without the other is not allowed; the version check would
  report it on every app.

## Considered alternatives

- **One package, `@epicenter/app`, with the `epicenter` bin.** One name to
  learn, but every view build would install the whole server, and a global
  install still differs from each app's installed copy, so the drift check is
  needed either way.
- **Disputing the unscoped `epicenter` name.** npm does not transfer a name
  for inactivity alone.
- **`@epicenter/epicenter` or another scoped name for the command.** `cli`
  names what the package is, and the scope already says whose it is.
</content>
</invoke>
