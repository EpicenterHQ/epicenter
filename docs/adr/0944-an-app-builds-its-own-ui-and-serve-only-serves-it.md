# 0944. An app builds its own UI, and serve only serves it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) at "A UI is optional and any framework": a UI no longer runs as it sits on disk; actions still do. [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) at `serve` building `ui/dist/` and `epicenter build`. [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) and [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) at `epicenter build`. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at "build, fingerprint, and serve `ui/dist/`".
- **Relates:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) (one workspace, so one `bun run build` reaches every app), [ADR-0941](0941-epicenter-serve-is-a-program-you-keep-running.md) (the same move for keeping serve running).

## Context

`serve` kept every UI in step with its sources. It fingerprinted each app's
`ui/` files, `package.json`, the home's `bun.lock`, the Epicenter version and
the client's source files. On a page load with a changed fingerprint it built
in the background, served the last good build meanwhile, waited up to a minute
for a first build, and remembered failed builds until their sources changed.
An app with no `build` script got Epicenter's own bundler for `ui/index.html`.
`epicenter build` ran the same build on demand to show its errors. That was
about 450 lines in `ui.ts`, `build.ts`, their tests, and `http.ts`
([`ui.ts` at e34945a283](https://github.com/EpicenterHQ/epicenter/blob/e34945a283/packages/cli/src/ui.ts)).

Since ADR-0942 a home is one Bun workspace, and each app's `code/` is a package
with its own scripts. Bun already builds a page from an `index.html`, and
`bun run --filter '*' --if-present build` at the top of a workspace runs every package's
`build`, skipping packages without one.

## Decision

**An app builds its own UI with `bun run build`, which writes `code/ui/dist/`.
`serve` serves that folder as it is and never builds.**

- A plain page's `build` is one line:
  `"build": "bun build ui/index.html --outdir ui/dist"`.
- `epicenter init` writes `"build": "bun run --filter '*' --if-present build"` into the
  home's `package.json`, so `bun run build` at the top builds every app.
- `epicenter new` runs a copied app's `bun run build` after installing, so its
  page opens straight away.
- A page load for an app with `ui/` and no `ui/dist/index.html` answers 404
  with `Run: cd <code> && bun run build`.
- `epicenter build` is removed.

## Consequences

- An edit under `ui/` shows only after someone runs `bun run build`. The
  `epicenter-app` skill tells agents to run it after every UI change, and a
  build's errors now reach the person who ran it rather than serve's log.
- A UI bundles `@epicenter/app/client`. After upgrading Epicenter, `bun run
  build` at the top rebuilds every UI against the new client; until then a
  page may speak an older protocol than its `serve`.
- A build writes into `ui/dist/` in place, so a page loaded during a build can
  see half of it. Reloading after the build fixes it.
- Epicenter keeps no stamp, fingerprint, or failure memory for UIs.
- `new` runs copied code's `build` script when it copies the app, not when its
  page first opens. The code is its owner's to trust (ADR-0864), and
  `bun install` already runs package scripts.
- A home made before this change has no `build` script at its top, and an app
  whose UI was a bare `ui/index.html` has none of its own. Add
  `"build": "bun run --filter '*' --if-present build"` to the home's
  `package.json` and a `build` to each such app; the 404 page names the line.
  `init` does not rewrite an existing `AGENTS.md`, so an older home's copy
  still says serve rebuilds until it is refreshed by hand.

## Considered alternatives

- **Keep rebuilding in serve.** It kept pages current without a step, at the
  cost of a build system inside serve that each reader of serve had to learn.
- **Rebuild on a page load only when stale, with no background build or
  memory.** Half the code, but still a definition of "stale" for Epicenter to
  own.
- **Have Bun compile on request** (`Bun.serve` with HTML routes). Bun takes one
  plugin list for the whole server, and Tasks needs its own Svelte, Tailwind
  and font plugins. Worth another look if a home-wide plugin list proves
  enough.
