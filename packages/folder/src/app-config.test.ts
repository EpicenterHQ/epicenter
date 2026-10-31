/**
 * App Config Tests
 *
 * A desktop app's `settings.md` (`appConfig`) over a real directory, as the
 * page writes it through its config device and the shell reads it.
 *
 * Key behaviors:
 * - The first folder chosen creates the note, in the form the shell reads
 * - A later choice changes only `folder`, keeping other machine settings
 * - Choosing the folder already recorded writes nothing
 * - The default folder is no `folder` at all: choosing it removes the key
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { appConfig, rememberFolder } from './app-config.js';
import { openDevice } from './node.js';

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'app-config-'));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const settings = () => readFile(join(directory, 'settings.md'), 'utf8');

test('the first folder chosen creates settings.md as the shell reads it', async () => {
	const config = unwrap(await openDevice(appConfig, { path: directory }));
	expectOk(await rememberFolder(config, '/Users/me/Epicenter/Capture'));
	expect(await settings()).toBe(
		'---\nfolder: "/Users/me/Epicenter/Capture"\n---\n',
	);
});

test('a later choice changes only folder; the same one writes nothing', async () => {
	await writeFile(
		join(directory, 'settings.md'),
		'---\nfolder: "/old"\ntheme: dark\n---\n',
	);
	const config = unwrap(await openDevice(appConfig, { path: directory }));
	expectOk(await rememberFolder(config, '/new'));
	const after = await settings();
	expect(after).toContain('folder: "/new"');
	expect(after).toContain('theme: dark');
	expectOk(await rememberFolder(config, '/new'));
	expect(await settings()).toBe(after);
});

test('the default folder removes folder and keeps the rest', async () => {
	await writeFile(
		join(directory, 'settings.md'),
		'---\nfolder: "/old"\ntheme: dark\n---\n',
	);
	const config = unwrap(await openDevice(appConfig, { path: directory }));
	expectOk(await rememberFolder(config, undefined));
	expect(await settings()).toBe('---\ntheme: dark\n---\n');
	const fresh = await mkdtemp(join(tmpdir(), 'app-config-fresh-'));
	try {
		expectOk(
			await rememberFolder(
				unwrap(await openDevice(appConfig, { path: fresh })),
				undefined,
			),
		);
		expect(
			await readFile(join(fresh, 'settings.md'), 'utf8').catch(() => null),
		).toBeNull();
	} finally {
		await rm(fresh, { recursive: true, force: true });
	}
});
