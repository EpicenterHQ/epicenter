#!/usr/bin/env bun
/** Runs the repository's structural checks, stopping at the first failure. */
import { runSteps } from './run-steps.ts';

await runSteps([
	'bun run check:doc-paths',
	'bun run check:catalog-pins',
	'bun run check:api-paths',
	'bun run check:ui-boundary',
	'bun run check:boot-purity',
	'bun run check:vocabulary',
]);
