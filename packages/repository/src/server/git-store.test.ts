/**
 * GitObjects Conformance Tests
 *
 * The server plans every Git object id itself and stages the objects as a
 * pack, so every adapter must agree with Git byte for byte. One suite
 * runs against each adapter: the Bun store (the `git` CLI) and the memory
 * store (the simulated network's).
 *
 * Key behaviors:
 * - blob, tree and commit ids equal the ids core/hash computes
 * - a flat tree round-trips, nested paths included
 * - refs move only by compare-and-swap, and delete only from what they hold
 * - a pack of objects is written in one call with its ref update, and reads back as Git reads it
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunGitStore } from '../bun/git.js';
import { type GitObject, gitBlobHash, gitCommitHash, gitCommitObject, gitObjectId, gitTreeObject } from '../core/hash.js';
import { createTreeStore } from '../core/tree.js';
import type { GitObjects, GitObjectWrites } from './git-store.js';
import { createMemoryGitStore } from './memory-git.js';

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const adapters: [string, () => Promise<GitObjects & GitObjectWrites>][] = [
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

		test('a pack is written with its ref update in one call, and reads back as Git reads it', async () => {
			const git = await open();
			// Large enough that the pack's size header takes several bytes.
			const big = encode(`${'word '.repeat(20_000)}\n`);
			const small = encode('small\n');
			const blobs: GitObject[] = [
				{ kind: 'blob', bytes: big },
				{ kind: 'blob', bytes: small },
			];
			const inner = gitTreeObject([['a.md', { kind: 'blob', hash: gitObjectId(blobs[0] as GitObject) }]]);
			const root = gitTreeObject([
				['notes', { kind: 'tree', hash: gitObjectId(inner) }],
				['top.md', { kind: 'blob', hash: gitObjectId(blobs[1] as GitObject) }],
			]);
			const signature = { name: 'Epicenter', email: 'noreply@epicenter.so', at: 1_800_000_000 };
			const commit = gitCommitObject({ tree: gitObjectId(root), parents: [], author: signature, committer: signature, message: 'packed\n' });
			const oid = gitObjectId(commit);
			const ref = { name: 'refs/heads/staging', next: oid, expected: null };
			expect(await git.writePack([...blobs, inner, root, commit], ref)).toBe(true);
			expect(await git.readRef('refs/heads/staging')).toBe(oid);
			expect(await git.readCommit(oid)).toEqual({ tree: gitObjectId(root), parents: [], message: 'packed\n' });
			expect([...(await git.readTree(gitObjectId(root)))].sort()).toEqual([
				['notes/a.md', { mode: '100644', oid: gitBlobHash(big) }],
				['top.md', { mode: '100644', oid: gitBlobHash(small) }],
			]);
			expect(await git.readBlob(gitBlobHash(big))).toEqual(big);
			// The ref moves only from what it was.
			expect(await git.writePack([commit], ref)).toBe(false);
		});
	});
