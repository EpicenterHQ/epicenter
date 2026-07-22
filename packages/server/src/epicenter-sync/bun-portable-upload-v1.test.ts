/**
 * Bun Portable Upload Ledger Tests
 *
 * Verifies the host-owned durable staging ledger used to resume portable
 * Backup uploads without coupling their bytes to an authority lifetime.
 *
 * Key behaviors:
 * - Parts are immutable, bounded, and verified before their metadata is durable
 * - Completion requires exact contiguous membership and streams parts in order
 * - Restarts, invalid archives, lost responses, and deletion have stable outcomes
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type BunPortableUploadMaterialize,
	createBunPortableUploadV1Owner,
} from './bun-portable-upload-v1.js';

const REQUEST_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

function digestOf(value: string): string {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function byteStream(value: string): ReadableStream<Uint8Array> {
	return new Blob([value]).stream();
}

async function streamText(bytes: ReadableStream<Uint8Array>): Promise<string> {
	const chunks: Uint8Array[] = [];
	const reader = bytes.getReader();
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function setup({
	materialize,
}: {
	materialize?: BunPortableUploadMaterialize;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-portable-upload-test-'));
	const directory = join(root, 'portable-uploads');
	const published = new Map<string, { recordCount: number }>();
	const materialized: string[] = [];
	const runMaterializer: BunPortableUploadMaterialize =
		materialize ??
		(async ({ backupId, bytes }) => {
			materialized.push(await streamText(bytes));
			const backup = { recordCount: 0 };
			published.set(backupId, backup);
			return backup;
		});
	function openOwner() {
		return createBunPortableUploadV1Owner({
			directory,
			materialize: runMaterializer,
			async inspectPublished(backupId) {
				return published.get(backupId);
			},
		});
	}
	return {
		root,
		directory,
		published,
		materialized,
		openOwner,
		async close(owner?: ReturnType<typeof createBunPortableUploadV1Owner>) {
			await owner?.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

test('creation and verified parts survive a host restart', async () => {
	const context = await setup();
	let owner = context.openOwner();
	try {
		const created = await owner.createUpload(REQUEST_ID);
		expect(created).toMatchObject({
			requestId: REQUEST_ID,
			state: 'uploading',
		});
		expect(created.backupId).toHaveLength(24);
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				1,
				5,
				digestOf('first'),
				byteStream('first'),
			),
		).toEqual({ kind: 'stored' });
		await owner.close();

		owner = context.openOwner();
		expect(await owner.createUpload(REQUEST_ID)).toEqual(created);
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				1,
				5,
				digestOf('first'),
				byteStream('unused retry'),
			),
		).toEqual({ kind: 'stored' });
		expect(await owner.completeUpload(REQUEST_ID, [1])).toEqual({
			kind: 'completed',
			backup: { backupId: created.backupId, recordCount: 0 },
		});
		expect(context.materialized).toEqual(['first']);
	} finally {
		await context.close(owner);
	}
});

test('parts reject changed coordinates and bytes that fail exact verification', async () => {
	const context = await setup();
	const owner = context.openOwner();
	try {
		await owner.createUpload(REQUEST_ID);
		await owner.putUploadPart(
			REQUEST_ID,
			1,
			5,
			digestOf('first'),
			byteStream('first'),
		);
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				1,
				6,
				digestOf('second'),
				byteStream('second'),
			),
		).toEqual({ kind: 'upload-conflict' });
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				2,
				4,
				digestOf('wrong'),
				byteStream('bytes'),
			),
		).toEqual({ kind: 'invalid-upload-part' });
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				2,
				4,
				digestOf('five'),
				byteStream('five!'),
			),
		).toEqual({ kind: 'invalid-upload-part' });
		expect(() =>
			owner.putUploadPart(REQUEST_ID, 513, 1, digestOf('x'), byteStream('x')),
		).toThrow('between 1 and 512');
		expect(() =>
			owner.putUploadPart(
				REQUEST_ID,
				2,
				64 * 1024 * 1024 + 1,
				digestOf('x'),
				byteStream('x'),
			),
		).toThrow('between 1 and 67108864');
		await expect(
			owner.putUploadPart(
				REQUEST_ID,
				2,
				1,
				digestOf('x'),
				new ReadableStream({
					pull(controller) {
						controller.error(new Error('source failed'));
					},
				}),
			),
		).rejects.toThrow('source failed');
		expect(await readdir(join(context.directory, 'parts', REQUEST_ID))).toEqual(
			['001'],
		);
	} finally {
		await context.close(owner);
	}
});

test('completion requires exact contiguous membership and streams every part', async () => {
	const context = await setup();
	const owner = context.openOwner();
	try {
		const upload = await owner.createUpload(REQUEST_ID);
		await owner.putUploadPart(
			REQUEST_ID,
			1,
			3,
			digestOf('one'),
			byteStream('one'),
		);
		await owner.putUploadPart(
			REQUEST_ID,
			3,
			5,
			digestOf('three'),
			byteStream('three'),
		);
		expect(await owner.completeUpload(REQUEST_ID, [1, 3])).toEqual({
			kind: 'invalid-upload-completion',
		});
		expect(await owner.completeUpload(REQUEST_ID, [1, 2, 3])).toEqual({
			kind: 'upload-conflict',
		});
		await owner.putUploadPart(
			REQUEST_ID,
			2,
			3,
			digestOf('two'),
			byteStream('two'),
		);
		const completed = await owner.completeUpload(REQUEST_ID, [1, 2, 3]);
		expect(completed).toEqual({
			kind: 'completed',
			backup: { backupId: upload.backupId, recordCount: 0 },
		});
		expect(context.materialized).toEqual(['onetwothree']);
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				1,
				3,
				digestOf('one'),
				byteStream('one'),
			),
		).toEqual({ kind: 'upload-conflict' });
		expect(await owner.deleteUpload(REQUEST_ID)).toBe(false);
		expect(await owner.completeUpload(REQUEST_ID, [1, 2, 3])).toEqual(
			completed,
		);
		expect(context.materialized).toHaveLength(1);
	} finally {
		await context.close(owner);
	}
});

test('invalid portable bytes reset completion while preserving immutable parts', async () => {
	const context = await setup({
		async materialize({ bytes }) {
			await streamText(bytes);
			return { invalidPortableBackup: true };
		},
	});
	const owner = context.openOwner();
	try {
		const upload = await owner.createUpload(REQUEST_ID);
		await owner.putUploadPart(
			REQUEST_ID,
			1,
			7,
			digestOf('invalid'),
			byteStream('invalid'),
		);
		expect(await owner.completeUpload(REQUEST_ID, [1])).toEqual({
			kind: 'invalid-portable-backup',
		});
		expect(await owner.createUpload(REQUEST_ID)).toEqual({
			...upload,
			state: 'uploaded',
		});
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				1,
				7,
				digestOf('invalid'),
				byteStream('ignored'),
			),
		).toEqual({ kind: 'stored' });
		expect(
			await owner.putUploadPart(
				REQUEST_ID,
				2,
				1,
				digestOf('x'),
				byteStream('x'),
			),
		).toEqual({ kind: 'upload-conflict' });
		expect(await owner.deleteUpload(REQUEST_ID)).toBe(true);
	} finally {
		await context.close(owner);
	}
});

test('published materialization reconciles a lost callback response', async () => {
	let context: Awaited<ReturnType<typeof setup>>;
	context = await setup({
		async materialize({ backupId, bytes }) {
			expect(await streamText(bytes)).toBe('data');
			context.published.set(backupId, { recordCount: 4 });
			throw new Error('materializer response was lost');
		},
	});
	let owner = context.openOwner();
	try {
		const upload = await owner.createUpload(REQUEST_ID);
		await owner.putUploadPart(
			REQUEST_ID,
			1,
			4,
			digestOf('data'),
			byteStream('data'),
		);
		const completed = await owner.completeUpload(REQUEST_ID, [1]);
		expect(completed).toEqual({
			kind: 'completed',
			backup: { backupId: upload.backupId, recordCount: 4 },
		});
		await owner.close();

		owner = context.openOwner();
		expect(await owner.createUpload(REQUEST_ID)).toEqual({
			...upload,
			state: 'sealed',
		});
		expect(await owner.completeUpload(REQUEST_ID, [1])).toEqual(completed);
	} finally {
		await context.close(owner);
	}
});

test('deletion removes staged parts and startup sweeps unledgered debris', async () => {
	const context = await setup();
	let owner = context.openOwner();
	try {
		await owner.createUpload(REQUEST_ID);
		await owner.putUploadPart(
			REQUEST_ID,
			1,
			4,
			digestOf('data'),
			byteStream('data'),
		);
		const orphanDirectory = join(context.directory, 'parts', 'orphan');
		await mkdir(orphanDirectory, { recursive: true });
		await writeFile(join(orphanDirectory, '.partial'), 'debris');
		await writeFile(
			join(context.directory, 'parts', REQUEST_ID, '.001.interrupted.part'),
			'debris',
		);
		await owner.close();

		owner = context.openOwner();
		await owner.createUpload(REQUEST_ID);
		expect(await readdir(join(context.directory, 'parts'))).toEqual([
			REQUEST_ID,
		]);
		expect(await readdir(join(context.directory, 'parts', REQUEST_ID))).toEqual(
			['001'],
		);
		expect(await owner.deleteUpload(REQUEST_ID)).toBe(true);
		expect(await owner.deleteUpload(REQUEST_ID)).toBe(false);
		expect(await readdir(join(context.directory, 'parts'))).toEqual([]);
	} finally {
		await context.close(owner);
	}
});
