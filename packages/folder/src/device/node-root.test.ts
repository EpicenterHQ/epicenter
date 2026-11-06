/**
 * The Epicenter folder in Bun (`node-root.ts`): what a listing tidies.
 *
 * Key behaviors:
 * - The recovery sweep removes stale saves anywhere in a folder, and never
 *   a recording in progress, a fresh save, or any other hidden file
 * - An identity is the inode and birth time; zero is no birth time
 * - Git keeps a folder with `.git` at its root, and nothing above it counts
 * - The Epicenter folder lists its real directories, and each link as outside it
 */
import { expect, test } from 'bun:test';
import {
	mkdir,
	readdir,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { identityOf, proves } from '../identity.js';
import { scratch } from '../scratch.test-support.js';
import {
	epicenterRoot,
	folderIdentity,
	keptByGit,
	sweepSaves,
} from './node-root.js';

test('the recovery sweep removes only stale saves, at any depth', async () => {
	const root = await scratch('node-root-sweep-');
	try {
		await mkdir(join(root, 'notes/deep'), { recursive: true });
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const files = {
			'.ep-stale0001.save': true,
			'notes/deep/.ep-stale0002.save': true,
			'notes/.ep-fresh0003.save': false,
			'notes/.ep-k3j9x2ab-take.recording': false,
			'.DS_Store': false,
			'notes/.hidden.md': false,
			'notes/a.md': false,
		};
		for (const path of Object.keys(files)) {
			await writeFile(join(root, path), 'x');
			if (!path.includes('fresh')) await utimes(join(root, path), old, old);
		}
		await sweepSaves(root);
		const left = (await readdir(root, { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
			.sort();
		expect(left).toEqual(
			Object.entries(files)
				.filter(([, swept]) => !swept)
				.map(([path]) => path)
				.sort(),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('an identity is the inode and birth time, and a missing birth time proves nothing', async () => {
	const root = await scratch('node-root-identity-');
	try {
		const real = await stat(root, { bigint: true });
		const identity = await folderIdentity(root);
		expect(identity.inode).toBe(real.ino.toString());
		expect(identity.birthtime).toBe(
			real.birthtimeNs > 0n ? real.birthtimeNs.toString() : null,
		);
		const none = identityOf({ ino: 7n, birthtimeNs: 0n });
		expect(none).toEqual({ inode: '7', birthtime: null });
		expect(proves(none, none)).toBe(false);
		expect(
			proves({ inode: '7', birthtime: '1' }, { inode: '7', birthtime: '1' }),
		).toBe(true);
		expect(
			proves({ inode: '7', birthtime: '1' }, { inode: '7', birthtime: '2' }),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Git keeps a folder with .git at its own root, and nothing above it counts', async () => {
	const root = await scratch('node-root-git-');
	try {
		await mkdir(join(root, 'plain'));
		await mkdir(join(root, 'repo/.git'), { recursive: true });
		await mkdir(join(root, 'worktree'));
		await writeFile(join(root, 'worktree/.git'), 'gitdir: /elsewhere\n');
		await mkdir(join(root, 'repo/inside'));
		expect(await keptByGit(join(root, 'plain'))).toBe(false);
		expect(await keptByGit(join(root, 'repo'))).toBe(true);
		expect(await keptByGit(join(root, 'worktree'))).toBe(true);
		expect(await keptByGit(join(root, 'repo/inside'))).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('the Epicenter folder lists its real directories, and each link as outside it', async () => {
	const base = await scratch('node-root-outside-');
	try {
		const home = join(base, 'Epicenter');
		await mkdir(join(home, 'Notes'), { recursive: true });
		await mkdir(join(base, 'Drive/Recipes'), { recursive: true });
		await symlink(join(base, 'Drive/Recipes'), join(home, 'Recipes'));
		await symlink(join(base, 'Gone'), join(home, 'Gone'));
		await writeFile(join(home, 'loose.md'), 'a file');
		await symlink(join(home, 'loose.md'), join(home, 'Loose link'));
		const listed = expectOk(await epicenterRoot(home).list());
		expect(listed.folders.map(({ name }) => name)).toEqual(['Notes']);
		expect(listed.outside).toEqual([
			{ name: 'Gone', path: join(home, 'Gone'), target: join(base, 'Gone') },
			{
				name: 'Recipes',
				path: join(home, 'Recipes'),
				target: join(base, 'Drive/Recipes'),
			},
		]);
		expect(listed.unreadable).toEqual([]);
		expect(listed.git).toBe(false);
		await mkdir(join(home, '.git'));
		expect(expectOk(await epicenterRoot(home).list()).git).toBe(true);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
