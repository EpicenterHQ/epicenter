/**
 * Print what a Vite build of the fixture application emits: each chunk, its
 * size, what it imports, and which engine text it holds.
 *
 *     bun evidence/bundles/inspect.ts [main|browser|tauri] [browser|tauri] [--modules]
 *
 * The second argument aliases the bare specifier to that explicit entry.
 * `--modules` also lists the source modules each chunk holds.
 */
import { join } from 'node:path';
import { build, type Rollup } from 'vite';

const [entry = 'main', root] = process.argv
	.slice(2)
	.filter((argument) => !argument.startsWith('--'));
const APP = join(import.meta.dir, 'app');
const MARKERS = {
	desktop: 'plugin:epicenter-folder|open_folder',
	browser: 'IndexedDB could not be opened',
	git: 'git-upload-pack',
	shell: 'sha256sum',
};

const result = await build({
	root: APP,
	configFile: false,
	logLevel: 'silent',
	resolve: {
		alias:
			root === undefined
				? []
				: [
						{
							find: /^@epicenter\/folder$/,
							replacement: `@epicenter/folder/${root}`,
						},
					],
	},
	build: {
		write: false,
		minify: false,
		target: 'esnext',
		modulePreload: false,
		rollupOptions: {
			input: join(APP, `${entry}.ts`),
			preserveEntrySignatures: 'strict',
		},
	},
});
const chunks = (Array.isArray(result) ? result : [result])
	.flatMap((item) => ('output' in item ? item.output : []))
	.filter((item): item is Rollup.OutputChunk => item.type === 'chunk');

console.log(`entry ${entry}.ts, root alias ${root ?? '(none)'}`);
for (const chunk of chunks) {
	const holds = Object.entries(MARKERS)
		.filter(([, text]) => chunk.code.includes(text))
		.map(([name]) => name);
	console.log(
		[
			chunk.fileName,
			`${chunk.code.length} chars`,
			chunk.isEntry ? 'entry' : chunk.isDynamicEntry ? 'lazy' : 'shared',
			`holds [${holds.join(', ')}]`,
			`imports [${chunk.imports.join(', ')}]`,
			`import() [${chunk.dynamicImports.join(', ')}]`,
		].join(' | '),
	);
	// Which names a chunk takes from another, and the modules a chunk holds,
	// explain why one chunk loads another.
	for (const line of chunk.code.split('\n'))
		if (/^import\b/.test(line)) console.log(`    ${line.slice(0, 260)}`);
	if (process.argv.includes('--modules'))
		for (const id of Object.keys(chunk.modules))
			console.log(
				`    holds ${id.replace(/^.*\/(node_modules|packages)\//, '$1/')}`,
			);
}
