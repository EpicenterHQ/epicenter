import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OwnedBlobFile } from '../../blob-v1/index.js';
import { createBunBlobFileStore } from './bun-blob-files.js';

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of source) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function* source(...values: string[]): AsyncIterable<Uint8Array> {
	for (const value of values) yield new TextEncoder().encode(value);
}

describe('Bun blob files', () => {
	test('streams, hashes, syncs, promotes, verifies, and reads bytes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			const staged = await files.stage(source('streamed ', 'bytes'));
			expect(staged).toEqual({
				id: `${staged.digest}.tmp`,
				digest:
					'7caf7cf97d16eb73533d88158e32aceb421e05830022d4648bd39c8e88527729',
			});
			const owner: OwnedBlobFile = {
				ownerKey: 'a'.repeat(64),
				digest: staged.digest,
			};
			await files.promote(staged, owner);
			const opened = await files.open(owner);
			expect(opened.byteLength).toBe(14);
			expect(new TextDecoder().decode(await collect(opened))).toBe(
				'streamed bytes',
			);
			expect(
				await readFile(
					join(root, 'blobs', 'content', owner.ownerKey, owner.digest),
					'utf8',
				),
			).toBe('streamed bytes');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('falls back to the async iterator when no stream reader exists', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			const iterable = source('streamed bytes');
			Object.defineProperty(iterable, 'getReader', { value: undefined });

			const staged = await files.stage(iterable);
			expect(staged.digest).toBe(
				'7caf7cf97d16eb73533d88158e32aceb421e05830022d4648bd39c8e88527729',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('prefers the stream reader and releases it normally', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			const request = new Request('http://localhost/blob', {
				method: 'POST',
				body: 'streamed bytes',
			});
			if (request.body === null) throw new Error('request body is absent');
			const reader = request.body.getReader();
			let released = false;
			Object.defineProperty(request.body, 'getReader', {
				value: () => ({
					read: reader.read.bind(reader),
					releaseLock() {
						released = true;
						reader.releaseLock();
					},
				}),
			});
			Object.defineProperty(request.body, Symbol.asyncIterator, {
				value() {
					throw new TypeError('broken async iterator');
				},
			});

			const staged = await files.stage(request.body);
			expect(staged.digest).toBe(
				'7caf7cf97d16eb73533d88158e32aceb421e05830022d4648bd39c8e88527729',
			);
			expect(released).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('does not let Bun release failure overturn a complete stage', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			const request = new Request('http://localhost/blob', {
				method: 'POST',
				body: 'streamed bytes',
			});
			if (request.body === null) throw new Error('request body is absent');
			const reader = request.body.getReader();
			let releaseAttempted = false;
			Object.defineProperty(request.body, 'getReader', {
				value: () => ({
					read: reader.read.bind(reader),
					releaseLock() {
						releaseAttempted = true;
						throw new TypeError('broken Bun releaseLock');
					},
				}),
			});

			const staged = await files.stage(request.body);
			expect(staged.digest).toBe(
				'7caf7cf97d16eb73533d88158e32aceb421e05830022d4648bd39c8e88527729',
			);
			expect(releaseAttempted).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('keeps equal bytes physically independent by record owner', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			const first = await files.stage(source('same'));
			const firstOwner = { ownerKey: 'a'.repeat(64), digest: first.digest };
			await files.promote(first, firstOwner);
			const second = await files.stage(source('same'));
			const secondOwner = { ownerKey: 'b'.repeat(64), digest: second.digest };
			await files.promote(second, secondOwner);

			await files.sweepContent([secondOwner]);
			await expect(files.open(firstOwner)).rejects.toThrow(/ENOENT/);
			expect(
				new TextDecoder().decode(await collect(await files.open(secondOwner))),
			).toBe('same');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test('reopen staging cleanup is idempotent and reads reject corrupt bytes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'epicenter-bun-blobs-'));
		try {
			const files = createBunBlobFileStore(root);
			await files.stage(source('abandoned'));
			await files.sweepStaging();
			await files.sweepStaging();

			const staged = await files.stage(source('valid'));
			const owner = { ownerKey: 'c'.repeat(64), digest: staged.digest };
			await files.promote(staged, owner);
			await writeFile(
				join(root, 'blobs', 'content', owner.ownerKey, owner.digest),
				'corrupt',
			);
			await expect(files.open(owner)).rejects.toThrow(/digest verification/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
