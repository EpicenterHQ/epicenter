import { $ } from 'bun';

/**
 * Runs shell commands in order and exits with the first failure's code.
 * Shared by the scripts that chain other commands; the root `package.json`
 * stays one call per script (see scripts/README.md).
 */
export async function runSteps(steps: readonly string[]) {
	for (const step of steps) {
		const run = await $`${{ raw: step }}`.nothrow();
		if (run.exitCode !== 0) process.exit(run.exitCode);
	}
}
