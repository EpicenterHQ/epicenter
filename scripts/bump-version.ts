#!/usr/bin/env node

/**
 * @fileoverview Version stamping utility for the Epicenter monorepo.
 *
 * Stamps a version number into all package.json, tauri.conf.json, and Cargo.toml
 * files. Discovers files via glob: no hardcoded list.
 *
 * Git operations (commit, tag, push) are handled by CI, not this script.
 *
 * Usage: bun run bump-version <new-version>
 * Example: bun run bump-version 8.0.0
 */

import { join } from 'node:path';
import { Glob } from 'bun';

const newVersion = process.argv[2];
if (!newVersion) {
	console.error('Usage: bun run bump-version <new-version>');
	console.error('Example: bun run bump-version 8.0.0');
	process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
	console.error(
		'Invalid version format. Use semantic versioning (e.g., 8.0.0)',
	);
	process.exit(1);
}

const root = process.cwd();

/** Collect files to stamp via globs. */
async function collectFiles() {
	const patterns: { glob: string; type: 'json' | 'toml' }[] = [
		{ glob: 'package.json', type: 'json' },
		{ glob: 'apps/*/package.json', type: 'json' },
		{ glob: 'programs/*/package.json', type: 'json' },
		{ glob: 'sites/*/package.json', type: 'json' },
		// packages/*/package.json intentionally excluded — packages use independent
		// semver for npm publishing. Only apps, programs, and sites share the
		// monorepo version.
		{ glob: 'programs/*/src-tauri/tauri.conf.json', type: 'json' },
		{ glob: 'programs/*/src-tauri/Cargo.toml', type: 'toml' },
	];

	const files: { path: string; type: 'json' | 'toml' }[] = [];

	for (const { glob: pattern, type } of patterns) {
		const glob = new Glob(pattern);
		for await (const match of glob.scan({ cwd: root })) {
			files.push({ path: match, type });
		}
	}

	return files;
}

const files = await collectFiles();

/** Track the current version before updating. */
let oldVersion: string | null = null;

for (const { path, type } of files) {
	const fullPath = join(root, path);
	const file = Bun.file(fullPath);
	const content = await file.text();

	switch (type) {
		case 'json': {
			const json = JSON.parse(content);
			if (!oldVersion && json.version) {
				oldVersion = json.version;
			}
			json.version = newVersion;
			await Bun.write(fullPath, `${JSON.stringify(json, null, '\t')}\n`);
			break;
		}
		case 'toml': {
			const versionRegex = /^version\s*=\s*"[\d.]+"/m;
			const match = content.match(versionRegex);
			if (match && !oldVersion) {
				oldVersion = match[0].match(/"([\d.]+)"/)?.[1] ?? null;
			}
			const updated = content.replace(
				versionRegex,
				`version = "${newVersion}"`,
			);
			await Bun.write(fullPath, updated);
			break;
		}
	}

	console.log(`Updated ${path}`);
}

/** Update Cargo.lock for each Tauri app. */
const cargoTomls = files.filter((f) => f.type === 'toml');
for (const { path } of cargoTomls) {
	const tauriDir = join(root, path, '..');
	const packageName = path.split('/')[1]!; // apps/{name}/src-tauri/Cargo.toml → {name}
	try {
		console.log(`\nUpdating Cargo.lock for ${packageName}...`);
		const proc = Bun.spawn(['cargo', 'update', '-p', packageName], {
			cwd: tauriDir,
			stdout: 'inherit',
			stderr: 'inherit',
		});
		await proc.exited;
		console.log(`Updated Cargo.lock for ${packageName}`);
	} catch (error) {
		console.error(
			`Failed to update Cargo.lock for ${packageName}:`,
			error instanceof Error ? error.message : String(error),
		);
		console.log(
			`  You may need to run: cd ${tauriDir} && cargo update -p ${packageName}`,
		);
	}
}

console.log(`\nVersion bumped from ${oldVersion} to ${newVersion}`);
