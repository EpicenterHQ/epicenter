/** Archive persistence and installation against immutable filesystem objects. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { captureArchive } from './archive.js';
import { installArchive, storeVerifiedBlob } from './archive-storage.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), 'restore-archive-'));
	directories.push(directory);
	const source = createBunBlobStore({ directory: join(directory, 'source') });
	const destination = createBunBlobStore({
		directory: join(directory, 'destination'),
	});
	const ids = [generateBlobId('wav'), generateBlobId('wav')].sort();
	const doc = new Y.Doc();
	try {
		for (const [index, id] of ids.entries()) {
			doc.get('attachments').setAttr(String(index), id);
			expectOk(
				await source.put(
					id,
					new Blob([`content ${index}`], { type: 'audio/wav' }),
				),
			);
		}
		const capture = {
			generation: 3,
			head: 1,
			snapshot: { position: 1, bytes: Y.encodeStateAsUpdateV2(doc) },
			tail: [],
		};
		const archive = expectOk(
			await captureArchive(capture, source, {
				appId: 'so.epicenter.notes',
				dataId: 'so.epicenter.notes',
			}),
		);
		return { directory, source, destination, ids, capture, archive };
	} finally {
		doc.destroy();
	}
}

test('installation survives reopening and preserves blob ids, bytes, MIME types and fresh lineage', async () => {
	const s = await setup();
	const installed = expectOk(
		await installArchive({
			archive: s.archive,
			blobs: s.destination,
		}),
	);
	const reopenedDestination = createBunBlobStore({
		directory: join(s.directory, 'destination'),
	});
	for (const blobId of s.ids) {
		const source = expectOk(await s.source.get(blobId));
		const target = expectOk(await reopenedDestination.get(blobId));
		expect(await target.text()).toBe(await source.text());
		expect(target.type).toBe(source.type);
	}
	const original = new Y.Doc();
	const restored = new Y.Doc();
	try {
		Y.applyUpdateV2(original, s.capture.snapshot.bytes);
		Y.applyUpdateV2(restored, installed.bytes);
		expect(restored.get('attachments').getAttrs()).toEqual(
			original.get('attachments').getAttrs(),
		);
		for (const writer of original.store.clients.keys())
			expect(restored.store.clients.has(writer)).toBe(false);
	} finally {
		original.destroy();
		restored.destroy();
	}
});

test('interrupted blob installation retries matching objects without replacing them', async () => {
	const s = await setup();
	const second = s.ids[1]!;
	const interrupted: Pick<BlobStore, 'put' | 'get'> = {
		async put(id, blob) {
			return id === second
				? BlobStoreError.BlobStoreFailed({ id, cause: 'interrupted' })
				: s.destination.put(id, blob);
		},
		get: s.destination.get,
	};
	expect(
		expectErr(await installArchive({ archive: s.archive, blobs: interrupted }))
			.name,
	).toBe('BlobStoreFailed');
	expectOk(await s.destination.get(s.ids[0]!));
	expect(expectErr(await s.destination.get(second)).name).toBe('BlobNotFound');
	expectOk(await installArchive({ archive: s.archive, blobs: s.destination }));
	expectOk(await installArchive({ archive: s.archive, blobs: s.destination }));
});

test('an existing destination id with different bytes refuses installation and remains unchanged', async () => {
	const s = await setup();
	const id = s.ids[0]!;
	const blob = new Blob(['different'], { type: 'audio/wav' });
	expectOk(await s.destination.put(id, blob));
	expect(
		expectErr(
			await installArchive({ archive: s.archive, blobs: s.destination }),
		).name,
	).toBe('InvalidArchive');
	const retained = expectOk(await s.destination.get(id));
	expect(await retained.text()).toBe('different');
	expect(retained.type).toBe('audio/wav');
	expect(expectErr(await s.destination.get(s.ids[1]!)).name).toBe(
		'BlobNotFound',
	);
});

test('blob write success followed by missing or corrupt read-back refuses installation', async () => {
	const s = await setup();
	for (const corruption of ['missing', 'bytes', 'format'] as const) {
		const blobs: Pick<BlobStore, 'put' | 'get'> = {
			put: s.destination.put,
			async get(id) {
				if (corruption === 'missing')
					return BlobStoreError.BlobNotFound({ id });
				return corruption === 'bytes'
					? Ok(new Blob(['wrong'], { type: 'audio/wav' }))
					: Ok(new Blob(['content 0'], { type: 'text/plain' }));
			},
		};
		expect(
			expectErr(await installArchive({ archive: s.archive, blobs })).name,
		).toBe(corruption === 'missing' ? 'BlobNotFound' : 'InvalidArchive');
	}
});

test('invalid archive is rejected before any destination write', async () => {
	let writes = 0;
	const blobs: Pick<BlobStore, 'put' | 'get'> = {
		async put() {
			writes++;
			return Ok(undefined);
		},
		async get(id) {
			return BlobStoreError.BlobNotFound({ id });
		},
	};
	expect(
		expectErr(
			await installArchive({ archive: new TextEncoder().encode('{}'), blobs }),
		).name,
	).toBe('InvalidArchive');
	expect(writes).toBe(0);
});

test('private verified objects still require exact media type even for identical bytes', async () => {
	const id = generateBlobId('bin');
	const expected = new Blob(['exact bytes'], {
		type: 'application/octet-stream',
	});
	const privateStore: Pick<BlobStore, 'put' | 'get'> = {
		async put() {
			return BlobStoreError.BlobAlreadyExists({ id });
		},
		async get() {
			return Ok(
				new Blob(['exact bytes'], {
					type: 'application/octet-stream;profile=other',
				}),
			);
		},
	};
	expect(
		expectErr(await storeVerifiedBlob(privateStore, id, expected)).name,
	).toBe('InvalidArchive');
});

test('archive installation canonicalizes producer aliases once and retries the same full keys', async () => {
	const s = await setup();
	const archive = expectOk(
		await captureArchive(
			s.capture,
			{
				async get(id) {
					const result = await s.source.get(id);
					if (result.error !== null) return result;
					return Ok(
						new Blob([result.data], { type: 'audio/x-wav;codecs=pcm' }),
					);
				},
			},
			{ appId: 'so.epicenter.notes', dataId: 'so.epicenter.notes' },
		),
	);
	for (let attempt = 0; attempt < 2; attempt++) {
		expectOk(await installArchive({ archive, blobs: s.destination }));
		for (const id of s.ids) {
			const saved = expectOk(await s.destination.get(id));
			expect(saved.type).toBe('audio/wav');
			expect(await saved.text()).toBe(
				await expectOk(await s.source.get(id)).text(),
			);
		}
	}
});

test('JSON, text, and unknown binary attachments restore canonical types and exact bytes', async () => {
	const s = await setup();
	const document = new Y.Doc();
	try {
		const attachments = [
			{
				id: generateBlobId('json'),
				input: new Blob(['{ "value": 1 }\n'], { type: 'application/json' }),
				contentType: 'application/json;charset=utf-8',
			},
			{
				id: generateBlobId('txt'),
				input: new Blob(['words\n'], { type: 'text/plain' }),
				contentType: 'text/plain;charset=utf-8',
			},
			{
				id: generateBlobId('bin'),
				input: new Blob([new Uint8Array([0, 1, 255])], {
					type: 'application/x-unrecognized',
				}),
				contentType: 'application/octet-stream',
			},
		];
		for (const { id, input } of attachments) {
			document.get('attachments').setAttr(id, id);
			expectOk(await s.source.put(id, input));
		}
		const archive = expectOk(
			await captureArchive(
				{
					generation: 1,
					head: 1,
					snapshot: { position: 1, bytes: Y.encodeStateAsUpdateV2(document) },
					tail: [],
				},
				s.source,
				{ appId: 'so.epicenter.notes', dataId: 'so.epicenter.notes' },
			),
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			expectOk(await installArchive({ archive, blobs: s.destination }));
			for (const { id, input, contentType } of attachments) {
				const actual = expectOk(await s.destination.get(id));
				expect(actual.type).toBe(contentType);
				expect(expectOk(await s.destination.stat(id)).contentType).toBe(
					contentType,
				);
				expect(new Uint8Array(await actual.arrayBuffer())).toEqual(
					new Uint8Array(await input.arrayBuffer()),
				);
			}
		}
	} finally {
		document.destroy();
	}
});
