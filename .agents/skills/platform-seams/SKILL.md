---
name: platform-seams
description: Apply Epicenter’s `#platform/*` build-time seam across browser and host targets. Use when adding or changing a seam, build condition, typecheck leaf, or deciding whether code belongs behind one.
metadata:
  author: epicenter
  version: '7.0'
---

# Platform seams

Replaces `workspace-app-composition`, whose subject (`defineWorkspace`, the
workspace singleton, environment factories, the daemon) was deleted with the
workspace plane. The seam below is the part that survived.

## Storage is not a seam

**Every build opens its own store.** A host serves bundles and brokers
credentials and owns no application data (ADR-0226), so there is no build where
data lives somewhere else, and a `#platform/*` seam for storage is the thing to
delete rather than to route. Applications acquire independent stores through
`openLocal` and `openPersonal` from `@epicenter/app/open`. Resource constructors
select browser or native implementations with `isTauri()` (ADR-0403).
`StoreRuntime` injection controls store storage and admission; it is not an
application-wide runtime. `defineStore` from the root is platform-free and
carries no runtime or AI override.

App-level seams select auth and product capabilities. They do not choose store
persistence. Keep resource composition at the product boundary; do not restore
Whispering's removed `#platform/runtime` seam. For constructors and ownership,
read the [resource contracts](../../../packages/app/README.md).

## Declaring one

**1. Map the specifier in `package.json` "imports".** One entry per condition,
plus a `default`:

```jsonc
"imports": {
  "#platform/auth": {
    "epicenter-host": "./src/lib/platform/auth.epicenter-host.ts",
    "tauri": "./src/lib/platform/auth.tauri.ts",
    "default": "./src/lib/platform/auth.browser.ts"
  }
}
```

Condition order in the map is match order.

**2. Import the bare specifier, with no branch at the call site:**

```ts
import { auth } from '#platform/auth';
```

**3. Activate the condition in `vite.config.ts`:**

```ts
resolve: {
	// Custom conditions REPLACE Vite's defaults, so the
	// ...defaultClientConditions spread is LOAD-BEARING: drop it and all
	// dependency resolution breaks.
	...(isEpicenterSurface && {
		conditions: ['tauri', ...defaultClientConditions],
	}),
},
```

**4. Typecheck every leaf.** Bundler `moduleResolution` reads the `imports`
field and lands on `default` for the editor, so the browser leaf is free. Every
other condition needs its own `tsconfig.<condition>.json` setting
`compilerOptions.customConditions`, run from `typecheck`. Without one, those
leaves are never checked at all.

**5. Give the seam a contract.** `types.ts` declares it; each leaf annotates
against it:

```ts
// platform/types.ts
export type PlatformAuth = { /* ... */ };

// platform/auth.browser.ts
export const auth: PlatformAuth | undefined = browserAuth;
```

Use `export const x: Contract = ...`, **not** `satisfies`. `satisfies` leaks the
concrete type and breaks the lockstep that keeps every leaf the same shape.

## The two conditions answer different questions (ADR-0190)

`tauri` means **this build runs in a Tauri WebView**, so a leaf may call a native
command. `epicenter-host` means **the desktop Epicenter host serves this build**,
so a leaf may reach the host for a credential, a deployment choice, or an asset
base.

They used to be conflated because `epicenter-host` also meant the host owned the
build's replica. ADR-0226 removed that, so the condition is now about brokered
credentials and nothing about data.

**Package selection and app seams.** `@epicenter/app` selects its default runtime
and clipboard inside the package with `isTauri()` (ADR-0403). It requires no
consumer build condition. Keep app-level conditions where they select auth or
product UI; removing the package map does not remove those app-owned choices.

A build that owns its own storage uses neither host condition, whether a browser
or a bundle serves it: a WebView is a storage partition and origin pair like any
other (ADR-0177). Every build owns its own storage, so this is now always true.

## A dropped leaf fails nothing

This is the one hazard worth remembering. Removing an `epicenter-host` key from
a seam breaks no build: resolution falls back silently to `default`, and the
hosted build quietly runs the browser leaf. `apps/honeycrisp/src/lib/platform-selection.test.ts`
reads the declarations and names the broken seam, and
`apps/epicenter/scripts/build-applications.test.ts` runs the real build and reads
the emitted bytes.

## Why not suffixes

The old mechanism put `.browser.ts` / `.tauri.ts` ahead of `.ts` in Vite
`resolve.extensions`, mirrored by tsconfig `moduleSuffixes`. That was global:
every bare import was magic, which is how a bare `./fuji` once collided with a
`fuji.browser.ts`. `#platform/*` is scoped to those specifiers only, so the rest
of the import graph stays ordinary.

## Anti-patterns

- Adding a `#platform/*` seam for storage, a replica, or a database. Every build
  opens its own store; that seam is what ADR-0226 refused.
- Branching on the platform at an app's `#platform/*` call site. Import the
  bare specifier and let the build select the leaf.
- Detecting the host at runtime in an app seam. The build already answered.
  `@epicenter/app` is the explicit exception: ADR-0403 selects its runtime and
  clipboard with `isTauri()`, under the supported Epicenter-host-only Tauri model.
- Using `satisfies` on a leaf instead of a `: Contract` annotation.
- Importing a `.tauri.ts`-only symbol through `#platform/*`. It resolves to the
  browser leaf off Tauri; import it directly from the `.tauri` module inside
  another `.tauri.ts` file.
- Reintroducing `resolve.extensions` suffixes or tsconfig `moduleSuffixes`.
- Dropping `...defaultClientConditions` from the Tauri `conditions` array.
- Adding a condition leaf with no `tsconfig.<condition>.json`, which means it is
  never typechecked.
- A `#platform/*` seam over identity. Whether a person is signed in is runtime
  state, not a build condition, so the gate is an `{#if}` in the boot node and
  never a leaf. Every app renders a sign-in screen when signed out (ADR-0342,
  rejected: sign-in IS a door), and that is one branch in one file rather than a
  seam.
