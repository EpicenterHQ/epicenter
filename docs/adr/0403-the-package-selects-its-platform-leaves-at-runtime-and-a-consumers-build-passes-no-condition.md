# 0403. The package selects its platform leaves at runtime, and a consumer's build passes no condition

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) at the selector only: a platform module is "imported directly and selected by the build" becomes "imported directly and selected by the package"; the membership rule, the family name, and the two-leaf shape stand. [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md) at the selector only: "a `#platform/*` seam inside `@epicenter/app` selects every implementation" becomes a runtime choice inside the package; the deletion of `runtime`, `ai`, and `settingsKey`, the host blob layout, and the whole-declaration rule stand. [ADR-0387](0387-the-clipboard-is-a-platform-module-beside-the-app-not-a-capability-on-it.md) at "selected for the build by a `#platform/clipboard` seam". [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) at its built-line claim that "nothing observable" in a WebView tells it apart from a browser tab: `isTauri()` is observable in every window Tauri creates, and Home already relies on it.
- **Relates:** [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md) (superseded for scope by ADR-0227, never on merit: "no plugin, alias, resolve condition, or externalization from an app's build" is the rule this record restores), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) (why the condition was an ownership declaration; after ADR-0227 the two questions have one answer), [ADR-0347](0347-whisperings-seams-select-an-owner-and-the-tauri-condition-selects-nothing.md) (the app-level seams this record leaves alone), [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (the developer this record is for deploys their own build), [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) (why a host leaf works in every window)
- **Unbuilt:** All of it. `packages/app/package.json` still maps `#platform/resources`, `#platform/ai`, and `#platform/clipboard` by the `epicenter-host` condition; `packages/app/src/platform-selection.test.ts` reads that map; the package's `tsconfig.epicenter-host.json` and the second `tsc` in its `typecheck` script exist only to reach those leaves; Vocab, which sets no condition, already ships the browser leaves into the host.

## Context

`@epicenter/app` picks each platform-dependent implementation through a
`#platform/*` entry in its own `package.json`, keyed by the `epicenter-host`
export condition. The map is read by whichever bundler builds the package,
and that bundler is the consuming application's. Whispering, Honeycrisp, and
Local Mail set the condition in Vite configs this repository owns, so for
them the choice is correct by construction and `platform-selection.test.ts`
guards the silent failure of a dropped leaf. Vocab sets no condition and has
no host build script, so the desktop already opens Vocab over the browser
SQLite and secrets leaves: the silent failure is live inside this repository
today.

The package is meant to be built on by developers whose Vite config this
repository does not own. For them the condition is homework: one line in
`resolve.conditions`, two builds from one codebase, and the right folder to
the right place. Forget the line and the desktop opens a browser bundle that
starts and is quietly wrong, which is the failure the test catches here and
cannot catch there. ADR-0186 saw this and decided that nothing about the
package appears in an app's build configuration. ADR-0227 superseded it
because the third-party plane was refused for now, and ADR-0334 has since
made that plane the product.

The condition was designed to answer "which Epicenter owns this build's
data", not "which window it runs in" (ADR-0190), and `tauri` was the separate
environment axis. ADR-0347 retired `tauri` because after ADR-0227 the only
Tauri WebView is the Epicenter host. Today both questions have one answer,
and the package's condition answers "who owns" with a string a stranger's
build must remember.

The repository has refused runtime detection before, and the refusals were
about a different fact. ADR-0304 said nothing observable tells a WebView
apart from a tab; `apps/epicenter/src/ui/runtime.ts` calls `isTauri()` to
decide which panes Home may act on, so the fact is observable and already
load-bearing. `apps/epicenter/AGENTS.md` and the `platform-seams` skill say
never to detect the host at runtime, because "in a WebView" once did not
imply "the host brokers my credential": a standalone Honeycrisp bundle ran in
a WebView and owned everything. ADR-0227 deleted that bundle. Today the only
WebView is the host's, and the two facts are one.

## Decision

**Every platform-dependent implementation in `@epicenter/app` is chosen
inside the package, at runtime, from the fact that the host is present. A
consumer's build passes no condition.**

Each platform module and each ownership seam is a public file that imports
its browser leaf and its host leaf and picks with `isTauri()` from
`@tauri-apps/api/core`:

```ts
// packages/app/src/notification.ts
import { isTauri } from '@tauri-apps/api/core';
import { notification as browser } from './notification/browser.js';
import { notification as host } from './notification/epicenter-host.js';
export const notification = isTauri() ? host : browser;
```

The contract file, the browser leaf, and the host leaf keep the shape the
clipboard has. Only the selector changes. `#platform/*` entries leave the
package's `package.json`, and `platform-selection.test.ts` asserts instead
that every public platform file names both leaves.

A developer runs one `vite build`. The same folder serves as a browser
deployment and, with a manifest beside it, as an Epicenter installation. In a
tab the notification is the Web Notifications API and AI keys live in tab
storage; in the desktop the same bytes send an OS notification and keep keys
in the keychain through the host broker. The developer imports once and never
chooses.

Applications this repository builds keep their own app-level seams where they
select who owns a credential (`#platform/auth`, `#platform/instance`), because
those builds are run here. They stop needing the condition for anything the
package supplies.

## Consequences

- Both leaves ship in every bundle, and the cost is small in both
  directions. The host `resources` leaf is plain TypeScript over `fetch` and
  one WebSocket (`@epicenter/device/desktop`); the browser leaf's SQLite WASM
  already lives in a worker chunk every browser build ships. The plugin
  wrappers are a few lines each.
- `packages/app/tsconfig.epicenter-host.json`, the second `tsc` in the
  package's `typecheck` script, and the `epicenter-host` condition in
  `packages/app/scripts/shared-ai-catalog.native.mjs` go. The three apps'
  Vite conditions and host tsconfigs stay: each selects that app's own seams
  (Whispering fifteen, Honeycrisp two, Local Mail two). `@epicenter/vite-config`
  sets no condition and never did.
- The test doubles ADR-0391 left open resolve the same way: a test mocks the
  leaf module the selector imports, not a seam. `packages/app-shell`'s
  `desktop-close.test.ts` already stubs `isTauri` on `globalThis`, which is
  the shape to reuse.
- ADR-0388's consequence "the build condition is the only selector for one"
  reads "the package's runtime check is the only selector for one".

## Considered alternatives

- **Keep the condition and ship a Vite plugin that sets it.** ADR-0186
  refused exactly this plugin. A developer who already has a build cannot
  bring it, one forgotten plugin ships a wrong bundle, and one codebase needs
  two builds.
- **Export `@epicenter/app/browser` and `@epicenter/app/epicenter-host` and
  let the developer import the one they mean.** A source-level choice, so one
  codebase needs an alias per target. The same homework, moved.
- **A framework build command, `epicenter build`, that wraps Vite.** Hires a
  tool to keep a promise the package can simply not make. The framework's one
  verb stays `epicenter install <folder>`.
- **Detect the host by something other than `isTauri()`.** Tauri injects its
  internals before any script runs in every window it creates, including
  `app-*`. If a host ever runs without Tauri, the fact becomes "is the host
  present" and it is still one check inside the package.
