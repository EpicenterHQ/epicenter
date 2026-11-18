---
name: platform-seams
description: Maintain Whispering's shared browser and Tauri build, capability detection, on-demand desktop imports, and desktop-only views. Use when changing a native capability or the desktop shell.
metadata:
  author: epicenter
  version: '10.0'
---

# Platform seams

Whispering is an outside app. One build serves its browser and desktop surfaces
([ADR-0781](../../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
Each capability chooses its implementation. Whispering’s views use what that capability offers. For a UI served inside an Epicenter, follow [Build the UI as a client](../epicenter-app/SKILL.md#build-the-ui-as-a-client).

## Where the choice lives

**A capability chooses its implementation when it runs, in two steps.**

1. **Presence, synchronously.** When its module loads, it asks `isTauri()`
   from `@tauri-apps/api/core` and makes its value: a capability a surface
   cannot give is `null` there
   ([ADR-0780](../../../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).
2. **The desktop implementation, when first used.** Desktop code loads with
   `import()` when the capability first acts, so a browser's first load
   holds none of it.

| Capability | In a browser | In a Tauri window, loaded when |
| --- | --- | --- |
| `Files` (`app.ts` picks) | `opfsFiles`: the Origin Private File System | `tauriFiles`: Whispering's `files_*` commands, through `@tauri-apps/api/core` |
| `secrets` (`this-computer.ts`) | `localStorage` | the Keychain through `secret_get` and `secret_set` |
| `requestFetch` (`this-computer.ts`) | the page's `fetch` | `@tauri-apps/plugin-http`: the first request |
| `recorder` (`@epicenter/recorder`) | the page's microphone | the shell's recorder: the first call |
| `localSpeech` (`@epicenter/transcription`) | `null` | the generated bindings: the first call |
| `openShortcut` (`shortcut.ts`) | `null` | the shell's event code: the first listener |
| `holdOneTab` (`one-tab.svelte.ts`) | a Web Lock | nothing to hold: the single-instance plugin keeps one window |

Whispering's [page-boundary test](../../../apps/whispering/src/lib/page-boundary.test.ts)
names every file that reaches Tauri. Add a new one there on purpose, never
to get a test to pass.

## How Whispering uses a capability

[Whispering’s app module](../../../apps/whispering/src/lib/app.ts) opens its capabilities once, and is the one place that picks a `Files`. The [settings form](../../../apps/whispering/src/routes/components/SettingsForm.svelte) renders the controls each capability supplies.

```svelte
{#if speech}<SpeechSettings {speech} /><Separator />{/if}
{#if shortcut}<ShortcutSettings {shortcut} /><Separator />{/if}
```

Keep imports on the shared page path safe for a browser, including imports in a component that only the desktop renders.

## Tests

A test of desktop behavior mocks `isTauri` and the Tauri modules it loads
(`mock.module('@tauri-apps/api/core', ...)`, `@tauri-apps/plugin-http`), as
`desktop.test.ts` does. Whispering's own tests run over `memoryFiles()`;
there is no `test` export condition that swaps a store.

These tests and the browser build show the web branch and the mocked contract.
Accept the desktop branch in the running native app, as the
[tauri skill](../tauri/SKILL.md#verify-in-the-desktop-app) describes.

[The first-load test](../../../apps/whispering/scripts/first-load.test.ts) builds Whispering’s page sources (`firstLoadModules` from
`@epicenter/vite-config/module-graph`) and fails when what loads before any
`import()` holds a Tauri plugin, the shell's API beyond `core`, or a
package's desktop implementation. Add a new desktop module's name to its
`DESKTOP` patterns when it does not match them.

## The desktop shell's build

Whispering's `src-tauri/tauri.conf.json` loads `../build`, the output
the web serves, and builds it first (`"beforeBuildCommand": "bun run
build"`). `tauri.dev.conf.json` loads the app's dev server (`devUrl`),
which `tauri dev` starts (`"beforeDevCommand": "bun run dev"`). One
`svelte-check` typechecks every surface.

## Anti-patterns

- A static import of a desktop module on a page's path: the web's first
  load carries it. Load it with `import()` in the capability's
  asynchronous step.
- A `tauri` export condition, an `imports` seam, or a second build or
  tsconfig per surface.
- Asking where the page runs anywhere but the capability that needs to
  know; `app.ts` picks the `Files`, and every layer above it is written
  once.
- A capability that answers a fake on a surface that lacks it, instead of
  `null`.
