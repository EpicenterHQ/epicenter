/**
 * Collect `@epicenter/app` as a compiled `epicenter` carries it
 * (`src/app-package.ts`): the package's `package.json` and `src/` without
 * tests, and under `node_modules/` every package it depends on, each with its
 * own dependencies, as `bun install` would lay them out flat. Every file is
 * read from what this repository installed, so the binary carries exactly
 * what its tests ran against.
 */
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { AppPackageFiles } from '../src/app-package.ts';

type Manifest = {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
};

/** The folder of package `name` as Node resolves it from `from`: the nearest `node_modules/<name>` above it, followed to where it is. */
function packageFolder(name: string, from: string): string {
	for (let dir = from; ; dir = dirname(dir)) {
		const candidate = join(dir, 'node_modules', name);
		if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
		if (dirname(dir) === dir) throw new Error(`${name} is not installed above ${from}`);
	}
}

/** Every file under `dir` but nested `node_modules/`, source maps, and tests. */
async function filesIn(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		const rel = relative(dir, path);
		if (rel.split('/').includes('node_modules')) continue;
		if (rel.endsWith('.map') || /\.test\.ts$/.test(rel)) continue;
		found.push(rel);
	}
	return found.sort();
}

export async function collectAppPackage(
	appFolder: string,
	cliVersion: string,
): Promise<AppPackageFiles> {
	const files: [string, string][] = [];
	const add = async (from: string, to: string) =>
		files.push([to, (await readFile(from)).toString('base64')]);

	const manifest = JSON.parse(
		await readFile(join(appFolder, 'package.json'), 'utf8'),
	) as Manifest & Record<string, unknown>;
	// The package as an app's tools read it: its exports and dependencies, with the versions installed here.
	const placed = new Map<string, { folder: string; version: string }>();
	const queue: { name: string; from: string }[] = Object.keys(
		manifest.dependencies ?? {},
	).map((name) => ({ name, from: appFolder }));
	while (queue.length) {
		const { name, from } = queue.shift()!;
		const folder = packageFolder(name, from);
		const dep = require(join(folder, 'package.json')) as Manifest;
		const already = placed.get(name);
		if (already) {
			if (already.version !== dep.version)
				throw new Error(
					`${name} is needed at ${already.version} and ${dep.version}; a flat node_modules holds one`,
				);
			continue;
		}
		placed.set(name, { folder, version: dep.version });
		for (const next of Object.keys(dep.dependencies ?? {}))
			queue.push({ name: next, from: folder });
	}
	const dependencies = Object.fromEntries(
		[...placed].filter(([name]) => name in (manifest.dependencies ?? {})).map(([name, { version }]) => [name, version]),
	);
	files.push([
		'package.json',
		Buffer.from(
			`${JSON.stringify(
				{
					name: manifest.name,
					version: manifest.version,
					type: manifest.type,
					exports: manifest.exports,
					dependencies,
				},
				null,
				2,
			)}\n`,
		).toString('base64'),
	]);
	for (const rel of await filesIn(join(appFolder, 'src')))
		await add(join(appFolder, 'src', rel), join('src', rel));
	for (const [name, { folder }] of placed)
		for (const rel of await filesIn(folder))
			await add(join(folder, rel), join('node_modules', name, rel));

	const hasher = new Bun.CryptoHasher('sha256');
	for (const [path, base64] of files) hasher.update(`${path}\0${base64}\0`);
	return { key: `${cliVersion}-${hasher.digest('hex').slice(0, 12)}`, files };
}
