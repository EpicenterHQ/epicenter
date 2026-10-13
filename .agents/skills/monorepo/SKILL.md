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

Start apps from the repo root, not by cd-ing into the app. Root
`bun dev:<app>` runs every process the app needs; for apps that talk to the
hosted API (honeycrisp, todos, vocab, and the
api dashboard), it also starts `@epicenter/api` on `localhost:8787` via
`bun run --filter`. Root `bun dev:<app>:ui` runs the app's frontend
alone when that split exists; for Tauri apps, it maps to the package's
`dev:web`. `bun dev:api` runs just the backend. Local Books, Local Mail, and
Super Chat have their own multi-process flows documented in their READMEs;
they have no root `dev:*` target.

Inside a single package, the conventions are:

Non-Tauri apps use a single `dev` script that runs the underlying tool
directly (`vite dev`, `astro dev`, `wrangler dev`). Tauri desktop apps
(honeycrisp, matter) have two dev surfaces and name them
explicitly: `dev` launches the desktop shell (aliasing `dev:desktop`), and
`dev:web` runs Vite alone, which each app's `tauri.conf.json` invokes as its
`beforeDevCommand`. The suffix convention applies primarily to database
commands:

| Script | Meaning |
| --- | --- |
| `dev` | The default local workflow. May still require Infisical login for app secrets (e.g. API keys), but only ever talks to local infrastructure at runtime. |
| `dev:web` | Tauri apps: the Vite dev server alone, no desktop shell. Invoked by `tauri.conf.json` as `beforeDevCommand`. |
| `dev:desktop` | Tauri apps: launches the native desktop app (`tauri dev`). `dev` aliases this. |
| `db:*:local` | Runs against local Postgres. Works without Infisical login. |
| `db:*:remote` | Wraps with `infisical run --env=prod`. Production data; treat as admin. |

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
- Use `"workspace:*"` for internal deps (e.g., `"@epicenter/workspace": "workspace:*"`).
- Use `"catalog:"` for shared versions managed in the root `package.json` catalogs.
- `peerDependencies` for packages consumers must also install (e.g., `yjs`).
- `license`: default `AGPL-3.0-or-later` (everything Epicenter ships or runs). Use `MIT` only if the package is meant for third-party developers to embed in their own software (the toolkit). See `docs/licensing/licensing-strategy.md`; `bun run check:licenses` fails if an MIT package can reach an AGPL one.

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

A Svelte or browser library extends `../../tsconfig.dom.json` instead. For all eight leaf tiers, the never-redeclare list, and the module strategy, see the `tsconfig` skill.

After creating the package, run `bun install` from the repo root to register it in the workspace.
