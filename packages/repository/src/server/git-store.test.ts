/**
 * GitObjects Conformance Tests
 *
 * The server plans every Git object id itself and checks the store wrote
 * that id, so every adapter must agree with Git byte for byte. One suite
 * runs against each adapter: the Bun store (the `git` CLI) and the memory
 * store (the simulated network's).
 *
 * Key behaviors:
 * - blob, tree and commit ids equal the ids core/hash computes
 * - a flat tree round-trips, nested paths included
 * - refs move only by compare-and-swap, and delete only from what they hold
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunGitStore } from '../bun/git.js';
import { gitBlobHash, gitCommitHash } from '../core/hash.js';
import { createTreeStore } from '../core/tree.js';
import type { GitObjects } from './git-store.js';
import { createMemoryGitStore } from './memory-git.js';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const adapters: [string, () => Promise<GitObjects>][] = [
	[
		'bun',
		async () => {
			const dir = await mkdtemp(join(tmpdir(), 'epicenter-git-'));
			dirs.push(dir);
			return openBunGitStore(join(dir, 'repo.git'));
		},
	],
	['memory', async () => createMemoryGitStore()],
];

const encode = (text: string) => new TextEncoder().encode(text);

for (const [name, open] of adapters)
	describe(`${name} GitObjects`, () => {
		test('object ids are the ids core computes', async () => {
			const git = await open();
			const blob = await git.writeBlob(encode('hello\n'));
			expect(blob).toBe(gitBlobHash('hello\n'));
			const other = await git.writeBlob(encode('top\n'));
			const tree = await git.writeTree(
				new Map([
					['notes/a.md', { mode: '100644', oid: blob }],
					['notes.md', { mode: '100644', oid: other }],
				]),
			);
			const trees = createTreeStore();
			expect(tree).toBe(trees.update(trees.empty, [[['notes', 'a.md'], blob], [['notes.md'], other]]));
			const author = { name: 'alice', email: 'alice@users.epicenter.invalid' };
			const committer = { name: 'Epicenter', email: 'epicenter@users.epicenter.invalid' };
			const at = new Date(Date.UTC(2026, 9, 28, 12));
			const message = 'Edit notes/a.md\n\nnotes/a.md\n';
			const commit = await git.writeCommit({ tree, parents: [], message, author, committer, at });
			const seconds = at.getTime() / 1000;
			expect(commit).toBe(gitCommitHash({ tree, parents: [], message, author: { ...author, at: seconds }, committer: { ...committer, at: seconds } }));
			expect(await git.readCommit(commit)).toEqual({ tree, parents: [], message });
			expect(new TextDecoder().decode((await git.readBlob(blob)) ?? new Uint8Array())).toBe('hello\n');
			expect([...(await git.readTree(tree))].sort()).toEqual([
				['notes.md', { mode: '100644', oid: other }],
				['notes/a.md', { mode: '100644', oid: blob }],
			]);
		});

		test('refs move by compare-and-swap and delete only from what they hold', async () => {
			const git = await open();
			const tree = await git.writeTree(new Map());
			const author = { name: 'a', email: 'a@b' };
			const one = await git.writeCommit({ tree, parents: [], message: 'one\n', author, at: new Date(0) });
			const two = await git.writeCommit({ tree, parents: [one], message: 'two\n', author, at: new Date(0) });
			expect(await git.readRef('refs/heads/main')).toBeNull();
			expect(await git.updateRef('refs/heads/main', one, two)).toBe(false);
			expect(await git.updateRef('refs/heads/main', one, null)).toBe(true);
			expect(await git.updateRef('refs/heads/main', two, null)).toBe(false);
			expect(await git.updateRef('refs/heads/main', two, one)).toBe(true);
			expect(await git.deleteRef('refs/heads/main', one)).toBe(false);
			expect(await git.readRef('refs/heads/main')).toBe(two);
			expect(await git.deleteRef('refs/heads/main', two)).toBe(true);
			expect(await git.deleteRef('refs/heads/main', two)).toBe(true);
			expect(await git.readRef('refs/heads/main')).toBeNull();
		});
	});
