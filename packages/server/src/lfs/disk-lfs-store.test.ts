import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskLfsStore } from './disk-lfs-store.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-lfs-test-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const store = createDiskLfsStore({ root, maxBytes: 1024 });
const repo = 'abcdefgh12345678';
const bytes = new TextEncoder().encode('audio bytes');
const oid = createHash('sha256').update(bytes).digest('hex');
const stream = (b: Uint8Array) => new Blob([b as BlobPart]).stream();

describe('disk LFS store', () => {
	test('stores bytes whose sha256 is their oid, and only then reports them verified', async () => {
		expect(await store.verified(repo, { oid, size: bytes.length })).toBe(false);
		expect(await store.put(repo, oid, stream(bytes), bytes.length)).toEqual({
			ok: true,
			size: bytes.length,
		});
		expect(await store.verified(repo, { oid, size: bytes.length })).toBe(true);
		expect(await store.verified(repo, { oid, size: bytes.length + 1 })).toBe(
			false,
		);
		const read = await store.get(repo, oid);
		expect(read?.size).toBe(bytes.length);
		expect(await new Response(read?.body).text()).toBe('audio bytes');
		// Storing it again is not an error.
		expect((await store.put(repo, oid, stream(bytes))).ok).toBe(true);
	});

	test('refuses bytes that are not the oid, or not the declared length, and keeps nothing', async () => {
		const other = 'f'.repeat(64);
		expect(await store.put(repo, other, stream(bytes))).toEqual({
			ok: false,
			reason: 'hash-mismatch',
		});
		expect(await store.put(repo, oid, stream(bytes), 3)).toEqual({
			ok: false,
			reason: 'size-mismatch',
		});
		expect(await store.put(repo, other, stream(new Uint8Array(2000)))).toEqual({
			ok: false,
			reason: 'too-large',
		});
		expect(await store.get(repo, other)).toBeNull();
		expect(await readdir(join(root, repo, 'incoming'))).toEqual([]);
	});

	test('objects are per repository', async () => {
		expect(
			await store.verified('zzzzzzzz12345678', { oid, size: bytes.length }),
		).toBe(false);
	});
});
