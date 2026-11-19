#!/usr/bin/env bun
/** Runs the repository's structural checks, stopping at the first failure. */
import { $ } from 'bun';

await $`bun run check:doc-paths`;
await $`bun run check:catalog-pins`;
await $`bun run check:api-paths`;
await $`bun run check:ui-boundary`;
await $`bun run check:boot-purity`;
await $`bun run check:vocabulary`;
