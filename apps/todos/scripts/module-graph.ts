#!/usr/bin/env bun
/**
 * Print the modules Vite emits for one entry using this app's resolution
 * config. Svelte components compile as the app's build compiles them, since
 * a seam leaf may export one.
 */
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';

const appDir = join(import.meta.dir, '..');
const [entry, platform] = process.argv.slice(2);
if (
	entry === undefined ||
	(platform !== 'browser' && platform !== 'epicenter-host')
)
	throw new Error(
		'Usage: bun scripts/module-graph.ts <entry> <browser|epicenter-host>',
	);

if (platform === 'epicenter-host') process.env.EPICENTER_HOST = '1';
else delete process.env.EPICENTER_HOST;
const { default: config } = await import('../vite.config.js');
const result = await build({
	root: appDir,
	configFile: false,
	logLevel: 'silent',
	plugins: [svelte()],
	resolve: config.resolve,
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
console.log(
	JSON.stringify([
		...new Set(
			outputs.flatMap((chunk) =>
				chunk.type === 'chunk' ? Object.keys(chunk.modules) : [],
			),
		),
	]),
);
