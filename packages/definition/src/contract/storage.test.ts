import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	isHiddenPath,
	isNotePath,
	REPOSITORY_ATTRIBUTES,
	storedWithLfs,
} from './storage.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-attributes-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const PATHS = [
	'recordings/a.md',
	'a.md',
	'notes/meeting notes.md',
	'notes/Shout.MD',
	'notes/mixed.Md',
	'notes/notes.mD',
	'recordings/a.webm',
	'recordings/a.m4a',
	'photo.jpg',
	'notes/photo.JPG',
	'notes/deep/x.pdf',
	'a.json',
	'x',
	'.gitattributes',
	'.gitignore',
	'sub/.gitignore',
	'.DS_Store',
	'recordings/.DS_Store',
	'.trash/c1.json',
	'recordings/.cache/a.webm',
	'sub/.trash/a.webm',
	'.obsidian/workspace.md',
	'.obsidian/workspace.json',
];

describe('decision 40 with decision 58', () => {
	test('a hidden path is any path with a segment starting with a dot', () => {
		expect(isHiddenPath('.DS_Store')).toBe(true);
		expect(isHiddenPath('recordings/.cache/a.webm')).toBe(true);
		expect(isHiddenPath('recordings/a.webm')).toBe(false);
		expect(isHiddenPath('recordings/a.b.webm')).toBe(false);
	});

	test('a note is any path ending in .md, in any case', () => {
		expect(isNotePath('a.md')).toBe(true);
		expect(isNotePath('notes/Shout.MD')).toBe(true);
		expect(isNotePath('notes/mixed.Md')).toBe(true);
		expect(isNotePath('notes/a.mdx')).toBe(false);
		expect(isNotePath('notes/md')).toBe(false);
		expect(isNotePath('a.markdown')).toBe(false);
	});

	test('every file but a note or a hidden path is stored with LFS', () => {
		expect(PATHS.filter(storedWithLfs)).toEqual([
			'recordings/a.webm',
			'recordings/a.m4a',
			'photo.jpg',
			'notes/photo.JPG',
			'notes/deep/x.pdf',
			'a.json',
			'x',
		]);
	});

	test.each(['false', 'true'])(
		'Git reads REPOSITORY_ATTRIBUTES as the same rule (core.ignorecase=%s)',
		async (ignorecase) => {
			const repo = join(root, `repo-${ignorecase}`);
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
			await git('config', 'core.ignorecase', ignorecase);
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
				if (!isHiddenPath(path) && isNotePath(path))
					expect([path, attribute(path, 'merge')]).toEqual([path, 'epicenter']);
			}
		},
	);
});
