# 0944. An app builds its own UI, and serve only serves it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at "build, fingerprint, and serve `ui/dist/`": `serve` serves `ui/dist/` as the app's own build left it. Also amends [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at "`epicenter init` and `epicenter new` run `bun install` there" and "the command carries the starter palette", [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at its root `theme.css`, [ADR-0904](0904-copying-is-the-only-way-to-take-an-apps-code.md) at "`new --from` installs the app's packages and loads its `epicenter.ts`", and [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md) at "copied by value, so a root theme can travel with an app": `new` runs nothing, a home has no shared theme, and export refuses a link out of the app. ADR-0854, ADR-0860, ADR-0868, and ADR-0880 are Proposed and were edited in place: a UI no longer runs as it sits on disk; actions still do.
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
- `epicenter new` runs nothing. It writes the app and prints the one command
  that installs its packages and builds its UI:
  `Run: cd <home> && bun install && bun run build`. `epicenter init` still
  installs once, which puts the `epicenter` command in the new home.
- A page load for an app with no `ui/dist/index.html` answers a plain 404.
- An app owns its palette. `init` writes no root `theme.css`; an app keeps its
  colors in a file under `code/ui/`, copied from a sibling app rather than
  linked. A link out of `code/` breaks when the app is copied or exported.
- `export` refuses a link that leaves the app's `code/` and says to copy the
  file in. It no longer copies a shared file by value, and its report drops
  `materialized` and `uncommitted`: `apps` is a list of names. `new` no
  longer reports links that do not resolve; a build that needs the file says
  so.
- `epicenter build` is removed.

## Consequences

- An edit under `ui/` shows only after someone runs `bun run build`. The
  `epicenter-app` skill tells agents to run it after every UI change, and a
  build's errors now reach the person who ran it rather than serve's log.
- A UI bundles `@epicenter/app/client`. After upgrading Epicenter, `bun run
  build` at the top rebuilds every UI against the new client; until then a
  page may speak an older protocol than its `serve`.
- A build writes into `ui/dist/` in place, and Tasks' build empties it first,
  so a page loaded during a build may find it missing or partial. Reloading
  after the build fixes it.
- Epicenter keeps no stamp, fingerprint, or failure memory for UIs.
- `new` never runs copied code. The person runs the printed command, which
  installs packages, runs their scripts, and builds, and sees Bun's errors
  directly. Until then the app's actions may lack packages and its page
  answers 404. A `new` that installed and built had to report three kinds of
  failure and decide which left the app in place.
- Two apps that share colors hold two copies, which drift apart once either
  is edited. That is the cost of an app that copies, exports, and travels
  whole. Existing homes keep working: a root `theme.css` that apps link to is
  left alone, and those links still resolve in that home. Such an app cannot
  be exported until its link is replaced by a copy.
- A home made before this change has no `build` script at its top, and an app
  whose UI was a bare `ui/index.html` has none of its own. Add
  `"build": "bun run --filter '*' --if-present build"` to the home's
  `package.json`, and a `build` like the plain page's line to each such app.
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
