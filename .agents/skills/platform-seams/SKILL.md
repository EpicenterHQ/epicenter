---
name: platform-seams
description: Apply Epicenter's one-build rule, where a capability package decides at run time whether the page is in a Tauri window and loads its desktop implementation when it connects or first acts, and apps branch on what a capability offers. Use when adding or changing a desktop implementation, a capability only some surfaces have, a view only they show, or the desktop shell's build.
metadata:
  author: epicenter
  version: '9.0'
---

# Platform seams

One build serves the web and the desktop
([ADR-0781](../../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)).
The seam between a page and its platform sits inside each capability
package, never in an app: the package decides where the page runs, and the
app uses what the capability offers.

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

## What an app does

An app has no `#platform/*` imports, no `tauri` condition, and no build
per surface. `src/lib/app.ts` makes every capability once, synchronously,
and the views branch on what each offers:

```svelte
{#if shortcut}<ShortcutSettings {shortcut} />{/if}
{#if folder.reveal === null}<RepositoryChrome />{:else}<FolderChrome />{/if}
```

- **Branch on a capability, never on the platform.** `folder.reveal` is
  there for a folder on this computer; `shortcut` and `speech` are `null`
  in a browser. App code does not call `isTauri()`; an app-owned
  capability may, in the module that makes it (Whispering's
  `src/lib/shortcut.ts`), with its desktop code behind `import()`.
- **A view only some surfaces show is its own component** under the
  branch (`ShortcutSettings`, `SpeechSettings`, `FolderSettings`), and
  imports only what the page may load at once.
- **Words that differ by surface** follow the same branch: Vocab's
  `accountPurpose` reads `folder.reveal`.

## Tests and the `test` condition

The `test` export condition stays
([ADR-0787](../../../docs/adr/0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md)):
under `--conditions=test`, `@epicenter/folder`'s root is a folder in memory
and `@epicenter/local`'s is settings in memory. A test of desktop behavior
mocks `isTauri` (`mock.module('@tauri-apps/api/core', ...)`) and the
desktop module it loads.

`scripts/first-load.test.ts` builds every page source of each app with a
desktop window (`firstLoadModules` from
`@epicenter/vite-config/module-graph`) and fails when what loads before any
`import()` holds a Tauri plugin, the shell's API beyond `core`, or a
package's desktop implementation. Add a new desktop module's name to its
`DESKTOP` patterns when it does not match them.

## The desktop shell's build

A desktop app's `src-tauri/tauri.conf.json` loads `../build`, the output
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
- Choosing the store anywhere but `home`, or moving files between stores.
