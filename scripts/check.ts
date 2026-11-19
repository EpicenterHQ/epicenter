#!/usr/bin/env bun
/** The local merge gate: lint, typecheck, tests, then structural checks. */
import { runSteps } from './run-steps.ts';

await runSteps([
	'bun run lint:ci',
	'bun run typecheck',
	'bun run test',
	'bun run check:structure',
]);
