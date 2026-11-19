# Scripts

Root `package.json` scripts are a menu of commands. Each entry is one of:

- one call to a tool or workspace: `biome lint`, `bun run --cwd apps/api dev`;
- one `bun run scripts/<file>.ts`;
- one `infisical run ... -- bun run scripts/<file>.ts`, which counts as a tool
  call so the `:remote` name keeps showing that a command touches production.

Anything with logic, chaining, environment setup, or arguments lives in a file
here. Run everything from the repository root.

## Names

`verb:thing:suffix`.

| Part | Meaning |
| --- | --- |
| `dev:*` | start an app |
| `check:*` | validate the repository and exit non-zero on failure |
| `gen:*` | regenerate a checked-in file |
| `:desktop` | the native Tauri window of the same app |
| `:remote` | wraps Infisical's `prod` environment; a production admin operation |

`check` is the local merge gate and the one step CI runs. It is a script here
that calls other root scripts in order; add or remove a check in
`scripts/check.ts`.

## Adding a script

1. Write `scripts/<name>.ts` with a `#!/usr/bin/env bun` line and a one-line
   comment saying what it does. Chain commands with Bun's shell
   (`await $\`bun run thing\``), which stops the script at the first failure.
2. Add one root entry that runs it: `"check:thing": "bun run scripts/check-thing.ts"`.
3. Put a `*.test.ts` beside it if it has logic worth testing. The root `test`
   script picks up `scripts/*.test.ts`.
4. `scripts/tsconfig.json` covers every `.ts` file here, so the root `typecheck`
   checks it.
