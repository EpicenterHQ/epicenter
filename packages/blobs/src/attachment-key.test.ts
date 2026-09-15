/**
 * Row attachment storage addressing across local byte adapters.
 * Keys retain table/row identity, reject hostile paths, and reopen immutable bytes.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { attachmentStorageId, parseBlobStorageId } from './attachment-key.js';
import { parseBlobId } from './blob-id.js';
import { createBunBlobStore } from './bun.js';

test('a storage key is the same table and row across reopen and generations', () => {
	const row = 'a'.repeat(24);
	const key = attachmentStorageId('recordings', row);
	expect(String(key)).toBe(`attachment.recordings.${row}`);
	expect(parseBlobStorageId(key)).toBe(key);
	expect(parseBlobId(key)).toBeUndefined();
	expect(attachmentStorageId('interviews', row)).not.toBe(key);
});

test('local attachment addresses reject path traversal and malformed row identities', () => {
	for (const table of ['../recordings', 'a.b', '', 'x'.repeat(101)]) {
		expect(() => attachmentStorageId(table, 'a'.repeat(24))).toThrow();
	}
	for (const row of ['../escape', '', 'a'.repeat(25)]) {
		expect(() => attachmentStorageId('recordings', row)).toThrow();
	}
	expect(parseBlobStorageId('attachment.recordings.../escape')).toBeUndefined();
});

test('the Bun adapter reopens row-addressed bytes and refuses replacement', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'attachment-key-'));
	try {
		const id = attachmentStorageId('recordings', 'a'.repeat(24));
		const first = createBunBlobStore({ directory });
		expectOk(await first.put(id, new Blob(['audio'], { type: 'audio/wav' })));
		const reopened = createBunBlobStore({ directory });
		expect(await expectOk(await reopened.get(id)).text()).toBe('audio');
		expect(expectErr(await reopened.put(id, new Blob(['other']))).name).toBe(
			'BlobAlreadyExists',
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
