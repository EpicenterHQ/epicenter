#!/usr/bin/env bun
/** Compile the app runner into one executable. The outfile defaults to dist/epicenter. */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { $ } from 'bun';

const cli = join(import.meta.dir, '..');
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		outfile: { type: 'string', default: join(cli, 'dist', 'epicenter') },
	},
});
// --bytecode needs an entry graph without top-level await, which the CLI's
// entry keeps.
await $`bun build --compile --minify --bytecode --outfile ${values.outfile} ${join(cli, 'src', 'bin.ts')}`;
console.error(`Compiled ${values.outfile}`);
