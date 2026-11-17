---
name: monorepo
description: 'Monorepo scripts, package boilerplate, conventions. Use when: "how do I run", "bun run", "build this", "run tests", "typecheck", "create a new package", linting, scaffolding packages.'
metadata:
  author: epicenter
  version: '2.0'
---

# Script Commands

The monorepo uses consistent script naming conventions.

## Commands

| Command            | Purpose                                        | When to use |
| ------------------ | ---------------------------------------------- | ----------- |
| `bun format`       | **Fix** formatting (biome)                     | Development |
| `bun format:check` | Check formatting                               | CI          |
| `bun lint`         | **Fix** lint issues (biome)                    | Development |
| `bun lint:check`   | Check lint issues                              | CI          |
| `bun typecheck`    | Type checking (tsc, svelte-check, astro check) | Both        |
| `bun test`         | Run unit tests (`*.test.ts` only)              | Both        |
| `bun bench`        | Run benchmarks (`*.bench.ts`; reports, no assertions) | Manual |

## Convention

- No suffix = **fix** (modifies files)
- `:check` suffix = check only (for CI, no modifications)
- `typecheck` alone = type checking (separate concern, cannot auto-fix)
- `test` runs only `*.test.ts`; `bench` runs only `*.bench.ts`. A file is
  one or the other : never both. Benchmarks print reports; tests assert.

## Dev Scripts

Run these scripts from the repository root. The [root manifest](../../../package.json) lists the available targets.

| Command | What starts |
| --- | --- |
| `bun dev` or `bun dev:whispering` | Whispering's Vite dev server. `bun dev:whispering:ui` starts the same UI. |
| `bun dev:whispering:desktop` | Whispering in its native Tauri window. |
| `bun dev:api-dashboard` | The account dashboard and its API together. |
| `bun dev:api-dashboard:ui` | The dashboard frontend alone. |
| `bun dev:api` | The backend alone. |
| `bun dev:landing` | The landing site. |

Apps in a person's `~/Epicenter/apps/` run through the [Epicenter CLI](../../../packages/cli/README.md). Use `epicenter serve` to open their UIs.

For database scripts, `db:*:local` selects local Postgres. `db:*:remote` runs through Infisical against production and is an admin operation.

There is no `dev:remote`. Production data is reached only through `:remote` db
scripts and `deploy`, never through a development server.

## After Completing Code Changes

Run type checking to verify:

```bash
bun typecheck
```

This runs `bun run --filter '*' typecheck` which executes the `typecheck` script in each package (e.g., `tsc --noEmit`, `svelte-check`).

## New Package Boilerplate

When creating a new package in `packages/`, follow this exact structure.

### `package.json`

```json
{
  "name": "@epicenter/<package-name>",
  "version": "0.0.1",
  "exports": {
    ".": "./src/index.ts"
  },
  "license": "AGPL-3.0-or-later",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Key conventions:

- `exports` only, no `main`/`types`: modern resolvers ignore `main`/`types` when `exports` is present. The entry point is `./src/index.ts`; there is no build step, consumers import the source directly.
- Use `"workspace:*"` for internal deps (e.g., `"@epicenter/app": "workspace:*"`).
- Use `"catalog:"` for shared versions managed in the root `package.json` catalogs.
- `peerDependencies` for packages consumers must also install (e.g., `svelte` in `@epicenter/account`, optional for a consumer without Svelte).
- `license`: `AGPL-3.0-or-later`. Before adding an MIT package, read "If MIT returns" in `docs/licensing/licensing-strategy.md`.

### `tsconfig.json`

A leaf config picks a tier and adds nothing that repeats a base. For a Bun library:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"],
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

A Svelte or browser library extends `../../tsconfig.dom.json` instead. For all seven leaf tiers, the never-redeclare list, and the module strategy, see the `tsconfig` skill.

After creating the package, run `bun install` from the repo root to register it in the workspace.
