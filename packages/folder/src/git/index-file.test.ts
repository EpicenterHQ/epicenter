/**
 * Index File Tests
 *
 * A browser folder's index is written from a tree in one pass
 * (`treeIndex`). Real Git and isomorphic-git must both read it as the tree.
 *
 * Key behaviors:
 * - `git ls-files --stage` lists exactly the tree, in Git's byte order, and
 *   `git diff-index --cached` finds nothing, with paths whose UTF-16 and
 *   UTF-8 orders differ
 * - `git status` reads the zeroed stats as unknown and finds the files clean
 * - isomorphic-git and `parseIndex` read the same entries
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as isogit from 'isomorphic-git';
import { git, scratch } from '../git-http.test-support.js';
import { parseIndex, treeIndex } from './index-file.js';

test('an index written from a tree is the tree to Git and isomorphic-git', async () => {
	const root = await scratch('tree-index-');
	try {
		await git(root, 'init', '--quiet', '--initial-branch=main');
		// `a.b` sorts after `a-b` and before `a/b`; `é` and an astral letter
		// sort differently in UTF-16 and in bytes.
		const paths = [
			'a-b.md',
			'a.b.md',
			'a/b.md',
			'a/c/d.md',
			'z.md',
			'é.md',
			'\u{1D11E}.md',
			'Ａ.md',
		];
		for (const path of paths) {
			await mkdir(join(root, path, '..'), { recursive: true });
			await writeFile(join(root, path), `${path}\n`);
		}
		await git(root, 'add', '--all');
		await git(root, 'commit', '--quiet', '-m', 'Start');
		const listed = await git(
			root,
			'-c',
			'core.quotePath=false',
			'ls-tree',
			'-r',
			'HEAD',
		);
		const files = new Map(
			listed.split('\n').map((line) => {
				const [meta, path] = line.split('\t') as [string, string];
				const [mode, , oid] = meta.split(' ') as [string, string, string];
				return [path, { mode, oid }];
			}),
		);
		const bytes = await treeIndex(files);
		await writeFile(join(root, '.git/index'), bytes);

		const staged = await git(
			root,
			'-c',
			'core.quotePath=false',
			'ls-files',
			'--stage',
		);
		expect(staged).toBe(
			listed
				.split('\n')
				.map((line) => {
					const [meta, path] = line.split('\t') as [string, string];
					const [mode, , oid] = meta.split(' ');
					return `${mode} ${oid} 0\t${path}`;
				})
				.join('\n'),
		);
		expect(await git(root, 'diff-index', '--cached', 'HEAD')).toBe('');
		expect(await git(root, 'status', '--porcelain')).toBe('');

		expect(parseIndex(bytes)?.map((entry) => entry.path)).toEqual(
			staged.split('\n').map((line) => line.split('\t')[1]!),
		);
		expect(
			(await isogit.listFiles({ fs, dir: root, gitdir: join(root, '.git') }))
				.slice()
				.sort(),
		).toEqual([...files.keys()].sort());
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
