import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
	createGitSandbox,
	type GitSandbox,
} from '../test-helpers/sandbox-git.js';
import { commitObject, makeObject, treeObject } from './objects.js';
import { readPack, writePack } from './pack.js';
import { readCommandLines } from './pkt.js';

let box: GitSandbox;
beforeAll(async () => {
	box = await createGitSandbox();
});
afterAll(async () => {
	await rm(box.root, { recursive: true, force: true });
});

/** A working repository with two commits of one long file that differ in one line, so Git deltifies. */
async function twoCommits() {
	const dir = await box.dir('work');
	await box.ok(dir, ['init', '--quiet']);
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i} of the note`);
	await box.write(dir, { 'a.md': `${lines.join('\n')}\n` });
	await box.ok(dir, ['add', '.']);
	await box.ok(dir, ['commit', '--quiet', '-m', 'one']);
	lines[200] = 'changed';
	await box.write(dir, { 'a.md': `${lines.join('\n')}\n` });
	await box.ok(dir, ['commit', '--quiet', '-am', 'two']);
	return dir;
}

async function gitPack(dir: string, revs: string, flags: string[]) {
	const child = Bun.spawn(
		['git', 'pack-objects', '--stdout', '--revs', ...flags],
		{
			cwd: dir,
			env: box.env,
			stdin: new Blob([revs]),
			stdout: 'pipe',
			stderr: 'ignore',
		},
	);
	const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
	expect(await child.exited).toBe(0);
	return bytes;
}

describe('readPack', () => {
	for (const [label, flags] of [
		['ofs-delta', ['--delta-base-offset']],
		['ref-delta', []],
	] as const)
		test(`reads every object of a pack Git deltified with ${label}`, async () => {
			const dir = await twoCommits();
			const objects = readPack(await gitPack(dir, 'HEAD\n', [...flags]));
			const listed = (
				await box.ok(dir, [
					'rev-list',
					'--objects',
					'--no-object-names',
					'HEAD',
				])
			)
				.trim()
				.split('\n');
			expect([...objects.keys()].sort()).toEqual([...listed].sort());
			for (const [oid, object] of objects) {
				const type = (await box.ok(dir, ['cat-file', '-t', oid])).trim();
				expect(object.kind).toBe(type as typeof object.kind);
				const child = Bun.spawn(['git', 'cat-file', type, oid], {
					cwd: dir,
					env: box.env,
					stdout: 'pipe',
				});
				const bytes = new Uint8Array(
					await new Response(child.stdout).arrayBuffer(),
				);
				expect(Buffer.from(object.bytes).equals(Buffer.from(bytes))).toBe(true);
			}
		});

	test('refuses a thin pack, whose delta base is outside it', async () => {
		const dir = await twoCommits();
		const thin = await gitPack(dir, 'HEAD\n^HEAD~1\n', ['--thin']);
		expect(() => readPack(thin)).toThrow(/thin pack/);
	});

	test('refuses a pack whose checksum does not match', async () => {
		const pack = writePack([makeObject('blob', 'hello\n')]);
		pack[20] = (pack[20] as number) ^ 1;
		expect(() => readPack(pack)).toThrow(/checksum/);
	});

	test('an empty body is an empty pack', () => {
		expect(readPack(new Uint8Array()).size).toBe(0);
	});
});

describe('writePack', () => {
	test('Git indexes it, and its ids are the ones Git computes', async () => {
		const blob = makeObject('blob', 'a note\n');
		const big = makeObject('blob', 'x'.repeat(70_000));
		const tree = treeObject([
			{ mode: '100644', name: 'a.md', oid: blob.oid },
			{ mode: '100644', name: 'big.txt', oid: big.oid },
		]);
		const commit = commitObject({
			tree: tree.oid,
			parents: [],
			author: { name: 'Web', email: 'web@example.test', at: new Date(0) },
			message: 'one\n',
		});
		const bare = await box.dir('bare');
		await box.ok(bare, ['init', '--quiet', '--bare']);
		await box.ok(
			bare,
			['index-pack', '--stdin'],
			writePack([blob, big, tree, commit]),
		);
		await box.ok(bare, ['update-ref', 'refs/heads/main', commit.oid]);
		expect(await box.ok(bare, ['fsck', '--strict', '--no-dangling'])).toBe('');
		expect(await box.ok(bare, ['show', 'main:a.md'])).toBe('a note\n');
		expect(readPack(writePack([blob, big, tree, commit])).size).toBe(4);
	});
});

describe('readCommandLines', () => {
	test('splits commands from the pack at the first flush', () => {
		const body = new TextEncoder().encode('0009abcd\n0000PACKrest');
		const { lines, rest } = readCommandLines(body);
		expect(lines).toEqual(['abcd\n']);
		expect(new TextDecoder().decode(rest)).toBe('PACKrest');
	});
});
