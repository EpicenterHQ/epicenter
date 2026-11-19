#!/usr/bin/env bun
/**
 * The local merge gate, and the one step CI runs. To add or remove a check,
 * edit this list.
 */
import { $ } from 'bun';

await $`bun run lint:ci`;
await $`bun run typecheck`;
await $`bun run test`;
await $`bun run check:doc-paths`;
await $`bun run check:catalog-pins`;
await $`bun run check:api-paths`;
await $`bun run check:ui-boundary`;
await $`bun run check:boot-purity`;
await $`bun run check:vocabulary`;
