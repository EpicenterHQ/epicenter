/**
 * Turning sync on for a folder through the addon, with no `git` program:
 * `open`, `locate`, `setSynced`, and `connect`, and the refusals they throw.
 *
 * `bun run --cwd packages/epicenter-core test` builds the addon first.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, locate, open, setSynced } from '../index.ts';

const BOX = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-core-folder-')));

test('open makes a repository with the LFS settings, once', () => {
	const folder = join(BOX, 'opened');
	mkdirSync(folder);
	expect(locate(folder)).toBeNull();
	expect(open(folder)).toEqual({
		initialized: true,
		configured: [
			'filter.lfs.clean',
			'filter.lfs.smudge',
			'filter.lfs.process',
			'filter.lfs.required',
		],
	});
	expect(open(folder)).toEqual({ initialized: false, configured: [] });
	expect(readFileSync(join(folder, '.git', 'HEAD'), 'utf8')).toBe(
		'ref: refs/heads/main\n',
	);
});

test('locate finds the working tree above a subfolder, with consent and origin', () => {
	const folder = join(BOX, 'located');
	mkdirSync(join(folder, 'notes', 'deep'), { recursive: true });
	open(folder);
	expect(locate(join(folder, 'notes', 'deep'))).toMatchObject({
		root: folder,
		synced: false,
	});
	expect(setSynced(folder, true)).toBe(true);
	expect(setSynced(folder, true)).toBe(false);
	expect(connect(folder, 'file:///remote.git')).toBe(true);
	expect(connect(folder, 'file:///remote.git')).toBe(false);
	expect(locate(folder)).toEqual({
		root: folder,
		synced: true,
		origin: 'file:///remote.git',
	});
	expect(setSynced(folder, false)).toBe(true);
	expect(locate(folder)?.synced).toBe(false);
});

test('a refusal throws an Error carrying the core’s message', () => {
	const folder = join(BOX, 'refused');
	mkdirSync(folder);
	open(folder);
	connect(folder, 'file:///one.git');
	expect(() => connect(folder, 'file:///two.git')).toThrow(
		'origin is already file:///one.git',
	);
});
