---
name: tsconfig
description: 'TypeScript config conventions for this monorepo: the two base files, the leaf tiers, and what a leaf may set. Use when adding or scaffolding a package, editing any tsconfig.json, picking a tier for a new app, or debugging module resolution.'
metadata:
  author: epicenter
  version: '2.0'
---

# tsconfig conventions

Every package is source-only `.ts`: `exports` point at `./src/*.ts`, nothing emits, and Bun, Vite, or Tauri read the source directly.

## The one rule

A leaf `tsconfig.json` sets only package-specific options: `types`, `noUnusedLocals` and `noUnusedParameters` for libraries, `checkJs` for SvelteKit, and a real need such as `include` or `exclude`. If a leaf option repeats a base value or a TypeScript default, delete it.

## Two base files

- `tsconfig.base.json`: `target` and `lib` ESNext, `module: "preserve"`, `strict`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, `types: []`.
- `tsconfig.dom.json`: extends the base and only adds `lib: ["ESNext", "DOM", "DOM.Iterable"]`.

## Leaf tiers

Pick the tier and copy its example.

| Tier | Extends | Copy |
| --- | --- | --- |
| Bun library | `tsconfig.base.json` | `packages/app/tsconfig.json` |
| Node library | `tsconfig.base.json` | `apps/whispering/packages/vite-config/tsconfig.json` |
| Browser or Svelte library | `tsconfig.dom.json` | `packages/ai/tsconfig.json` |
| Bun scripts | `tsconfig.base.json` | `scripts/tsconfig.json` |
| SvelteKit app | base, then `./.svelte-kit/tsconfig.json` | `apps/whispering/tsconfig.json` |
| Astro app | base, then `astro/tsconfigs/strict` | `apps/landing/tsconfig.json` |

A generated or framework config goes last in the `extends` array so its settings win. Never hand-edit a generated config.

## `types` is opt-in

The base sets `types: []` so TypeScript does not load every `@types` package in `node_modules`. Each leaf opts in with `["bun"]` or `["node"]`. Do not move `["bun"]` into a base: a package without `@types/bun` installed would fail with `Cannot find type definition`.

## `include` replaces, it does not merge

A leaf `include` replaces the inherited one. In a SvelteKit app, do not set `include`, or you drop the generated `ambient.d.ts` and `$types` files. Set `include` only to narrow scope for a real reason.

## Adding a package

1. Copy the `tsconfig.json` of the matching tier.
2. Start `package.json` from this shape:

   ```json
   {
     "name": "@epicenter/<name>",
     "version": "0.0.1",
     "private": true,
     "type": "module",
     "license": "AGPL-3.0-or-later",
     "exports": { ".": "./src/index.ts" },
     "scripts": { "typecheck": "tsc --noEmit", "test": "bun test" },
     "devDependencies": { "@types/bun": "catalog:", "typescript": "catalog:" }
   }
   ```

   Use `exports` only, with no `main` or `types`. Internal dependencies use `"workspace:*"`; shared versions use `"catalog:"`. A Svelte package typechecks with `svelte-check --tsconfig ./tsconfig.json` instead, as in `packages/ai`.
3. Run `bun install` at the repo root, then `bun typecheck`.
