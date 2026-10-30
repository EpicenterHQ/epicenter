import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileLfsStore } from '../bun/lfs-store.js';
import { LFS_STORE_CHECKS } from './lfs-store.checks.js';
import { createMemoryLfsStore } from './memory-lfs-store.js';
import { createR2LfsStore, type R2Bucket } from './r2-lfs-store.js';

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

const file = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'repository-lfs-'));
	dirs.push(dir);
	return createFileLfsStore(dir);
};

function fakeR2() {
	const objects = new Map<string, Uint8Array>();
	let expectedSize = 0;
	const bucket: R2Bucket = {
		async put(key, body, options) {
			if (objects.has(key)) {
				await body.cancel().catch(() => {});
				return null;
			}
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			if (bytes.length !== expectedSize)
				throw new Error('10037 length mismatch');
			const digest = Array.from(
				new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
				(byte) => byte.toString(16).padStart(2, '0'),
			).join('');
			if (digest !== options.sha256) throw new Error('10037 checksum mismatch');
			objects.set(key, bytes);
			return { size: bytes.length };
		},
		async head(key) {
			const bytes = objects.get(key);
			return bytes === undefined
				? null
				: {
						size: bytes.length,
						checksums: { sha256: key.slice('objects/'.length) },
					};
		},
		async get(key) {
			const bytes = objects.get(key);
			return bytes === undefined
				? null
				: {
						size: bytes.length,
						body: new Blob([
							bytes as BlobPart,
						]).stream() as ReadableStream<Uint8Array>,
					};
		},
	};
	return createR2LfsStore(bucket, {
		fixedLength: (size, body) => {
			expectedSize = size;
			return { readable: body, done: Promise.resolve() };
		},
	});
}

for (const [name, factory] of Object.entries({
	memory: async () => createMemoryLfsStore(),
	file,
	r2: async () => fakeR2(),
})) {
	describe(name, () => {
		for (const [title, check] of Object.entries(LFS_STORE_CHECKS))
			test(title, async () => check(await factory()));
	});
}

test('R2 retries a transient 10058 before consuming the stream', async () => {
	let attempts = 0;
	const bytes = new TextEncoder().encode('retry me');
	const oid = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	const bucket: R2Bucket = {
		async put(_key, body) {
			attempts++;
			if (attempts === 1) throw new Error('10058');
			await new Response(body).arrayBuffer();
			return { size: bytes.length };
		},
		async head() {
			return null;
		},
		async get() {
			return null;
		},
	};
	const store = createR2LfsStore(bucket, {
		fixedLength: (_size, body) => ({ readable: body, done: Promise.resolve() }),
	});
	const result = await store.put(
		oid,
		bytes.length,
		new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>,
	);
	expect(result).toMatchObject({ data: 'stored', error: null });
	expect(attempts).toBe(2);
});

test('R2 confirms an existing object after a local precondition throw', async () => {
	const bytes = new TextEncoder().encode('already here');
	const oid = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
	const bucket: R2Bucket = {
		async put() {
			throw new Error('precondition failed');
		},
		async head() {
			return { size: bytes.length, checksums: { sha256: oid } };
		},
		async get() {
			return null;
		},
	};
	const store = createR2LfsStore(bucket, {
		fixedLength: (_size, body) => ({ readable: body, done: Promise.resolve() }),
	});
	expect(
		await store.put(
			oid,
			bytes.length,
			new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>,
		),
	).toMatchObject({ data: 'present', error: null });
});
