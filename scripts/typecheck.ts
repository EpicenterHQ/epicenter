#!/usr/bin/env bun
/** Typechecks every workspace, then the scripts folder itself. */
import { runSteps } from './run-steps.ts';

await runSteps([
	"bun run --filter '*' typecheck",
	'bun x tsc --noEmit -p scripts/tsconfig.json',
]);
