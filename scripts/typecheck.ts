#!/usr/bin/env bun
/** Typechecks every workspace, then the scripts folder itself. */
import { $ } from 'bun';

await $`bun run --filter '*' typecheck`;
await $`bun x tsc --noEmit -p scripts/tsconfig.json`;
