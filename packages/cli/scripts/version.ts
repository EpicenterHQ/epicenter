#!/usr/bin/env bun
/**
 * The one version `@epicenter/app` and `@epicenter/cli` share. They are
 * released together, at the same number, because a home must load one copy
 * of the library, and the command names the library at its own version.
 *
 * With a version, write it into both package.json files and nothing else.
 * Without one, print the version both are at, and fail when they differ;
 * `check:versions` at the repository root runs it that way.
 *
 * ```sh
 * bun run --cwd packages/cli set-version 0.6.0
 * bun packages/cli/scripts/version.ts
 * ```
 */
import { join } from 'node:path';

const packages = join(import.meta.dir, '..', '..');
const MANIFESTS = [
	join(packages, 'app', 'package.json'),
	join(packages, 'cli', 'package.json'),
];
/** The `"version": "…"` field at the top level of a manifest, indented by one tab. */
const VERSION_FIELD = /^\t"version": "([^"]*)"/m;

async function read() {
	return Promise.all(
		MANIFESTS.map(async (path) => {
			const text = await Bun.file(path).text();
			const { name } = JSON.parse(text) as { name: string };
			const version = text.match(VERSION_FIELD)?.[1];
			if (!version) throw new Error(`${path} has no version field`);
			return { path, text, name, version };
		}),
	);
}

/** The version both packages are at; throws naming each when they differ. */
export async function sharedVersion(): Promise<string> {
	const manifests = await read();
	const versions = new Set(manifests.map(({ version }) => version));
	const [version] = versions;
	if (versions.size === 1 && version) return version;
	throw new Error(
		`@epicenter/app and @epicenter/cli must be at one version, and they are at ${manifests.map(({ name, version }) => `${name} ${version}`).join(', ')}. Run: bun run --cwd packages/cli set-version <x.y.z>`,
	);
}

if (import.meta.main) {
	const [next, ...rest] = Bun.argv.slice(2);
	try {
		if (next === undefined) {
			console.log(
				`@epicenter/app and @epicenter/cli are at ${await sharedVersion()}.`,
			);
			process.exit(0);
		}
		if (rest.length > 0 || !/^\d+\.\d+\.\d+$/.test(next))
			throw new Error(
				`Give one version as three numbers, such as 0.6.0, not ${[next, ...rest].join(' ')}`,
			);
		for (const { path, text, name, version } of await read()) {
			if (version === next) {
				console.log(`${name} is already at ${next}`);
				continue;
			}
			await Bun.write(
				path,
				text.replace(VERSION_FIELD, `\t"version": "${next}"`),
			);
			console.log(`${name} ${version} -> ${next}`);
		}
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
}
