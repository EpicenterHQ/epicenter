---
name: tsconfig
description: 'TypeScript config conventions for this monorepo: the two-base layering, the seven leaf tiers, and the never-redeclare list. Use when adding a package, editing any tsconfig.json, picking a tier for a new app, or debugging module resolution.'
metadata:
  author: epicenter
  version: '1.0'
---

# tsconfig conventions

Every package here is **source-only `.ts`**: `exports` point at `./src/*.ts`,
there is no build step, and consumers (Bun, Vite, Tauri, the Cloudflare Worker)
operate on raw `.ts`. That single fact decides the whole config.

**The exceptions are the audience, not the package.** `packages/workspace` and
`packages/field` are published for toolchains we do not control, so shipping
source would subject them to a stranger's compiler settings. They emit `.js` and
`.d.ts`, and their `exports` point at `./dist`. Each leaf `tsconfig.json` is an
ordinary tier from the table below; the emit lives in a **sibling
`tsconfig.build.json`** that extends the leaf and turns on exactly what emitting
needs (`noEmit: false`, `outDir`, `rootDir`, `declaration`, `types: []`). Do not
add `outDir`, `declaration`, or `noEmit: false` to any leaf. If another package
earns a build, copy that split.

## The one rule

A leaf `tsconfig.json` may set **only**: `types`, library-only strictness
(`noUnusedLocals`/`noUnusedParameters`), `checkJs` (SvelteKit), and genuinely
package-specific options (`jsx`, `paths`, `customConditions`, `include`).

Anything else belongs in a base. If a leaf option repeats a base value or a
TypeScript default, delete it.

## Two base files

```
tsconfig.base.json   universal: target/lib[ESNext], module preserve, strict,
                     noEmit, isolatedModules, verbatimModuleSyntax, types []
tsconfig.dom.json    extends base; its ONLY job is lib [ESNext, DOM, DOM.Iterable]
```

There is no `tsconfig.base.lib.json` and no project `references`. Source-only
packages never emit, so `composite`/`declaration`/`outDir` have no place in a
leaf. The two published packages that do emit put them in their own
`tsconfig.build.json` (see above), never in the leaf or a base.

## Module strategy: one, repo-wide

`module: "preserve"` + `moduleResolution: "bundler"`. `preserve` implies
`bundler` (TS 5.4+); the explicit pair is kept for legibility. **Never use
`NodeNext`** anywhere: nothing in this repo is published as emitted Node ESM,
and `bundler` resolution already reads package.json `imports`/`exports`.

## The seven leaf tiers

Pick the tier, copy the shape, change nothing else.

| Tier | `extends` | Leaf adds |
| --- | --- | --- |
| Bun library | `"../../tsconfig.base.json"` | `types:["bun"]`, `noUnusedLocals`, `noUnusedParameters` |
| Node library | `"../../tsconfig.base.json"` | `types:["node"]`, `noUnusedLocals`, `noUnusedParameters` |
| Svelte library | `"../../tsconfig.dom.json"` | `types:["bun"]`, `noUnusedLocals`, `noUnusedParameters` |
| SvelteKit app | `["../../tsconfig.base.json", "./.svelte-kit/tsconfig.json"]` | `checkJs:true`, `types:["bun"]` |
| Cloudflare Worker | `"../../tsconfig.base.json"` | `jsx`, `jsxImportSource`, `types`, `include` |
| Bun app | `"../../tsconfig.base.json"` | `types:["bun"]`, `include` |
| Astro app | `["../../tsconfig.base.json", "astro/tsconfigs/strict"]` | astro `include`/`exclude` |

A generated config (`./.svelte-kit/tsconfig.json`) goes **last** in the array so
its `lib`/`module` win where they must. Never hand-edit a generated config.

The two canonical library shapes in full:

```jsonc
// Bun library: packages/sqlite, packages/sync, packages/principal, ...
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"types": ["bun"],
		"noUnusedLocals": true,
		"noUnusedParameters": true
	}
}

// svelte library: packages/ui, packages/svelte
{
	"extends": "../../tsconfig.dom.json",
	"compilerOptions": {
		"types": ["bun"],
		"noUnusedLocals": true,
		"noUnusedParameters": true
	}
}
```

## Never redeclare these (base value or TS default)

Putting any of these in a leaf is dead weight. Delete on sight.

| Do not write in a leaf | Why |
| --- | --- |
| `module: "preserve"` | already in `tsconfig.base.json` |
| `moduleResolution`, `target`, `noEmit`, `strict`, `isolatedModules` | already in the base |
| `lib: ["ESNext"]` | the base default; use `tsconfig.dom.json` if you need DOM |
| `noPropertyAccessFromIndexSignature: false` | that is already the TS default |
| `useDefineForClassFields: true` | default when `target` >= ES2022 |
| `forceConsistentCasingInFileNames` | default `true` since TS 5.0 |
| `resolvePackageJsonExports` | default `true` under `moduleResolution: bundler` |
| `sourceMap` | no-op under `noEmit` |
| single-element `extends` array | use the string form: `"extends": "../../tsconfig.base.json"` |

## `types` is opt-in, on purpose

The base sets `types: []` to disable auto-inclusion of every `node_modules/@types`
package. Each leaf opts in: `["bun"]` for almost everything, `["node"]` for the
one package that uses `@types/node`. Do not hoist `["bun"]` to a base: a package
without `@types/bun` installed would then fail with `Cannot find type definition`.

## `include` rules

- TypeScript does **not** merge `include` across `extends`. A leaf `include`
  fully *replaces* the inherited one. For SvelteKit apps this means: do not set
  your own `include`, or you drop the generated `ambient.d.ts`/`$types` globs.
- Only set `include` when you must narrow scope for a real reason; comment why.

## Adding a new package

1. Scaffold via the `monorepo` skill's boilerplate.
2. Pick a tier from the table above; copy that exact shape.
3. `package.json` uses `exports` only, no `main`/`types`. Entry point is
   `./src/index.ts`.
4. `bun install` at the repo root, then `bun typecheck`.

## Background

The full rationale, the migration that established this layout, and the baseline
typecheck state are in `specs/20260522T190000-modernize-monorepo-tsconfig.md`.
