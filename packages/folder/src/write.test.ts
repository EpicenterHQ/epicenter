/**
 * The directory storage's guarded `put`, which `confirmedPut` (`write.ts`)
 * and every folder save go through.
 *
 * Key behaviors:
 * - A put lands only while the path holds what it expects; stale, it changes nothing
 * - An unconditional put replaces whatever is there
 * - An existing nonportable name may be replaced or removed, never made
 */
import { afterAll, expect, test } from 'bun:test';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { nodeDirectoryPrimitives } from './directory-node.js';
import { createDirectoryStorage } from './directory-store.js';
import { scratch } from './git-http.test-support.js';
import { hashBytes } from './hash.js';
import { scratchDirectory } from './native/directory.js';

const encoder = new TextEncoder();

const roots: string[] = [];
afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true })));
});

async function directory() {
	const root = await realpath(await scratch('folder-put-'));
	roots.push(root);
	const boundary = createDirectoryStorage({
		root,
		primitives: nodeDirectoryPrimitives,
		scratch: scratchDirectory(root),
		hold: {
			lock: <T>(work: () => Promise<T>) => work(),
			held: nodeDirectoryPrimitives,
		},
	});
	const onDisk = (path: string) => readFile(join(root, path), 'utf8');
	return { root, boundary, onDisk };
}

test('put lands only while the path holds what it expects, and changes nothing when stale', async () => {
	const { boundary } = await directory();
	const one = encoder.encode('one\n');
	expect(expectOk(await boundary.put('a/b.md', one, 'absent')).kind).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', one, 'absent')).kind).toBe('stale');
	const first = await hashBytes(one);
	expect(
		expectOk(
			await boundary.put('a/b.md', encoder.encode('x'), {
				sha256: '0'.repeat(64),
			}),
		).kind,
	).toBe('stale');
	expect(
		expectOk(
			await boundary.put('a/b.md', encoder.encode('two\n'), { sha256: first }),
		).kind,
	).toBe('landed');
	expect(expectOk(await boundary.put('a/b.md', null, { sha256: first })).kind).toBe(
		'stale',
	);
	const second = await hashBytes(encoder.encode('two\n'));
	expect(expectOk(await boundary.put('a/b.md', null, { sha256: second })).kind).toBe(
		'landed',
	);
	expect(expectOk(await boundary.put('a/b.md', null, { sha256: second })).kind).toBe(
		'stale',
	);
	expect(expectOk(await boundary.put('a/b.md', null, 'absent')).kind).toBe('landed');
	expect(expectErr(await boundary.read('a/b.md')).name).toBe('NotFound');
	expect(expectErr(await boundary.put('.git/x', one, 'absent')).name).toBe(
		'InvalidPath',
	);
});

test('an unconditional put replaces whatever is there and is never stale', async () => {
	const { boundary, onDisk } = await directory();
	expect(
		expectOk(await boundary.put('a.md', encoder.encode('one\n'), 'any')).kind,
	).toBe('landed');
	expect(
		expectOk(await boundary.put('a.md', encoder.encode('two\n'), 'any')).kind,
	).toBe('landed');
	expect(await onDisk('a.md')).toBe('two\n');
	expect(expectOk(await boundary.put('a.md', null, 'any')).kind).toBe('landed');
	expect(expectOk(await boundary.put('a.md', null, 'any')).kind).toBe('landed');
	expect(
		expectOk(await boundary.put('a.md', encoder.encode('x'), 'present')).kind,
	).toBe('stale');
	expect(expectErr(await boundary.read('a.md')).name).toBe('NotFound');
});

test('an existing nonportable name may be replaced or removed, never made', async () => {
	const { root, boundary, onDisk } = await directory();
	await writeFile(join(root, 'a?.md'), 'theirs\n');
	expect(
		expectOk(await boundary.put('a?.md', encoder.encode('mine\n'), 'any')).kind,
	).toBe('landed');
	expect(await onDisk('a?.md')).toBe('mine\n');
	expect(
		expectErr(await boundary.put('b?.md', encoder.encode('x'), 'any')).name,
	).toBe('InvalidPath');
	expect(
		expectErr(await boundary.put('b?.md', encoder.encode('x'), 'absent')).name,
	).toBe('InvalidPath');
	expect(expectOk(await boundary.put('a?.md', null, 'any')).kind).toBe('landed');
	expect(expectErr(await boundary.read('a?.md')).name).toBe('NotFound');
	// The file went before the write landed: it cannot make the name.
	await writeFile(join(root, 'c?.md'), 'theirs\n');
	const racing = {
		...boundary,
		async put(...args: Parameters<typeof boundary.put>) {
			await rm(join(root, 'c?.md'));
			return boundary.put(...args);
		},
	};
	expect(
		expectErr(await racing.put('c?.md', encoder.encode('x'), 'any')).name,
	).toBe('InvalidPath');
	expect(expectErr(await boundary.read('c?.md')).name).toBe('NotFound');
});
