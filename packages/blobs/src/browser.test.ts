/**
 * Browser Blob Store Tests
 *
 * Verifies the IndexedDB implementation of the canonical local blob contract.
 *
 * Key behaviors:
 * - Blob bytes and metadata survive reopening the store
 * - Immutable ids refuse replacement without changing the original bytes
 * - Missing reads are typed, deletion is idempotent, and failures stay typed
 * - Metadata is stored separately so stat never fetches blob data
 */

import { expect, test } from 'bun:test';
import { indexedDB } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import { createBrowserBlobSources, createBrowserBlobs } from './browser.js';

let databaseSequence = 0;

function setup() {
	const databaseName = `epicenter-browser-blobs-test-${databaseSequence++}`;
	return {
		databaseName,
		blobs: createBrowserBlobs({ databaseName, indexedDb: indexedDB }),
	};
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function requestResult<TResult>(
	request: IDBRequest<TResult>,
): Promise<TResult> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

test('put persists bytes and metadata across store instances', async () => {
	const { databaseName, blobs } = setup();
	const id = generateBlobId();
	const input = new Blob(['browser audio'], { type: 'audio/webm' });

	expectOk(await blobs.put(id, input));
	const reopened = createBrowserBlobs({ databaseName, indexedDb: indexedDB });
	const stored = expectOk(await reopened.get(id));
	const stat = expectOk(await reopened.stat(id));

	expect(await stored.text()).toBe('browser audio');
	expect(stored.type).toBe('audio/webm');
	expect(stat).toEqual({ size: input.size, contentType: 'audio/webm' });
});

test('put refuses replacement and preserves the original blob', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['original'], { type: 'audio/wav' })));

	const error = expectErr(
		await blobs.put(id, new Blob(['replacement'], { type: 'audio/webm' })),
	);
	expect(error.name).toBe('BlobAlreadyExists');
	expect(error.id).toBe(id);

	const stored = expectOk(await blobs.get(id));
	expect(await stored.text()).toBe('original');
	expect(stored.type).toBe('audio/wav');
});

test('concurrent puts commit exactly one immutable blob', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	const results = await Promise.all([
		blobs.put(id, new Blob(['first'])),
		blobs.put(id, new Blob(['second'])),
	]);

	expect(results.filter((result) => result.error === null)).toHaveLength(1);
	expect(
		results.filter((result) => result.error?.name === 'BlobAlreadyExists'),
	).toHaveLength(1);
	const stored = expectOk(await blobs.get(id));
	expect(['first', 'second']).toContain(await stored.text());
});

test('get and stat return BlobNotFound for an unknown id', async () => {
	const { blobs } = setup();
	const id = generateBlobId();

	const getError = expectErr(await blobs.get(id));
	const statError = expectErr(await blobs.stat(id));
	expect(getError).toMatchObject({ name: 'BlobNotFound', id });
	expect(statError).toMatchObject({ name: 'BlobNotFound', id });
});

test('delete removes data and metadata and remains idempotent', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['temporary'])));

	expectOk(await blobs.delete(id));
	expectErr(await blobs.get(id));
	expectErr(await blobs.stat(id));
	expectOk(await blobs.delete(id));
});

test('stat metadata records do not contain blob bytes', async () => {
	const { databaseName, blobs } = setup();
	const id = generateBlobId();
	const blob = new Blob(['metadata only'], { type: 'audio/wav' });
	expectOk(await blobs.put(id, blob));

	const database = await openDatabase(databaseName);
	try {
		const transaction = database.transaction('blob-metadata', 'readonly');
		const metadata = (await requestResult(
			transaction.objectStore('blob-metadata').get(id),
		)) as Record<string, unknown>;
		expect(metadata).toEqual({
			id,
			size: blob.size,
			contentType: 'audio/wav',
		});
		expect(metadata).not.toHaveProperty('blob');
	} finally {
		database.close();
	}
});

test('browser persistence stores bytes as ArrayBuffer rather than Blob', async () => {
	const { databaseName, blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['webkit-safe'])));

	const database = await openDatabase(databaseName);
	try {
		const transaction = database.transaction('blob-data', 'readonly');
		const stored = (await requestResult(
			transaction.objectStore('blob-data').get(id),
		)) as Record<string, unknown>;
		expect(stored.bytes).toBeInstanceOf(ArrayBuffer);
		expect(stored).not.toHaveProperty('blob');
	} finally {
		database.close();
	}
});

test('IndexedDB failures return BlobStoreFailed with the original cause', async () => {
	const cause = new Error('storage unavailable');
	const failingIndexedDb = {
		open() {
			throw cause;
		},
	} as unknown as IDBFactory;
	const blobs = createBrowserBlobs({ indexedDb: failingIndexedDb });
	const id = generateBlobId();

	const error = expectErr(await blobs.get(id));
	expect(error).toMatchObject({ name: 'BlobStoreFailed', id, cause });
});

test('browser source acquisitions own independent disposal that revokes exactly once', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['play me'])));
	const revoked: string[] = [];
	let sequence = 0;
	const sources = createBrowserBlobSources(blobs, {
		createObjectUrl: () => `blob:test-${sequence++}`,
		revokeObjectUrl: (url) => revoked.push(url),
	});

	const first = expectOk(await sources.open(id));
	const second = expectOk(await sources.open(id));
	expect(first.url).toBe('blob:test-0');
	expect(second.url).toBe('blob:test-1');

	first[Symbol.dispose]();
	first[Symbol.dispose]();
	second[Symbol.dispose]();
	expect(revoked).toEqual(['blob:test-0', 'blob:test-1']);
});

test('browser sources revoke at the end of a using scope', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['bounded'])));
	const revoked: string[] = [];
	const sources = createBrowserBlobSources(blobs, {
		createObjectUrl: () => 'blob:test-scoped',
		revokeObjectUrl: (url) => revoked.push(url),
	});

	{
		using source = expectOk(await sources.open(id));
		expect(source.url).toBe('blob:test-scoped');
		expect(revoked).toEqual([]);
	}
	expect(revoked).toEqual(['blob:test-scoped']);
});

test('browser source acquisition forwards missing local bytes', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	const sources = createBrowserBlobSources(blobs);

	const error = expectErr(await sources.open(id));
	expect(error).toMatchObject({ name: 'BlobNotFound', id });
});

test('browser source creation failures remain typed after storage succeeds', async () => {
	const { blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['stored'])));
	const cause = new Error('object URLs unavailable');
	const sources = createBrowserBlobSources(blobs, {
		createObjectUrl() {
			throw cause;
		},
	});

	const error = expectErr(await sources.open(id));
	expect(error).toMatchObject({ name: 'BlobSourceFailed', id, cause });
});

test('blocked database opens reject and close a later connection', async () => {
	let isClosed = false;
	const request = {} as IDBOpenDBRequest;
	const database = {
		close() {
			isClosed = true;
		},
	} as IDBDatabase;
	Object.defineProperty(request, 'result', { value: database });
	const blockedIndexedDb = {
		open() {
			queueMicrotask(() => {
				request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent);
				request.onsuccess?.(new Event('success'));
			});
			return request;
		},
	} as unknown as IDBFactory;
	const id = generateBlobId();
	const blobs = createBrowserBlobs({ indexedDb: blockedIndexedDb });

	const error = expectErr(await blobs.get(id));
	expect(error).toMatchObject({ name: 'BlobStoreFailed', id });
	if (error.name !== 'BlobStoreFailed')
		throw new Error('expected store failure');
	expect(error.cause).toEqual(
		new Error('Blob IndexedDB open is blocked by another connection'),
	);
	expect(isClosed).toBeTrue();
});
