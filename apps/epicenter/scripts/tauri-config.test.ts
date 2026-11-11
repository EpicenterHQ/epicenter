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

test('Tauri build hooks name the two page builds and bundle no binary', () => {
	expect(config.bundle.externalBin).toBeUndefined();
	expect([
		config.build.beforeDevCommand.script as string,
		config.build.beforeBuildCommand as string,
		development.build.beforeDevCommand.script as string,
	]).toEqual([
		'bun run build:desktop',
		'bun run build:desktop',
		'bun run build:desktop',
	]);
	expect(scripts['build:desktop']).toBe('bun run build');
	expect(scripts.build).toBe(
		'bun run scripts/with-build-lock.ts bun run build:apps',
	);
	expect(scripts['build:apps'].split(' && ')).toEqual([
		'bun run clean:dist',
		'bun run build:home',
		'bun run build:folders',
	]);
	expect(scripts['build:home']).toBe('vite build');
	expect(scripts['build:folders']).toBe(
		'vite build --config vite.folders.config.ts',
	);
});
