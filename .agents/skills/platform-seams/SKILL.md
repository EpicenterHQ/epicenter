---
name: platform-seams
description: Maintain Whispering's shared browser and Tauri build, capability detection, on-demand desktop imports, and desktop-only views. Use when changing a native capability or the desktop shell.
metadata:
  author: epicenter
  version: '9.0'
---

# Platform seams

Whispering is an outside app. One build serves its browser and desktop surfaces
([ADR-0781](../../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
Each capability chooses its implementation. Whispering’s views use what that capability offers. For a UI served inside an Epicenter, follow [Build the UI as a client](../epicenter-app/SKILL.md#build-the-ui-as-a-client).

## Where the choice lives

**A capability package chooses its implementation when it runs, in two
steps.**

1. **Presence, synchronously.** When its module loads, the package asks
   `isTauri()` from `@tauri-apps/api/core` and makes its value: a
   capability a surface cannot give is `null` there
   ([ADR-0780](../../../docs/adr/0780-a-surface-uses-what-its-platform-gives-and-parity-is-not-a-goal.md)).
2. **The desktop implementation, in its asynchronous step.** The desktop
   code loads with `import()` when the page connects or the capability
   first acts
   ([ADR-0778](../../../docs/adr/0778-a-page-connects-once-and-then-reads-synchronously.md)),
   so a browser's first load holds none of it.

| Package | In a browser | In a Tauri window, loaded when |
| --- | --- | --- |
| `@epicenter/local` (`settings`) | `localStorage` | AppData through the shell: its first read, write or watch |
| `@epicenter/folder` (`home`) | the account's repository | the data folder: the folder opens |
| `@epicenter/account` (`connectAccount`) | browser OAuth | the shell's sign-in; its relay with the first request |
| `@epicenter/ai` (`customEndpoints`, `localServers`) | the page's `fetch` and key | the shell's key and fetch: the first request |
| `@epicenter/recorder` (`recorder`) | the page's microphone | the shell's recorder: the first call |
| `@epicenter/transcription` (`localSpeech`) | `null` | the generated bindings: the first call |

A capability with a synchronous read takes it from the settings store, or
imports its small desktop part directly. `@epicenter/account`'s `tauri.ts`
is the one such part: it reads who is signed in from `account.json` at
once, and asks the shell only when the person acts.

## How Whispering uses a capability

[Whispering’s app module](../../../apps/whispering/src/lib/app.ts) opens its capabilities once. Its app-owned `openShortcut` can check `isTauri()` and load desktop code on demand. The [settings form](../../../apps/whispering/src/routes/components/SettingsForm.svelte) renders the controls each capability supplies.

```svelte
{#if speech}<SpeechSettings {speech} /><Separator />{/if}
{#if shortcut}<ShortcutSettings {shortcut} /><Separator />{/if}
```

Keep imports on the shared page path safe for a browser, including imports in a component that only the desktop renders.

## Tests and the `test` condition

The `test` export condition stays
([ADR-0787](../../../docs/adr/0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md)):
under `--conditions=test`, `@epicenter/folder`'s root is a folder in memory
and `@epicenter/local`'s is settings in memory. A test of desktop behavior
mocks `isTauri` (`mock.module('@tauri-apps/api/core', ...)`) and the
desktop module it loads.

These tests and the browser build show the web branch and the mocked contract.
Accept the desktop branch in the running native app, as the
[tauri skill](../tauri/SKILL.md#verify-in-the-desktop-app) describes.

[The first-load test](../../../scripts/first-load.test.ts) builds Whispering’s page sources (`firstLoadModules` from
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
- An app asking where it runs to pick a capability or a store; `home` and
  `connectAccount` pick.
- A capability that answers a fake on a surface that lacks it, instead of
  `null`.
