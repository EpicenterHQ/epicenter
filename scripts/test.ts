#!/usr/bin/env bun
/** Runs the script tests, then every workspace's tests. */
import { $ } from 'bun';

await $`bun test ./scripts/*.test.ts ./.agents/skills/*/scripts/*.test.ts`;
await $`bun run --filter '*' test`;
