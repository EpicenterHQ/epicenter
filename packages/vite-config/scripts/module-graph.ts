#!/usr/bin/env bun
/**
 * Print, as a JSON array, the modules Vite emits for one entry of a folder app,
 * resolved with the conditions, aliases, and defines the app's
 * `vite.config.ts` declares. Svelte components compile as the app's build
 * compiles them, since a seam leaf may export one.
 *
 * Run it in the app's folder, which the app's config, like SvelteKit, takes as
 * its root. `bundledModules` in `src/module-graph.ts` spawns it, one process
 * per call.
 */
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type PluginOption, type UserConfig } from 'vite';

const [appArg, entry] = process.argv.slice(2);
if (appArg === undefined || entry === undefined)
	throw new Error('Usage: bun module-graph.ts <appDir> <entry>');
const appDir = resolve(appArg);

const { default: config }: { default: UserConfig } = await import(
	pathToFileURL(join(appDir, 'vite.config.ts')).href
);
// The app's own Svelte plugin: this package does not depend on it.
const { svelte }: { svelte: () => PluginOption } = await import(
	pathToFileURL(
		createRequire(join(appDir, 'package.json')).resolve(
			'@sveltejs/vite-plugin-svelte',
		),
	).href
);

const result = await build({
	root: appDir,
	configFile: false,
	logLevel: 'silent',
	plugins: [svelte()],
	resolve: config.resolve,
	define: config.define,
	build: {
		write: false,
		minify: false,
		target: 'esnext',
		rollupOptions: {
			input: join(appDir, entry),
			preserveEntrySignatures: 'strict',
		},
	},
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((built) =>
	'output' in built ? built.output : [],
);
const modules = JSON.stringify([
	...new Set(
		outputs.flatMap((chunk) =>
			chunk.type === 'chunk' ? Object.keys(chunk.modules) : [],
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
