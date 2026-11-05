# 0781. Apps branch on what a capability offers, and one build serves every surface

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) at the build choosing a capability's implementation by condition: the package chooses when it runs; [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at an app's `#platform/*` seams: an app has none; [ADR-0701](0701-apps-run-as-separate-programs.md) at the desktop's own frontend build and typecheck (`desktopVariant`, `build:native`'s frontend, `tsconfig.tauri.json`): one build and one typecheck serve both.
- **Relates:** [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) (a package selects its leaves at run time, which this returns to), [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (no runtime object an app asks which platform it is on, which this keeps), [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) (the page's one async moment), [ADR-0780](0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md) (parity is not a goal).
- **Amended by:** [ADR-0784](0784-whispering-is-the-webs-local-app-and-messages-is-a-program-on-this-computer.md) at Whispering's service worker registering only outside a Tauri shell: the shared offline module decides it.
- **Unbuilt:** all of it: every capability deciding presence with `isTauri()` and loading its desktop implementation in its async step; deleting every app's `#platform/*` imports and `src/lib/platform/`, the `tauri` package condition (`packages/ai`, `local`, `folder`, `transcription`, and the five SvelteKit apps), every `tsconfig.tauri.json` (the apps' and `packages/ai`'s), and `desktopVariant`; `@epicenter/account` choosing its own implementation; the place saying whether it uses an account; desktop-only views as branches on capabilities; Whispering's service worker registering only outside a Tauri shell; the test that the web's first load holds no desktop module; Whispering's direct import of `@epicenter/ai/tauri` moved inside the package; the `platform-seams` and `services-layer` skills and the `epicenter-standalone` README.

## Context

Each app built twice: once for the web and once, under a `tauri` package
condition, for the desktop, with its own frontend output and its own
typecheck. Packages chose their implementation by that condition, and each
app chose its account, its header, and its desktop-only views through
`#platform/*` imports with a web and a desktop file each: sixty-eight app
files import a seam, and Whispering has sixteen files of them. A dropped
condition key silently ships the browser's implementation to the desktop,
which is ADR-0403's case against build conditions; ADR-0598, which chose at
run time, was superseded when the desktop host platform was dropped, not on
its merits; ADR-0701 brought the second build back without giving a reason;
ADR-0755's reason, that the web bundle would carry desktop imports, does not
hold for a module loaded only when it is needed.

Nothing blocks one build: the five SvelteKit apps differ between builds only
in the condition, the output directory and Whispering's service worker;
all use `adapter-static` with no prerender, base path or `TAURI_ENV_*`; the
desktop's content security policy allows same-origin chunks; and
`@tauri-apps/api` touches the shell only inside its functions.

## Decision

**An app branches on what a capability offers, never on the platform.** A
capability a surface cannot give is `null` there (ADR-0780), and an app
asks the capability:

```ts
export const shortcut = openShortcut(); // null in a page: it cannot hold a global shortcut
{#if shortcut}<ShortcutSettings {shortcut} />{/if}
```

An app has no `#platform/*` seams. Its account, header, and desktop-only
views are branches on its capabilities, or a capability's own view.

**A capability package chooses its implementation when it runs, in two
steps.** Its constructor decides, synchronously, whether it is present,
with `isTauri()`: whether the page runs in a Tauri shell, so a phone's
shell takes the shell's implementation too. Its desktop implementation is
loaded in its asynchronous step, the page's connection (ADR-0778), and stays
out of the web's first load. A capability with a synchronous read gets it
from the settings store, or imports its small desktop part directly; none
answers a stand-in.

**An app asks for an account for what it uses, and a place says whether it
uses one.** A web place reaches the account's repository; the desktop's
place is synced by Epicenter and uses none. Desktop Todos shows no sign-in
because nothing it uses asks for an account; desktop Whispering signs in for
its AI.

**One build and one typecheck serve the web and the desktop.** The desktop
loads the same output the web serves. Whispering's service worker registers
only outside a Tauri shell. One test holds that the web's first load
contains no desktop module.

## Consequences

- Sixty-eight app files lose their seam imports, every app loses
  `src/lib/platform/`, and the second build, condition and typecheck go.
- A fix tried on one surface is the fix shipped to the other, and the
  desktop can develop against a dev server instead of a rebuilt frontend.
- The web's deployed files include desktop chunks it never loads.
- A static import of a desktop module from shared code would put it in the
  web's first load; the test catches it.
