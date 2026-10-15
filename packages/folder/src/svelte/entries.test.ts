/**
 * Svelte Entry Boundary Tests
 *
 * Svelte is an optional peer: no package entry may reach it.
 * These tests follow every runtime import from each package export through
 * the package's own modules, so a re-export or a stray helper import that
 * would make core or platform code load Svelte fails here.
 */
import { expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import manifest from '../../package.json';

const packageRoot = join(import.meta.dir, '../..');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** The package modules and outside specifiers an entry loads at runtime. */
async function reached(entry: string) {
	const files = new Set<string>();
	const outside = new Set<string>();
	const queue = [join(packageRoot, entry)];
	for (const file of queue) {
		if (files.has(file)) continue;
		files.add(file);
		const source = await Bun.file(file).text();
		for (const { path } of transpiler.scanImports(source)) {
			if (path.startsWith('.'))
				queue.push(Bun.resolveSync(path, dirname(file)));
			else outside.add(path);
		}
	}
	return { files: [...files], outside: [...outside] };
}

const entries = Object.entries(manifest.exports);

test('no core or platform entry loads Svelte or the adapter', async () => {
	const platformEntries = entries;
	expect(platformEntries.map(([name]) => name)).toEqual([
		'.',
		'./browser',
		'./tauri',
		'./bun',
		'./file-browser',
		'./query',
	]);
	for (const [, entry] of platformEntries) {
		const { files, outside } = await reached(entry);
		expect(outside.filter((path) => /^svelte(\/|$)/.test(path))).toEqual([]);
		expect(files.filter((file) => file.includes('/src/svelte/'))).toEqual([]);
	}
});
