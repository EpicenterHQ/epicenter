import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
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
				expect(
					Buffer.from(object.bytes as Uint8Array).equals(Buffer.from(bytes)),
				).toBe(true);
			}
		});

	test('a blob over keepBlobBytes is read for its id and size, and its bytes let go', () => {
		const small = makeObject('blob', 'version https://git-lfs\n');
		const big = makeObject('blob', 'x'.repeat(4096));
		const tree = treeObject([
			{ mode: '100644', name: 'a.md', oid: big.oid },
			{ mode: '100644', name: 'b.m4a', oid: small.oid },
		]);
		const objects = readPack(writePack([small, big, tree]), {
			keepBlobBytes: 512,
		});
		expect(objects.get(big.oid)).toEqual({
			oid: big.oid,
			kind: 'blob',
			size: 4096,
			bytes: null,
		});
		expect(objects.get(small.oid)?.bytes).toEqual(small.bytes);
		expect(objects.get(tree.oid)?.bytes).toEqual(tree.bytes);
	});

	test('holds at most maxHeldBytes at once: blobs it lets go never add up', () => {
		const blobs = Array.from({ length: 12 }, (_, n) =>
			makeObject('blob', new Uint8Array(1024 * 1024).fill(n)),
		);
		const packed = writePack(blobs);
		const held = { maxHeldBytes: 3 * 1024 * 1024 };
		expect(readPack(packed, { ...held, keepBlobBytes: 512 }).size).toBe(12);
		expect(() => readPack(packed, held)).toThrow(/3 MiB in memory at once/);
		// One object larger than the whole allowance is refused before it is inflated.
		expect(() =>
			readPack(writePack([makeObject('blob', new Uint8Array(4 << 20))]), {
				...held,
				keepBlobBytes: 512,
			}),
		).toThrow(/3 MiB in memory at once/);
	});

	for (const [label, flags] of [
		['ofs-delta', ['--delta-base-offset']],
		['ref-delta', []],
	] as const)
		test(`a ${label} over a blob it lets go still resolves, within a small allowance`, async () => {
			const dir = await twoCommits();
			const objects = readPack(await gitPack(dir, 'HEAD\n', [...flags]), {
				keepBlobBytes: 512,
				maxHeldBytes: 64 * 1024,
			});
			const notes = (
				await box.ok(dir, ['rev-parse', 'HEAD:a.md', 'HEAD~1:a.md'])
			)
				.trim()
				.split('\n');
			for (const oid of notes) {
				const size = Number(
					(await box.ok(dir, ['cat-file', '-s', oid])).trim(),
				);
				expect(objects.get(oid)).toEqual({
					oid,
					kind: 'blob',
					size,
					bytes: null,
				});
			}
			const head = (await box.ok(dir, ['rev-parse', 'HEAD'])).trim();
			expect(objects.get(head)?.bytes).not.toBeNull();
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

	test('refuses a pack whose objects inflate past the budget, before inflating them', () => {
		const big = makeObject('blob', new Uint8Array(2 * 1024 * 1024));
		expect(readPack(writePack([big])).size).toBe(1);
		expect(() => readPack(writePack([big]), { maxBytes: 1024 * 1024 })).toThrow(
			/inflate past 1 MiB/,
		);
		// A header that understates the entry: inflation stops at the budget all the same.
		const zeros = deflateSync(new Uint8Array(8 * 1024 * 1024));
		const lying = pack([Buffer.concat([varintHead(3, 16), zeros])]);
		expect(() => readPack(lying, { maxBytes: 1024 * 1024 })).toThrow(
			/inflate past 1 MiB/,
		);
	});

	test('refuses a delta that declares a result past the budget, before allocating it', () => {
		const base = Buffer.from('hello\n');
		const baseEntry = Buffer.concat([
			varintHead(3, base.length),
			deflateSync(base),
		]);
		// Base size 6, result size 2^40, then one copy.
		const delta = Uint8Array.from([6, 128, 128, 128, 128, 128, 32, 0x90, 6]);
		const deltaEntry = Buffer.concat([
			varintHead(6, delta.length),
			Uint8Array.of(baseEntry.length),
			deflateSync(delta),
		]);
		expect(() =>
			readPack(pack([baseEntry, deltaEntry]), { maxBytes: 1024 * 1024 }),
		).toThrow(/inflate past 1 MiB/);
	});
});

/** A pack entry's type and size header, as Git writes it. */
function varintHead(code: number, size: number) {
	const out = [(code << 4) | (size & 15)];
	let rest = Math.floor(size / 16);
	while (rest > 0) {
		out[out.length - 1] = (out[out.length - 1] as number) | 128;
		out.push(rest & 127);
		rest = Math.floor(rest / 128);
	}
	return Uint8Array.from(out);
}

/** A version 2 pack of raw entries, with its checksum. */
function pack(entries: Uint8Array[]) {
	const head = Buffer.alloc(12);
	head.write('PACK', 0, 'ascii');
	head.writeUInt32BE(2, 4);
	head.writeUInt32BE(entries.length, 8);
	const content = Buffer.concat([head, ...entries]);
	return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}

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
