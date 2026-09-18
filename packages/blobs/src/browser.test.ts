/**
 * Flat browser blob store tests.
 *
 * Verifies atomic immutable records, index-only metadata reads, app scoping,
 * and refusal of unsupported existing schemas.
 * Blocked upgrades and failed writes must preserve the prior database.
 */

import { expect, spyOn, test } from 'bun:test';
import {
	IDBFactory,
	IDBIndex,
	IDBKeyRange,
	IDBObjectStore,
} from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { BlobId } from './blob-id.js';
import { generateBlobId } from './blob-id.js';
import {
	browserBlobStoreName,
	createBrowserBlobSources,
	createBrowserBlobStore,
} from './browser.js';

function setup() {
	const scope = {
		appId: 'so.epicenter.flat.test',
		idb: { factory: new IDBFactory(), keyRange: IDBKeyRange },
	};
	return {
		scope,
		name: browserBlobStoreName(scope),
		blobs: createBrowserBlobStore(scope),
	};
}

function open(indexedDb: IDBFactory, name: string, version?: number) {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDb.open(name, version);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function requestResult<TValue>(request: IDBRequest<TValue>) {
	return new Promise<TValue>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function seedLegacy(indexedDb: IDBFactory, name: string) {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDb.open(name, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('blob-data', { keyPath: 'id' });
			request.result.createObjectStore('blob-metadata', { keyPath: 'id' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const transaction = database.transaction(
		['blob-data', 'blob-metadata'],
		'readwrite',
	);
	const done = new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
	});
	transaction.objectStore('blob-data').add({
		id: 'blob_abcdefghijklmnopqrstu',
		bytes: new TextEncoder().encode('legacy audio').buffer,
	});
	transaction.objectStore('blob-metadata').add({
		id: 'blob_abcdefghijklmnopqrstu',
		size: 12,
		contentType: 'audio/webm;codecs=opus',
	});
	await done;
	return database;
}

// ============================================================================
// Records and body-free metadata
// ============================================================================

test('fresh records contain only id, ArrayBuffer bytes, and derived size and survive reopening', async () => {
	const { scope, name, blobs } = setup();
	const id = generateBlobId('webm');
	expectOk(
		await blobs.put(
			id,
			new Blob(['audio'], { type: 'audio/webm;codecs=opus' }),
		),
	);
	const reopened = createBrowserBlobStore(scope);
	const audio = expectOk(await reopened.get(id));
	expect(await audio.text()).toBe('audio');
	expect(audio.type).toBe('video/webm');
	expect(expectOk(await reopened.stat(id))).toEqual({
		size: 5,
		contentType: 'video/webm',
	});

	const database = await open(scope.idb.factory, name);
	expect(database.version).toBe(2);
	expect(Array.from(database.objectStoreNames)).toEqual(['blobs']);
	const store = database.transaction('blobs').objectStore('blobs');
	expect(store.keyPath).toBe('id');
	expect(store.index('by-id-size').keyPath).toEqual(['id', 'size']);
	const record = await requestResult(store.get(id));
	expect(Object.keys(record).sort()).toEqual(['bytes', 'id', 'size']);
	expect(record.bytes).toBeInstanceOf(ArrayBuffer);
	expect(record.size).toBe(record.bytes.byteLength);
	database.close();
});

test('concurrent duplicate publication commits one record and never replaces its bytes', async () => {
	const { scope, blobs } = setup();
	const other = createBrowserBlobStore(scope);
	const id = generateBlobId('wav');
	const results = await Promise.all(
		[blobs, other].map((store, index) =>
			store.put(id, new Blob([String(index)], { type: 'audio/wav' })),
		),
	);
	expect(results.filter((result) => result.error === null)).toHaveLength(1);
	expect(
		results.filter((result) => result.error?.name === 'BlobAlreadyExists'),
	).toHaveLength(1);
	const saved = expectOk(await blobs.get(id));
	expect(await saved.text()).toBe(
		String(results.findIndex((result) => result.error === null)),
	);
	expect(await expectOk(await other.get(id)).text()).toBe(await saved.text());
	expect(expectOk(await blobs.stat(id)).size).toBe(saved.size);
});

test('list and stat use only index key cursors, including zero-byte records and exclusive pages', async () => {
	const { blobs } = setup();
	const ids = [
		generateBlobId('wav'),
		generateBlobId('wav'),
		generateBlobId('wav'),
	].sort();
	for (const [index, id] of ids.entries())
		expectOk(
			await blobs.put(id, new Blob(['x'.repeat(index)], { type: 'audio/wav' })),
		);
	const forbidden = [
		spyOn(IDBObjectStore.prototype, 'get'),
		spyOn(IDBObjectStore.prototype, 'getAll'),
		spyOn(IDBObjectStore.prototype, 'openCursor'),
		spyOn(IDBIndex.prototype, 'get'),
		spyOn(IDBIndex.prototype, 'getAll'),
		spyOn(IDBIndex.prototype, 'openCursor'),
	];
	for (const method of forbidden)
		method.mockImplementation(() => {
			throw new Error('Body read forbidden.');
		});
	try {
		expect(expectOk(await blobs.stat(ids[0]!))).toEqual({
			size: 0,
			contentType: 'audio/wav',
		});
		expect(expectOk(await blobs.stat(ids[2]!)).size).toBe(2);
		const first = expectOk(await blobs.list({ limit: 1 }));
		expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 1));
		expect(first.nextCursor).toBe(ids[0]);
		const second = expectOk(
			await blobs.list({ cursor: first.nextCursor, limit: 1 }),
		);
		expect(second.items.map((item) => item.id)).toEqual(ids.slice(1, 2));
		const last = expectOk(
			await blobs.list({ cursor: second.nextCursor, limit: 1 }),
		);
		expect(last.items.map((item) => item.id)).toEqual(ids.slice(2));
		expect(last.nextCursor).toBeUndefined();
		expect(expectOk(await blobs.list({ cursor: ids[2] })).items).toEqual([]);
	} finally {
		for (const method of forbidden) method.mockRestore();
	}
});

test('a deleted cursor still resumes exclusively at its next key', async () => {
	const { blobs } = setup();
	const ids = [
		generateBlobId('bin'),
		generateBlobId('bin'),
		generateBlobId('bin'),
	].sort();
	for (const id of ids) expectOk(await blobs.put(id, new Blob()));
	expectOk(await blobs.delete(ids[1]!));
	expect(
		expectOk(await blobs.list({ cursor: ids[1] })).items.map((item) => item.id),
	).toEqual([ids[2]!]);
	expect(expectErr(await blobs.stat(ids[1]!)).name).toBe('BlobNotFound');
	expect(expectErr(await blobs.get(ids[1]!)).name).toBe('BlobNotFound');
	expectOk(await blobs.delete(ids[1]!));
});

test('invalid keys and incompatible declared types never publish bytes', async () => {
	const { blobs } = setup();
	const id = generateBlobId('wav');
	expect(
		expectErr(await blobs.put(id, new Blob(['video'], { type: 'video/webm' })))
			.name,
	).toBe('BlobStoreFailed');
	const invalid = 'blob_abcdefghijklmnopqrstu' as BlobId;
	expect(expectErr(await blobs.put(invalid, new Blob())).name).toBe(
		'BlobStoreFailed',
	);
	expect(expectErr(await blobs.get(invalid)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.stat(invalid)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.delete(invalid)).name).toBe('BlobStoreFailed');
	expect(expectErr(await blobs.list({ cursor: invalid })).name).toBe(
		'BlobStoreFailed',
	);
	expect(expectOk(await blobs.list()).items).toEqual([]);
});

test('each app has independent keys while browser sources own disposable URLs', async () => {
	const { scope, blobs } = setup();
	const other = createBrowserBlobStore({
		...scope,
		appId: 'so.epicenter.other',
	});
	const id = generateBlobId('wav');
	expectOk(await blobs.put(id, new Blob(['saved'], { type: 'audio/wav' })));
	expect(expectErr(await other.get(id)).name).toBe('BlobNotFound');
	const revoked: string[] = [];
	const sources = createBrowserBlobSources(blobs, {
		createObjectUrl: (blob) => `source:${blob.size}:${blob.type}`,
		revokeObjectUrl: (url) => revoked.push(url),
	});
	const source = expectOk(await sources.open(id));
	expect(source.url).toBe('source:5:audio/wav');
	source[Symbol.dispose]();
	source[Symbol.dispose]();
	expect(revoked).toEqual([source.url]);
	expect(await expectOk(await blobs.get(id)).text()).toBe('saved');
});

// ============================================================================
// Upgrades and failed transactions
// ============================================================================

test('an unsupported existing schema fails without changing the database', async () => {
	const { scope, name, blobs } = setup();
	(await seedLegacy(scope.idb.factory, name)).close();
	expect(expectErr(await blobs.list()).name).toBe('BlobStoreFailed');
	const database = await open(scope.idb.factory, name);
	expect(database.version).toBe(1);
	expect(Array.from(database.objectStoreNames)).toEqual([
		'blob-data',
		'blob-metadata',
	]);
	database.close();
});

test('blocked upgrade fails without a deferred upgrade without changing a blocked existing schema', async () => {
	const { scope, name, blobs } = setup();
	const legacy = await seedLegacy(scope.idb.factory, name);
	const id = generateBlobId('wav');
	expect(
		expectErr(await blobs.put(id, new Blob([], { type: 'audio/wav' }))).name,
	).toBe('BlobStoreFailed');
	legacy.close();
	// This open queues behind the abandoned upgrade, which must abort itself.
	const untouched = await open(scope.idb.factory, name);
	expect(untouched.version).toBe(1);
	expect(Array.from(untouched.objectStoreNames)).toEqual([
		'blob-data',
		'blob-metadata',
	]);
	untouched.close();
	expect(
		expectErr(await blobs.put(id, new Blob([], { type: 'audio/wav' }))).name,
	).toBe('BlobStoreFailed');
});

test('aborted publication rolls back both bytes and its size index', async () => {
	const { blobs } = setup();
	expectOk(await blobs.list());
	const original = IDBObjectStore.prototype.add;
	const aborted = spyOn(IDBObjectStore.prototype, 'add').mockImplementation(
		function (this: IDBObjectStore, value, key) {
			const request = original.call(this, value, key);
			this.transaction.abort();
			return request;
		},
	);
	const id = generateBlobId('wav');
	try {
		expect(
			expectErr(
				await blobs.put(id, new Blob(['failed'], { type: 'audio/wav' })),
			).name,
		).toBe('BlobStoreFailed');
	} finally {
		aborted.mockRestore();
	}
	expect(expectErr(await blobs.get(id)).name).toBe('BlobNotFound');
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobNotFound');
	expect(expectOk(await blobs.list()).items).toEqual([]);
	expectOk(await blobs.put(id, new Blob(['retry'], { type: 'audio/wav' })));
});

test('synchronous transaction failure closes its connection and returns a typed failure', async () => {
	const { blobs } = setup();
	const failure = spyOn(IDBObjectStore.prototype, 'add').mockImplementation(
		() => {
			throw new DOMException('Full', 'QuotaExceededError');
		},
	);
	try {
		expect(
			expectErr(await blobs.put(generateBlobId('bin'), new Blob())).name,
		).toBe('BlobStoreFailed');
	} finally {
		failure.mockRestore();
	}
	expect(expectOk(await blobs.list()).items).toEqual([]);
});

test('a byte conversion failure leaves the database unopened and remains retryable', async () => {
	const { scope, blobs } = setup();
	const id = generateBlobId('bin');
	const bytes = new Blob(['original']);
	const failed = spyOn(bytes, 'arrayBuffer').mockRejectedValue(
		new Error('Buffer unavailable.'),
	);
	expect(expectErr(await blobs.put(id, bytes)).name).toBe('BlobStoreFailed');
	expect(await scope.idb.factory.databases()).toEqual([]);
	failed.mockRestore();
	expectOk(await blobs.put(id, bytes));
	expect(await expectOk(await blobs.get(id)).text()).toBe('original');
});

test('injected storage works with absent or unrelated global IndexedDB constructors', async () => {
	// A fresh process prevents another suite's fake-indexeddb/auto from supplying
	// constructors and hiding an accidental ambient dependency.
	const process = Bun.spawn(
		[
			Bun.argv[0]!,
			'--eval',
			`
		import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
		import { createBrowserBlobStore } from './src/browser.ts';
		import { generateBlobId } from './src/blob-id.ts';
		import { expectOk, expectErr } from 'wellcrafted/testing';
		for (const foreign of [false, true]) {
			const names = ['indexedDB', 'IDBKeyRange', 'IDBDatabase', 'IDBRequest', 'IDBTransaction', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'DOMException'];
			for (const name of names) {
				if (name === 'DOMException') continue;
				Reflect.deleteProperty(globalThis, name);
				if (foreign) Object.defineProperty(globalThis, name, {
					configurable: true,
					get() { throw new Error('Ambient ' + name + ' was read'); },
				});
			}
			const before = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
			const idb = { factory: new IDBFactory(), keyRange: IDBKeyRange };
			const store = createBrowserBlobStore({ appId: 'test.isolation', idb });
			const keys = [generateBlobId('bin'), generateBlobId('bin')].sort();
			for (const key of keys) expectOk(await store.put(key, new Blob(['saved'])));
			if (expectOk(await store.stat(keys[0])).size !== 5) throw new Error('Wrong size');
			const page = expectOk(await store.list({ limit: 1 }));
			const next = expectOk(await store.list({ cursor: page.nextCursor }));
			if (next.items[0]?.id !== keys[1]) throw new Error('Wrong compound range');
			if (expectErr(await store.put(keys[0], new Blob())).name !== 'BlobAlreadyExists') throw new Error('Lost collision');
			for (const [index, name] of names.entries()) {
				const after = Object.getOwnPropertyDescriptor(globalThis, name);
				if (after?.get !== before[index]?.get || after?.value !== before[index]?.value) throw new Error('Changed global ' + name);
			}
		}
		`,
		],
		{
			cwd: new URL('..', import.meta.url).pathname,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const stderr = await new Response(process.stderr).text();
	expect({ exitCode: await process.exited, stderr }).toEqual({
		exitCode: 0,
		stderr: '',
	});
});

test('constraint failures do not depend on the DOMException constructor identity', async () => {
	const { blobs } = setup();
	const id = generateBlobId('bin');
	expectOk(await blobs.put(id, new Blob(['original'])));
	const constraint = spyOn(IDBObjectStore.prototype, 'add').mockImplementation(
		() => {
			throw { name: 'ConstraintError' };
		},
	);
	try {
		expect(expectErr(await blobs.put(id, new Blob(['replacement']))).name).toBe(
			'BlobAlreadyExists',
		);
	} finally {
		constraint.mockRestore();
	}
	expect(await expectOk(await blobs.get(id)).text()).toBe('original');
});
