#!/usr/bin/env bun
/** The local merge gate: lint, typecheck, tests, then structural checks. */
import { $ } from 'bun';

await $`bun run lint:ci`;
await $`bun run typecheck`;
await $`bun run test`;
await $`bun run check:structure`;
