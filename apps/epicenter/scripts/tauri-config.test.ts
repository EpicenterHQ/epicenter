/**
 * The Tauri config declares the Bun host as an external binary, and
 * `src-tauri/binaries/` is gitignored. `build.rs` panics on a missing external
 * binary before the app compiles, so every command that starts or packages the
 * app must compile the sidecar first. `dev:desktop` once ran only the SPA
 * build, which failed on a fresh clone with a missing
 * `binaries/epicenter-cli-<triple>` resource.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const config = await Bun.file(
	join(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json'),
).json();
const scripts = (
	await Bun.file(join(import.meta.dir, '..', 'package.json')).json()
).scripts as Record<string, string>;

/** The npm script names a `bun run <name>` command line invokes, in order. */
function scriptsRun(command: string): string[] {
	return [...command.matchAll(/bun run ([\w:-]+)/g)].map((match) => match[1]);
}

/** Every script `name` runs, following `bun run` chains. */
function expand(name: string): Set<string> {
	const seen = new Set<string>();
	const visit = (current: string) => {
		if (seen.has(current)) return;
		seen.add(current);
		for (const next of scriptsRun(scripts[current] ?? '')) visit(next);
	};
	visit(name);
	return seen;
}

test('starting and packaging the app both compile the Bun sidecar first', () => {
	expect(config.bundle.externalBin).toEqual(['binaries/epicenter-cli']);
	const dev = config.build.beforeDevCommand.script as string;
	const build = config.build.beforeBuildCommand as string;
	for (const command of [dev, build]) {
		const reached = scriptsRun(command).flatMap((name) => [...expand(name)]);
		expect(reached).toContain('build:sidecar');
		expect(reached).toContain('build:home');
	}
});
