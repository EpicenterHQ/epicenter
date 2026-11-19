#!/usr/bin/env bun
/** Runs the script tests, then every workspace's tests. */
import { runSteps } from './run-steps.ts';

await runSteps([
	'bun test ./scripts/*.test.ts ./.agents/skills/*/scripts/*.test.ts',
	"bun run --filter '*' test",
]);
