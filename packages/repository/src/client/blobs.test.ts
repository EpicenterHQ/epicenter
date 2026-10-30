/**
 * Blob Store Tests
 *
 * The blob store's conformance checks against the memory store and Bun's
 * file store, as every other store runs them (the browser's OPFS store in
 * `browser-tests/replica.test.ts`), and the incremental hasher against the
 * platform's one-shot digest.
 *
 * Key behaviors:
 * - Every check in `BLOB_STORE_CHECKS` holds for the memory store and the file store, which leaves no temporary file behind
 * - Hashing in chunks of any size gives the one-shot SHA-256
 */
import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileBlobStore } from '../bun/blobs.js';
import { BLOB_STORE_CHECKS, bytesOf, oidOf } from './blobs.checks.js';
import { createHasher, createMemoryBlobStore } from './blobs.js';

for (const [name, run] of Object.entries(BLOB_STORE_CHECKS)) {
	test(`memory store: ${name}`, () => run(createMemoryBlobStore()));
	test(`file store: ${name}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'blobs-'));
		try {
			await run(createFileBlobStore(join(directory, 'objects')));
			const stray = (
				await readdir(join(directory, 'objects')).catch(() => [])
			).filter((file) => !/^[0-9a-f]{64}$/.test(file));
			expect(stray).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}

test('hashing in chunks of any size gives the one-shot SHA-256', async () => {
	const bytes = bytesOf(100_003, 9);
	for (const size of [1, 63, 64, 65, 4_096, 100_003]) {
		const hasher = createHasher();
		for (let at = 0; at < bytes.length; at += size)
			hasher.update(bytes.subarray(at, at + size));
		expect(hasher.digest()).toBe(await oidOf(bytes));
	}
});
