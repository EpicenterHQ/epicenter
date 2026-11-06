#!/usr/bin/env bun
/**
 * Compile the `epicenter` binary with `bun build --compile`: one executable
 * with no file beside it, syncing in TypeScript with no Git (ADR-0804).
 *
 * ```sh
 * bun run --cwd packages/cli compile [--outfile <path>] [--environment production|development]
 * ```
 *
 * The outfile defaults to `packages/cli/dist/epicenter`, and the environment
 * the build states (ADR-0728) to `production`.
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';

const cli = join(import.meta.dir, '..');
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		outfile: { type: 'string', default: join(cli, 'dist', 'epicenter') },
		environment: { type: 'string', default: 'production' },
	},
});
if (values.environment !== 'production' && values.environment !== 'development')
	throw new Error(
		`--environment takes production or development, not ${values.environment}`,
	);

// --bytecode needs an entry graph without top-level await, which the CLI's
// entry keeps.
await $`bun build --compile --minify --bytecode --define ${`__EPICENTER_BUILD_ENVIRONMENT__=${JSON.stringify(values.environment)}`} --outfile ${values.outfile} ${join(cli, 'src', 'bin.ts')}`;
console.error(`Compiled ${values.outfile}`);
