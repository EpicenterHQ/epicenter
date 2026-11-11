# 0875. A package is published when an app outside the monorepo imports it

- **Status:** Proposed
- **Date:** 2026-11-11
- **Relates:** [ADR-0873](0873-the-command-is-epicenter-cli-and-an-app-builds-against-epicenter-app-released-together.md) (the two packages published now), [ADR-0874](0874-the-ui-kit-is-a-shadcn-svelte-registry-an-app-copies-from.md) (the UI kit ships as a registry, not a package), `docs/licensing/licensing-strategy.md` (AGPL, and what an MIT package needs).

## Context

The `@epicenter` scope on npm holds packages from the folder sync product and
earlier experiments: `cli` 0.1.0, `ui` 0.3.0, `workspace` 0.3.0, and `sync`,
`filesystem`, `skills`, `opencode`, `field` and `identity`. Nothing outside
the monorepo imports them now. Each published package is a contract someone
might hold us to, a version to bump, and a README that has to stay true.

The packages an app actually needs are the ones it imports from its own
folder: the library its `epicenter.ts` and view build against, and later the
capabilities an app reaches for, such as recording or transcription.

## Decision

**A package is published only when a named app outside the monorepo imports
it.** "Outside the monorepo" means an app folder in an Epicenter, or a starter,
built without `workspace:` links. A package with no such importer stays
`"private": true`.

- **Published now:** `@epicenter/cli` and `@epicenter/app` (ADR-0873).
- **Published later, when an app imports it:** small packages, one per
  capability, such as `@epicenter/recorder` or `@epicenter/transcription`. Each
  names its first importer when it is first published.
- **Never published:** packages that only the monorepo's own apps and server
  use (`account`, `server`, `definition`, `folder`, `local`, `svelte`, `ai`,
  `tauri-*`, `vite-config`), and `@epicenter/ui`, whose components an app
  copies from the registry instead (ADR-0874).
- Published packages release at one version, together, from `main`. Every
  publish needs the owner's explicit go.
- Each earlier package that this rule does not keep (`ui`, `workspace`,
  `sync`, `filesystem`, `skills`, `opencode`, `field`, `identity`) gets an
  `npm deprecate` message naming its replacement or saying there is none.
  Deprecating needs the owner's go too. Published versions stay installable
  under the license they were published with.

## Consequences

- An app with no package to import keeps a copy of what it needs, which is
  also what it can change: an agent can edit a copied component; it cannot
  edit `node_modules`.
- Moving code into a published package is a decision made when its first
  importer appears, not in advance.
- Published packages are AGPL-3.0-or-later like everything under `packages/`.
  An MIT package needs a named embedder first, as the licensing strategy says.

## Considered alternatives

- **Publish every package under `packages/`.** It would let anyone build on
  any of them, but every one would become a contract with no known user.
- **Publish nothing; apps vendor everything.** It works for the UI kit, whose
  code an app should own and change. It does not work for `@epicenter/app`,
  whose `/client` must match the `serve` that answers it.
</content>
</invoke>
