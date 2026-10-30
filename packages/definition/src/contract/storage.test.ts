import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	isHiddenPath,
	REPOSITORY_ATTRIBUTES,
	storedWithLfs,
} from './storage.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-attributes-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const PATHS = [
	'recordings/a.md',
	'a.md',
	'recordings/a.webm',
	'recordings/a.m4a',
	'photo.jpg',
	'notes/deep/x.pdf',
	'.gitattributes',
	'.gitignore',
	'.DS_Store',
	'recordings/.DS_Store',
	'.epicenter/outbox/c1.json',
	'recordings/.cache/a.webm',
	'.obsidian/workspace.md',
];

describe('decision 40 with decision 58', () => {
	test('a hidden path is any path with a segment starting with a dot', () => {
		expect(isHiddenPath('.DS_Store')).toBe(true);
		expect(isHiddenPath('recordings/.cache/a.webm')).toBe(true);
		expect(isHiddenPath('recordings/a.webm')).toBe(false);
		expect(isHiddenPath('recordings/a.b.webm')).toBe(false);
	});

	test('every file but a note or a hidden path is stored with LFS', () => {
		expect(PATHS.filter(storedWithLfs)).toEqual([
			'recordings/a.webm',
			'recordings/a.m4a',
			'photo.jpg',
			'notes/deep/x.pdf',
		]);
	});

	test('Git reads REPOSITORY_ATTRIBUTES as the same rule', async () => {
		const repo = join(root, 'repo');
		await mkdir(repo, { recursive: true });
		const env = {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: root,
			GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CEILING_DIRECTORIES: root,
		};
		await writeFile(env.GIT_CONFIG_GLOBAL, '');
		const git = async (...args: string[]) => {
			const child = Bun.spawn(['git', ...args], {
				cwd: repo,
				env,
				stdout: 'pipe',
			});
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			return out;
		};
		await git('init', '--quiet');
		await writeFile(join(repo, '.gitattributes'), REPOSITORY_ATTRIBUTES);
		const out = await git('check-attr', 'filter', 'merge', '--', ...PATHS);
		const attribute = (path: string, name: string) =>
			new RegExp(`^${path.replace(/[.]/g, '\\.')}: ${name}: (.*)$`, 'm').exec(
				out,
			)?.[1];
		for (const path of PATHS) {
			expect([path, attribute(path, 'filter') === 'lfs']).toEqual([
				path,
				storedWithLfs(path),
			]);
			if (!isHiddenPath(path) && path.endsWith('.md'))
				expect([path, attribute(path, 'merge')]).toEqual([path, 'epicenter']);
		}
	});
});
