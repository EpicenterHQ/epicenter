/**
 * Every command that starts or packages the app builds the pages the shell
 * serves first. The app carries no external binary: it neither runs nor
 * bundles the `epicenter` CLI (ADR-0793, ADR-0817), so nothing else must be
 * compiled before the shell.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const config = await Bun.file(
	join(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json'),
).json();
const development = await Bun.file(
	join(import.meta.dir, '..', 'src-tauri', 'tauri.dev.conf.json'),
).json();
const scripts = (
	await Bun.file(join(import.meta.dir, '..', 'package.json')).json()
).scripts as Record<string, string>;

/** The npm script names a `bun run <name>` command line invokes, in order. */
function scriptsRun(command: string): string[] {
	return [...command.matchAll(/bun run ([\w:-]+)/g)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
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

test('starting and packaging the app build the pages first, and bundle no binary', () => {
	expect(config.bundle.externalBin).toBeUndefined();
	for (const command of [
		config.build.beforeDevCommand.script as string,
		config.build.beforeBuildCommand as string,
		development.build.beforeDevCommand.script as string,
	]) {
		const reached = scriptsRun(command).flatMap((name) => [...expand(name)]);
		expect(reached).toContain('build:home');
		expect(reached).toContain('build:folders');
	}
});
