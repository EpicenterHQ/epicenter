# 0875. A package is published when an outside consumer needs to install it

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amended:** 2026-11-12: every earlier `@epicenter` release is unpublished; a capability that shares state or a protocol with the running command is a subpath of `@epicenter/app`, not a package of its own.
- **Built:** every workspace package under `packages/` and `apps/` has `"private": true`. `@epicenter/app` is supplied by the command, not published separately. No `@epicenter` package is on npm.
- **Unbuilt:** npm distribution packaging and the first release of the current CLI, when another computer needs to install it (ADR-0873). The compiled executable already carries the app library; the source manifest is not ready to publish as-is.
- **Relates:** [ADR-0873](0873-the-command-is-epicenter-cli-and-it-supplies-epicenter-app-to-every-app.md) (the command supplies the app library), [ADR-0874](0874-the-ui-kit-is-a-shadcn-svelte-registry-an-app-copies-from.md) (the UI kit ships as a registry), `docs/licensing/licensing-strategy.md` (AGPL, and what an MIT package needs).

## Context

The `@epicenter` scope held packages from the folder sync product and earlier
experiments: `cli`, `ui`, `workspace`, `sync`, `filesystem`, `skills`,
`opencode`, `field`, `identity`, and `encryption`. Those releases did not
describe what the current command runs, and each was a contract someone might
hold us to.

The packages an app actually needs are the ones it imports from its own
folder: the library its `epicenter.ts` and UI build against, and later the
capabilities an app reaches for, such as recording or transcription. They are
of two kinds (ADR-0873): the runtime's API, which must be the same code as the
`epicenter` that runs the app, and libraries the app only calls.

## Decision

**Publish a package only when a named consumer outside the monorepo needs to
install it.** An import alone does not require a separate npm release:
`epicenter` supplies `@epicenter/app`, and an app copies UI components. Every
workspace package stays `"private": true` until its own release is needed.

- **Next publication:** `@epicenter/cli`, when a computer other than the Studio
  needs to install the current command. Its release removes `"private": true`
  from that package with the owner's explicit go (ADR-0873).
- **Supplied to outside apps:** `@epicenter/app`, the runtime's API that an app's
  code and UI import. The command carries and links it, so the package stays
  private to npm without restricting its use by apps outside the monorepo.
- **A capability goes where its coupling says.** One that shares state or a
  protocol with the running command, such as one that reaches its secrets,
  its account, or `serve`, is a subpath of `@epicenter/app`, which the
  command carries. One an app only calls, such as transcribing a file in its
  own process, is a small package of its own, published when an app needs to
  install it, such as `@epicenter/transcription`. Each names its first
  importer when it is first published.
- **Kept private:** packages that only the monorepo's own apps and server
  use (`account`, `server`, `definition`, `folder`, `local`, `svelte`, `ai`,
  `tauri-*`, `vite-config`), and `@epicenter/ui`, whose components an app
  copies from the registry instead (ADR-0874).
- Published packages release at one version, together, from `main`. Every
  publish needs the owner's explicit go.
- **Earlier releases are gone.** Every `@epicenter` package published before
  this record was unpublished on 2026-11-12. npm never reuses a version a
  package once had, so a release of an old name takes a version none of its
  earlier releases used.

## Consequences

- An app with no package to import keeps a copy of what it needs, which is
  also what it can change: an agent can edit a copied component; it cannot
  edit `node_modules`.
- An outside app can import the command's app library without that library
  having its own npm release. The private flag controls publication only.
- Moving code into a published package is a decision made when its first
  consumer needs to install it, not in advance.
- Published packages are AGPL-3.0-or-later like everything under `packages/`.
  An MIT package needs a named embedder first, as the licensing strategy says.

## Considered alternatives

- **Deprecate the earlier releases instead of unpublishing them.** They would
  stay installable, describing a product that no longer exists, under the
  names the current packages use.
- **Publish every package under `packages/`.** It would let anyone build on
  any of them, but every one would become a contract with no known user.
- **Publish `@epicenter/app` separately.** Each app installs a second copy of
  the library and must keep it compatible with the command. ADR-0873 supplies
  one copy instead.
- **Supply each capability coupled to the running command as its own
  package from the command.** Each would need its own link, version, and copy, kept equal to
  the command's; a subpath of `@epicenter/app` is one of each.
