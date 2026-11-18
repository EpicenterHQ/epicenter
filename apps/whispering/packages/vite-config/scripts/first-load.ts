#!/usr/bin/env bun
/**
 * Print, as a JSON array, the modules a folder app's pages pull in before
 * anything loads on demand: a production build of every page source under
 * `src/` (routes and `src/lib`, tests aside), resolved the way the app's
 * `vite.config.ts` and SvelteKit's `$lib` resolve them, and every module in
 * those entries' chunks and the chunks they import statically. A module
 * only an `import()` reaches is left out: it loads when the page asks.
 *
 * Run it in the app's folder. `firstLoadModules` in `src/module-graph.ts`
 * spawns it, one process per call.
 */
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type PluginOption, type UserConfig } from 'vite';

const [appArg] = process.argv.slice(2);
if (appArg === undefined) throw new Error('Usage: bun first-load.ts <appDir>');
const appDir = resolve(appArg);

/** Every page source under `directory`: Svelte components and modules, tests and their support aside. */
function* sources(directory: string): Generator<string> {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) yield* sources(path);
		else if (
			/\.(ts|svelte)$/.test(name) &&
			!/\.(test|test-support)\.ts$/.test(name) &&
			!/\.d\.ts$/.test(name) &&
			// Server and build modules never reach the page.
			!/(^|\/)\+(page|layout)\.server\.ts$|(^|\/)\+server\.ts$/.test(path)
		)
			yield path;
	}
}

const { default: config }: { default: UserConfig } = await import(
	pathToFileURL(join(appDir, 'vite.config.ts')).href
);
const { svelte }: { svelte: () => PluginOption } = await import(
	pathToFileURL(
		createRequire(join(appDir, 'package.json')).resolve(
			'@sveltejs/vite-plugin-svelte',
		),
	).href
);

const entries = [...sources(join(appDir, 'src'))];
const result = await build({
	root: appDir,
	configFile: false,
	logLevel: 'silent',
	plugins: [svelte()],
	resolve: {
		...config.resolve,
		alias: [{ find: /^\$lib(?=\/|$)/, replacement: join(appDir, 'src/lib') }],
	},
	define: config.define,
	build: {
		write: false,
		minify: false,
		target: 'esnext',
		rollupOptions: {
			input: entries,
			// SvelteKit's own modules and the app's environment are the
			// framework's, never a capability's.
			external: (id) => /^\$(app|env|service-worker)\b/.test(id),
			preserveEntrySignatures: 'strict',
		},
	},
});
const chunks = new Map(
	(Array.isArray(result) ? result : [result])
		.flatMap((built) => ('output' in built ? built.output : []))
		.flatMap((output) => (output.type === 'chunk' ? [output] : []))
		.map((chunk) => [chunk.fileName, chunk]),
);
const reached = new Set<string>();
const visit = (fileName: string) => {
	if (reached.has(fileName)) return;
	reached.add(fileName);
	for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
};
for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk.fileName);
const modules = JSON.stringify([
	...new Set(
		[...reached].flatMap((fileName) =>
			Object.keys(chunks.get(fileName)?.modules ?? {}),
		),
	),
]);
// The list runs past a pipe's 64 KiB buffer, and Bun exits without draining
// an unfinished write to a pipe, so wait for this one to flush.
await new Promise<void>((resolve, reject) =>
	process.stdout.write(`${modules}\n`, (error) =>
		error ? reject(error) : resolve(),
	),
);
