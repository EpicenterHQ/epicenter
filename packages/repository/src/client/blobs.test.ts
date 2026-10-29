/**
 * Blob Store Tests
 *
 * The blob store's conformance checks against the memory store, as every
 * other store runs them (the browser's OPFS store in
 * `browser-tests/replica.test.ts`), and the incremental hasher against the
 * platform's one-shot digest.
 *
 * Key behaviors:
 * - Every check in `BLOB_STORE_CHECKS` holds for the memory store
 * - Hashing in chunks of any size gives the one-shot SHA-256
 */
import { expect, test } from 'bun:test';
import { createHasher, createMemoryBlobStore } from './blobs.js';
import { BLOB_STORE_CHECKS, bytesOf, oidOf } from './blobs.checks.js';

for (const [name, run] of Object.entries(BLOB_STORE_CHECKS)) test(`memory store: ${name}`, () => run(createMemoryBlobStore()));

test('hashing in chunks of any size gives the one-shot SHA-256', async () => {
	const bytes = bytesOf(100_003, 9);
	for (const size of [1, 63, 64, 65, 4_096, 100_003]) {
		const hasher = createHasher();
		for (let at = 0; at < bytes.length; at += size) hasher.update(bytes.subarray(at, at + size));
		expect(hasher.digest()).toBe(await oidOf(bytes));
	}
});
