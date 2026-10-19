/**
 * Sync publication writes each changed path through `publishFile`. These
 * tests cover its guarded storage writes and the live file's role as the
 * change. The shared file rules have their own tests in `shared/merge.test.ts`.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawDirectoryFolder } from './directory-history.test-support.js';
import { hashBytes } from './hash.js';
import type { FileContent } from './shared/merge.js';
import { publishFile, WRITE_ATTEMPTS } from './write.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const note = (title: string, done = false) =>
	`---\ntitle: ${title}\ndone: ${done}\n---\n`;

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true })));
});

async function directory() {
	const { root, boundary } = await rawDirectoryFolder('folder-publish-');
	roots.push(root);
	const publish = (
		path: string,
		base: FileContent | null,
		next: FileContent | null,
	) => publishFile(boundary, path, base, next);
	const onDisk = (path: string) => readFile(join(root, path), 'utf8');
	return { root, boundary, publish, onDisk };
}

test('put lands only while the path holds ifMatch, and changes nothing when stale', async () => {
	const { boundary } = await directory();
	const one = encoder.encode('one\n');
	expect(expectOk(await boundary.put('a/b.md', one, null))).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', one, null))).toBe('stale');
	const first = await hashBytes(one);
	expect(
		expectOk(await boundary.put('a/b.md', encoder.encode('x'), '0'.repeat(64))),
	).toBe('stale');
	expect(
		expectOk(await boundary.put('a/b.md', encoder.encode('two\n'), first)),
	).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', null, first))).toBe('stale');
	const second = await hashBytes(encoder.encode('two\n'));
	expect(expectOk(await boundary.put('a/b.md', null, second))).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', null, second))).toBe('stale');
	expect(expectOk(await boundary.put('a/b.md', null, null))).toBe('landed');
	expect(expectErr(await boundary.read('a/b.md')).name).toBe('NotFound');
	expect(expectErr(await boundary.put('.git/x', one, null)).name).toBe(
		'InvalidPath',
	);
});

test('a racing live edit is reread and merged after a stale put', async () => {
	const { boundary } = await directory();
	expectOk(
		await boundary.put('notes/a.md', encoder.encode(note('Walk')), null),
	);
	let raced = false;
	const storage = {
		...boundary,
		async put(...args: Parameters<typeof boundary.put>) {
			if (!raced) {
				raced = true;
				const now = expectOk(await boundary.read('notes/a.md'));
				expectOk(
					await boundary.put(
						'notes/a.md',
						encoder.encode(note('Walk', true)),
						now.sha256,
					),
				);
			}
			return boundary.put(...args);
		},
	};
	const written = expectOk(
		await publishFile(
			storage,
			'notes/a.md',
			note('Walk'),
			note('Evening walk'),
		),
	);
	expect(decoder.decode(written.file?.bytes)).toBe(note('Evening walk', true));
	expect(written.overridden).toEqual([]);
});

test('a file changing on every attempt stops as KeptChanging', async () => {
	const { boundary } = await directory();
	expectOk(await boundary.put('n.txt', encoder.encode('0\n'), null));
	let count = 0;
	const storage = {
		...boundary,
		async put(...args: Parameters<typeof boundary.put>) {
			const now = expectOk(await boundary.read('n.txt'));
			expectOk(
				await boundary.put('n.txt', encoder.encode(`${++count}\n`), now.sha256),
			);
			return boundary.put(...args);
		},
	};
	expect(
		expectErr(await publishFile(storage, 'n.txt', '0\n', '0\nremote\n')),
	).toMatchObject({
		name: 'KeptChanging',
		attempts: WRITE_ATTEMPTS,
	});
	expect(decoder.decode(expectOk(await boundary.read('n.txt')).bytes)).toBe(
		`${WRITE_ATTEMPTS}\n`,
	);
});

test('publication keeps the live edit over a conflicting incoming unit', async () => {
	const { root, publish, onDisk } = await directory();
	await writeFile(join(root, 'a.txt'), 'a\nB (typed)\nc\n');
	const written = expectOk(
		await publish('a.txt', 'a\nb\nc\n', 'a\nB (remote)\nc\nadded\n'),
	);
	expect(await onDisk('a.txt')).toBe('a\nB (typed)\nc\nadded\n');
	expect(written.overridden).toEqual([
		{ kind: 'lines', part: 'text', line: 2, count: 1 },
	]);
});

test('publication joins a live addition and preserves an incoming edit over an unseen delete', async () => {
	const { root, publish, onDisk } = await directory();
	await writeFile(join(root, 'made.txt'), 'mine\n');
	expectOk(await publish('made.txt', null, 'remote\n'));
	expect(await onDisk('made.txt')).toBe('remote\nmine\n');
	const restored = expectOk(
		await publish('gone.txt', 'base\n', 'base\nremote\n'),
	);
	expect(decoder.decode(restored.file?.bytes)).toBe('base\nremote\n');
	expect(await onDisk('gone.txt')).toBe('base\nremote\n');
});

test('publication puts nothing when the merged file is already live', async () => {
	const { boundary } = await directory();
	expectOk(await boundary.put('a.txt', encoder.encode('same\n'), null));
	let puts = 0;
	const storage = {
		...boundary,
		put(...args: Parameters<typeof boundary.put>) {
			puts++;
			return boundary.put(...args);
		},
	};
	const written = expectOk(
		await publishFile(storage, 'a.txt', 'old\n', 'same\n'),
	);
	expect(puts).toBe(0);
	expect(decoder.decode(written.file?.bytes)).toBe('same\n');
});

test('publication refuses a path where a file cannot be written', async () => {
	const { root, publish } = await directory();
	await mkdir(join(root, 'notes'));
	expect(expectErr(await publish('.git/x', null, 'x')).name).toBe(
		'InvalidPath',
	);
	expect(expectErr(await publish('notes', null, 'x')).name).toBe('InvalidPath');
});
