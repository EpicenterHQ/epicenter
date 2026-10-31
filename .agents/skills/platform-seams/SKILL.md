---
name: platform-seams
description: Apply Epicenter’s `#platform/*` build-time seams, which pick each app variant's leaves (the browser's by default, the desktop's under the `tauri` condition). Use when adding or changing a seam or a variant's root, the build condition, a typecheck leaf, or deciding whether code belongs behind one.
metadata:
  author: epicenter
  version: '8.0'
---

# Platform seams

An app's web and desktop variants are the same UI built with different
leaves. A `#platform/*` specifier in the app's `package.json` "imports" names
two files; the build picks one, and nothing chooses at run time, so the type
checker, the tests and every bundler resolve each specifier to the same file.
The worked example is `apps/capture`; the pattern is written up in
[`epicenter-standalone`'s README](../../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant).

## What belongs behind a seam

**The root, which chooses the store.** An app has up to three variants, each
with one store (ADR-0700), and only a variant's root decides which. Every app
with a desktop variant has `#platform/root`. Its leaves export components;
the store choice is never buried in data code:

- `Startup` opens the store and renders the app over it, or says why it
  could not. The web leaf's is the signed-in repository or this browser's
  files; the desktop leaf's awaits `openAppData` and `openDataFolder` and
  renders `@epicenter/svelte/recovery` on an error.
- `Chrome` is the header's account of the store (the account on the web,
  the folder and Sync with Epicenter on the desktop).
- Whatever else differs by variant in that app: Capture's `store()`,
  Whispering's `Settings` (desktop only, `null` on the web) and `Callback`
  (the page that ends a sign-in).

**A capability whose implementation differs by build.** Whispering's
`#platform/services` (`createServices(client)`: the shell's microphone and
the keychain on the desktop, the WebView's microphone and `localStorage` on
the web), `#platform/auth` (`createTauriAuth` over `epicenter-account`, or
browser OAuth), and Vocab's `#platform/connections`.

**Which build this is, for words only.** `#platform/variant` exports a
constant (`'online'`, `'local'`, or `'desktop'`) for the few sentences that
name the store. Do not branch behavior on it; put the behavior in a seam.

Data code never sits behind a seam. UI components take the client (or its
`fromClient` wrapper) they show and never know which store it is.

## Declaring one

1. **Map it** in the app's `package.json`, the desktop leaf under `tauri`:

   ```jsonc
   "imports": {
     "#platform/root": { "tauri": "./src/lib/root.tauri.ts", "default": "./src/lib/root.ts" }
   }
   ```

2. **Import the bare specifier**, never a leaf, with no branch at the call
   site: `import { Startup } from '#platform/root';`. Leaves import with
   relative paths (no `$lib`), so the bundle test can resolve them.

3. **Give it a type** both leaves annotate against, in a shared
   `platform.ts` (or `platform/types.ts`):

   ```ts
   export const Startup: Platform['Startup'] = OnlineRoot;
   ```

   Use `: Type`, not `satisfies`: `satisfies` keeps the leaf's concrete type,
   so the two leaves can drift apart without an error at the import.

4. **Build it.** Merge `desktopVariant()` from `@epicenter/vite-config`
   into `vite.config.ts`. When `EPICENTER_DESKTOP=1` (the app's
   `build:native`, into `build-desktop/`) it sets
   `resolve.conditions: ['tauri', ...defaultClientConditions]`. Custom
   conditions replace Vite's defaults, so the spread is load-bearing. A
   choice outside module resolution (Whispering's Kit service worker, the
   build directory) reads `EPICENTER_DESKTOP` in its config file, still at
   build time.

5. **Typecheck both.** Bundler resolution lands on `default`, so the
   desktop leaves are checked only by `tsconfig.tauri.json` (`extends`
   `tsconfig.json` with `"customConditions": ["tauri"]`), which the app's
   `typecheck` runs as a second `svelte-check`.

6. **Guard it.** A dropped `tauri` key breaks no build: resolution falls
   back to `default`, and the desktop app silently ships the browser leaf.
   A bundle test bundles the seams both ways with `bundledModules` from
   `@epicenter/vite-config/module-graph` and names the seam whose desktop
   leaf went missing: `apps/capture/src/lib/platform.test.ts`,
   `apps/whispering/src/lib/platform/platform.test.ts`. Add each new seam to
   the app's test-support entry so the test sees it.

## Why not suffixes

The old mechanism put `.browser.ts` / `.tauri.ts` ahead of `.ts` in Vite
`resolve.extensions`, mirrored by tsconfig `moduleSuffixes`. That was global:
every bare import was magic, which is how a bare `./fuji` once collided with a
`fuji.browser.ts`. `#platform/*` is scoped to those specifiers only, so the
rest of the import graph stays ordinary.

## Anti-patterns

- Choosing the store anywhere but a variant's root, or moving files between
  stores.
- Detecting the platform at run time (`isTauri()`) to pick a store or a
  capability in an app that has seams. Standalone Todos predates seams and
  still picks with `isTauri()` in one build; do not copy it.
- Branching on `#platform/variant` for behavior.
- Importing a leaf directly from shared code, or importing a desktop-only
  symbol through the seam: off the desktop it resolves to the browser leaf.
  Import it from the `.tauri.ts` module inside another desktop leaf.
- `$lib` imports inside a leaf.
- `satisfies` on a leaf instead of a `: Type` annotation.
- Dropping `...defaultClientConditions`, or copying the condition switch
  into an app's config instead of `desktopVariant()`.
- A seam with no `tsconfig.tauri.json` run, or missing from the bundle test.
- Swapping SvelteKit's `kit.files.routes` per variant. The routes stay the
  same; the root decides the store.
- A seam over identity. Whether a person is signed in is run-time state, an
  `{#if}` in the root, never a leaf.
