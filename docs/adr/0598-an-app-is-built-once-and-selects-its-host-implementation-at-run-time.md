# 0598. An app is built once and selects its host implementation at run time

- **Status:** Accepted
- **Date:** 2026-10-17
- **Supersedes:** [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md) (the build selects every implementation); the package it governed, `@epicenter/app`, no longer exists.
- **Amends:** [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) at "Keep consumer app conditions that select their own authentication and UI seams" and "This selector does not make a broker-authenticated app build standalone": an app's own seams select at run time too, and one build runs on every host. Failing closed on the wrong host stands.
- **Amends:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at "The publisher runs the desktop build (`EPICENTER_HOST=1`, `installedAppViteConfig` in `packages/vite-config/src/index.ts`), or the repository would hold the browser build": there is one build, and the published repository holds the same artifact a web host serves.
- **Amends:** [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) at "An application build declares `epicenter-host` when the desktop Epicenter host serves it": no build declares a host.
- **Unbuilt:** all of it: run-time selection of each app's seams, the one build with every route prerendered and a fallback page, the scheme serving each route's own document, the checks that replace the platform selection tests, and the deletions below.

## Context

Each folder app builds twice. `EPICENTER_HOST=1` turns on the
`epicenter-host` condition and aliases the bare `@epicenter/folder` to
`@epicenter/folder/tauri`; without it the alias points at
`@epicenter/folder/browser` (`installedAppViteConfig`,
`packages/vite-config/src/index.ts:77-104`; `isInstalledAppBuild`,
`packages/vite-config/src/installed-app.js:11`). The condition picks each
app's `#platform/*` leaf: Todos' sign-in (`#platform/auth` in
`apps/todos/package.json`) and Whispering's workspace
(`#platform/workspace` in `apps/whispering/package.json`).
`installedAppAdapterOptions` (`installed-app.js:30`) writes the host build to
`dist/` with every route prerendered and the browser build to `build/` with
a fallback page, and each app's `src/routes/+layout.ts` sets
`prerender = import.meta.env.EPICENTER_HOST === '1'` (Capture, Honeycrisp,
Todos, Whispering).

Keeping two builds honest takes:

- `build:installed` in four apps' `package.json`;
- `tsconfig.epicenter-host.json` in Todos and Whispering and a second
  `svelte-check` in each `typecheck`;
- `platform-selection.test.ts` in Todos and Whispering, and the bundle
  reader they and three `bundle.test.ts` files import
  (`packages/vite-config/src/module-graph.ts`,
  `packages/vite-config/scripts/module-graph.ts`), because "a dropped leaf
  or alias fails no build: resolution falls back silently";
- the `platform-seams` skill (`.agents/skills/platform-seams/SKILL.md`);
- a choice in the publisher of which build to publish (ADR-0589).

`@epicenter/folder` already selects at run time: its root entry calls
`isTauri()` when `openFolder` runs, loads only the adapter it chose, and
gives a desktop page whose folder cannot open that refusal, never browser
storage (`packages/folder/src/index.ts`). ADR-0403 requires the same of
every selector: "a broken host service does not silently fall back to
browser storage."

On the desktop the scheme answers any route below an app's build with that
build's root `index.html` (`contained_file`,
`apps/epicenter/src-tauri/src/scheme.rs:152-182`).

## Decision

**Each app is built once, and the running page selects its host
implementation.** The folder adapter, sign-in, and Whispering's workspace
each load their desktop or browser implementation by `isTauri()` when first
used, through a dynamic `import()`. A selector that finds the desktop and
cannot reach the shell refuses; it never opens the browser implementation
instead (ADR-0403).

**The one build prerenders every route and also writes a fallback page.**

```txt
<build>/index.html, <route>/index.html   prerendered, relative asset paths: the desktop serves these
<build>/<fallback>.html                  adapter-static fallback, named apart from index.html: a web host serves it for unknown paths
```

The desktop scheme serves a route's own prerendered document,
`<build>/<route>/index.html`, in place of the root `index.html`. A web host
serves the fallback page for a path with no file. The repository ADR-0589
publishes holds this build, so the bytes a person approves on the desktop
are the bytes the app's web origin serves.

Deleted, about 700 lines removed or rewritten:

- the `epicenter-host` condition, the `@epicenter/folder` alias, and the
  `EPICENTER_HOST` define in `installedAppViteConfig`;
  `isInstalledAppBuild`, and `installedAppAdapterOptions`' switch;
- `apps/todos/tsconfig.epicenter-host.json`,
  `apps/whispering/tsconfig.epicenter-host.json`, and their `svelte-check`;
- `build:installed` in Capture, Honeycrisp, Todos, and Whispering;
- the `prerender` conditionals in those four `+layout.ts` files;
- both `platform-selection.test.ts` files and the module-graph helper; the
  three `bundle.test.ts` files that import it are rewritten;
- `.agents/skills/platform-seams/`;
- the publisher's choice of build.

## Consequences

- Each repository carries about 1 MB of the other host's chunks, which a
  page on this host never loads.
- Boot takes one more request: the chosen implementation's chunk loads
  after the page decides where it runs.
- Run-time selection needs its own checks: a test that the desktop branch
  refuses when the shell is unreachable, and one that each branch's chunk
  loads, in place of reading two bundles' module graphs.
- A browser tab and a desktop window run one build, so a fix tested in one
  is the fix shipped to the other.
- ADR-0589's browser template objects are in every build, whichever host
  runs it.

## Considered alternatives

- **Keep two builds and publish the desktop one.** The web origin and the
  approved repository hold different bytes, and the build, typecheck, and
  test machinery doubles for every app.
- **Select at build time by host, without a second typecheck.** The
  selection is what fails silently, so dropping its checks keeps the risk
  and removes the guard.
