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
import { installArchive } from './archive-storage.js';

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
	const ids = [generateBlobId(), generateBlobId()].sort();
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

test('an existing destination id with different bytes or MIME type refuses installation and remains unchanged', async () => {
	for (const blob of [
		new Blob(['different'], { type: 'audio/wav' }),
		new Blob(['content 0'], { type: 'text/plain' }),
	]) {
		const s = await setup();
		const id = s.ids[0]!;
		expectOk(await s.destination.put(id, blob));
		expect(
			expectErr(
				await installArchive({ archive: s.archive, blobs: s.destination }),
			).name,
		).toBe('InvalidArchive');
		const retained = expectOk(await s.destination.get(id));
		expect(await retained.text()).toBe(await blob.text());
		expect(retained.type).toBe(blob.type);
		expect(expectErr(await s.destination.get(s.ids[1]!)).name).toBe(
			'BlobNotFound',
		);
	}
});

test('blob write success followed by missing or corrupt read-back refuses installation', async () => {
	const s = await setup();
	for (const corrupt of [false, true]) {
		const blobs: Pick<BlobStore, 'put' | 'get'> = {
			put: s.destination.put,
			async get(id) {
				return corrupt
					? Ok(new Blob(['wrong'], { type: 'audio/wav' }))
					: BlobStoreError.BlobNotFound({ id });
			},
		};
		expect(
			expectErr(await installArchive({ archive: s.archive, blobs })).name,
		).toBe(corrupt ? 'InvalidArchive' : 'BlobNotFound');
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
