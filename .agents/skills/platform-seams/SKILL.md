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

**The store needs no seam.** An app has up to three variants, each with
one store (ADR-0700), and `openFolder(contract, home({ site, account }))` in
`src/lib/app.ts` picks it: the build picks the `home` implementation (the desktop's
data folder under `tauri`, the browser's otherwise), and the account picks
the web's (the person's repository with one, this browser's files without).
Do not add a `#platform/root` or a `Startup` component. What does differ by
variant is a leaf:

- `#platform/account`: `connectAccount()`, the build's sign-in, or `null`
  where the build never signs in.
- `#platform/chrome`: the header's account of the store (the account on the
  web, the folder and Sync with Epicenter on the desktop).
- Whatever else differs by variant in that app: Whispering's
  `#platform/components` (`Settings`, desktop only, and `Callback`, the page
  that ends a sign-in).

**A capability whose implementation differs by build.** Whispering's
`#platform/computer` (the shell's microphone, its models on this computer
and the global shortcut on the desktop; the WebView's microphone on the
web), and every app's `#platform/account` (`createTauriAuth` over
`epicenter-account`, or browser OAuth). `src/lib/app.ts` alone makes the
capabilities from them. A capability package that owns both implementations picks
one by the same condition in its own package "imports" or exports
(`@epicenter/ai`'s `#device-settings`, behind `customEndpoints()`;
`@epicenter/local`'s `settings`, AppData on the desktop and
`localStorage` on the web), so the app needs no seam for it.

**Which build this is, for words only.** `#platform/variant` exports a
constant (`'online'`, `'local'`, or `'desktop'`) for the few sentences that
name the store. Do not branch behavior on it; put the behavior in a seam.

Data code never sits behind a seam. UI components take the folder (read
through `reactive`) they show and never know which store it is.

## Declaring one

1. **Map it** in the app's `package.json`, the desktop leaf under `tauri`:

   ```jsonc
   "imports": {
     "#platform/account": { "tauri": "./src/lib/account.tauri.ts", "default": "./src/lib/account.ts" }
   }
   ```

2. **Import the bare specifier**, never a leaf, with no branch at the call
   site: `import { connectAccount } from '#platform/account';`. Leaves import with
   relative paths (no `$lib`), so the bundle test can resolve them.

3. **Give it a type** both leaves declare: the same signature in each
   (`export function connectAccount(): CallbackAuthClient | null`), or, for a
   value such as a component, a type in a shared `platform.ts` both
   annotate against (`export const Chrome: Platform['Chrome'] = OnlineChrome;`).
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
  capability in an app that has seams.
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
