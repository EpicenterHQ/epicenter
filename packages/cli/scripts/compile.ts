#!/usr/bin/env bun
/**
 * Compile the app runner into one executable. The outfile defaults to
 * dist/epicenter. The executable carries `@epicenter/app` as the module
 * `epicenter:app-package` (`src/app-package.ts`), collected from what this
 * repository installed (`app-package.ts`).
 */

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import packageJson from '../package.json' with { type: 'json' };
import { collectAppPackage } from './app-package.ts';

const cli = join(import.meta.dir, '..');
const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		outfile: { type: 'string', default: join(cli, 'dist', 'epicenter') },
	},
});
const carried = await collectAppPackage(
	join(cli, '..', 'app'),
	packageJson.version,
);
// Bytecode needs an entry graph without top-level await, which the CLI's
// entry keeps; the carried package is imported only when it is needed.
const result = await Bun.build({
	entrypoints: [join(cli, 'src', 'bin.ts')],
	compile: { outfile: values.outfile },
	target: 'bun',
	format: 'esm',
	minify: true,
	bytecode: true,
	throw: false,
	plugins: [
		{
			name: 'epicenter:app-package',
			setup(build) {
				build.onResolve({ filter: /^epicenter:app-package$/ }, ({ path }) => ({
					path,
					namespace: 'epicenter',
				}));
				build.onLoad({ filter: /.*/, namespace: 'epicenter' }, () => ({
					contents: `export default ${JSON.stringify(carried)};`,
					loader: 'js',
				}));
			},
		},
	],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.error(
	`Compiled ${values.outfile}, carrying @epicenter/app ${carried.key} (${carried.files.length} files)`,
);
