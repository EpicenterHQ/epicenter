/**
 * Browser Blob Store Tests
 *
 * Verifies the IndexedDB implementation of the canonical local blob contract.
 *
 * Key behaviors:
 * - Blob bytes and metadata survive reopening the store
 * - Immutable ids refuse replacement without changing the original bytes
 * - Copies retain source bytes and create independently deletable identities
 * - Missing reads are typed, deletion is idempotent, and failures stay typed
 * - Metadata is stored separately so stat never fetches blob data
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { indexedDB } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import type { BlobStoreError } from './blob-store.js';
import {
	type BlobLockManager,
	browserBlobStoreName,
	createBrowserBlobSources,
	createBrowserBlobStore,
	eraseBlobStore,
} from './browser.js';

const testLocks = fakeLocks().locks;

const APP_ID = 'so.epicenter.test';

let principalSequence = 0;

/** One fresh account per test, so no test reads another's database. */
function setup() {
	const principalId = asPrincipalId(`principal-${principalSequence++}`);
	const scope = { appId: APP_ID, principalId, authorityId: 'test-authority' };
	return {
		scope,
		databaseName: browserBlobStoreName(scope),
		blobs: createBrowserBlobStore({
			...scope,
			indexedDb: indexedDB,
			locks: testLocks,
		}),
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

test('the name is the account prefix of the replica address, ending in blobs', () => {
	// The one grammar, pinned as a literal (ADR-0349). `@epicenter/data` spells
	// the replica half, `epicenter/v5/<app-id>/<principal-id>/<data-id>/<n>`,
	// and generation enumeration matches `<data-id>/` and a number after it, so
	// a sibling named `blobs` is invisible to it. A data id must contain a dot,
	// so no data id can be named `blobs` either.
	expect(
		browserBlobStoreName({
			appId: 'so.epicenter.whispering',
			principalId: 'local',
		}),
	).toBe('epicenter/so.epicenter.whispering/local/blobs');
});

test('a segment that could be read as a path is refused at construction', () => {
	for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
		expect(() =>
			browserBlobStoreName({
				appId: APP_ID,
				principalId: asPrincipalId(bad),
				authorityId: 'authority',
			}),
		).toThrow();
		expect(() =>
			browserBlobStoreName({
				appId: bad,
				principalId: asPrincipalId('principal-1'),
				authorityId: 'authority',
			}),
		).toThrow();
	}
	// Refused, never canonicalized: whitespace and case are the authority's.
	expect(browserBlobStoreName({ appId: APP_ID, principalId: 'local' })).toBe(
		`epicenter/${APP_ID}/local/blobs`,
	);
});

test('two accounts on one browser hold two stores and neither reads the other', async () => {
	const first = setup();
	const second = setup();
	const id = generateBlobId();
	expectOk(
		await first.blobs.put(id, new Blob(['mine'], { type: 'audio/wav' })),
	);

	expect(expectErr(await second.blobs.stat(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
	// The same id is free in the other account's store: the stores share
	// nothing, not even the immutable-id refusal.
	expectOk(await second.blobs.put(id, new Blob(['theirs'])));
	expect(await expectOk(await first.blobs.get(id)).text()).toBe('mine');
	expect(await expectOk(await second.blobs.get(id)).text()).toBe('theirs');
});

test('the local partition is separate from every account partition', async () => {
	const localScope = { appId: APP_ID, principalId: 'local' as const };
	const accountScope = {
		appId: APP_ID,
		principalId: asPrincipalId('local-account'),
		authorityId: 'test-authority',
	};
	const local = createBrowserBlobStore({
		...localScope,
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const account = createBrowserBlobStore({
		...accountScope,
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const id = generateBlobId();

	expectOk(await local.put(id, new Blob(['local'])));
	expect(expectErr(await account.get(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
	expect(await expectOk(await local.get(id)).text()).toBe('local');
});

test('authority identity is part of the account blob partition', async () => {
	const principalId = asPrincipalId('same-principal');
	const first = createBrowserBlobStore({
		appId: APP_ID,
		principalId,
		authorityId: 'authority-one',
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const second = createBrowserBlobStore({
		appId: APP_ID,
		principalId,
		authorityId: 'authority-two',
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const id = generateBlobId();

	expectOk(await first.put(id, new Blob(['authority one'])));
	expect(expectErr(await second.get(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
});

test('a principal minted as local cannot collide with the local partition', async () => {
	const local = createBrowserBlobStore({
		appId: APP_ID,
		principalId: 'local',
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const account = createBrowserBlobStore({
		appId: APP_ID,
		principalId: asPrincipalId('local'),
		authorityId: 'authority-one',
		indexedDb: indexedDB,
		locks: testLocks,
	});
	const id = generateBlobId();

	expectOk(await local.put(id, new Blob(['local partition'])));
	expect(expectErr(await account.get(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
});

test('put persists bytes and metadata across store instances', async () => {
	const { scope, blobs } = setup();
	const id = generateBlobId();
	const input = new Blob(['browser audio'], { type: 'audio/webm' });

	expectOk(await blobs.put(id, input));
	const reopened = createBrowserBlobStore({
		...scope,
		indexedDb: indexedDB,
		locks: testLocks,
	});
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

test('copy persists a fresh identity whose deletion leaves the source intact', async () => {
	const { blobs, scope } = setup();
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	expectOk(
		await blobs.put(sourceId, new Blob(['source'], { type: 'audio/wav' })),
	);
	expectOk(await blobs.copy(sourceId, destinationId));
	const reopened = createBrowserBlobStore({
		...scope,
		indexedDb: indexedDB,
		locks: testLocks,
	});
	expect(await expectOk(await reopened.get(destinationId)).text()).toBe(
		'source',
	);
	expect(expectOk(await reopened.stat(destinationId))).toEqual({
		size: 6,
		contentType: 'audio/wav',
	});
	expectOk(await reopened.delete(destinationId));
	expect(await expectOk(await blobs.get(sourceId)).text()).toBe('source');
	expectOk(await blobs.copy(sourceId, destinationId));
	expectOk(await blobs.delete(sourceId));
	expect(await expectOk(await reopened.get(destinationId)).text()).toBe(
		'source',
	);
});

test('copy refuses existing and identical destinations without changing either object', async () => {
	const { blobs } = setup();
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	expectOk(await blobs.put(sourceId, new Blob(['source'])));
	expectOk(await blobs.put(destinationId, new Blob(['destination'])));
	for (const id of [destinationId, sourceId]) {
		expect(expectErr(await blobs.copy(sourceId, id))).toMatchObject({
			name: 'BlobAlreadyExists',
			id,
		});
	}
	expect(await expectOk(await blobs.get(sourceId)).text()).toBe('source');
	expect(await expectOk(await blobs.get(destinationId)).text()).toBe(
		'destination',
	);
});

test('copy cannot find a source in another captured store and creates no destination', async () => {
	const first = setup();
	const second = setup();
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	expectOk(await first.blobs.put(sourceId, new Blob(['first store'])));
	expect(
		expectErr(await second.blobs.copy(sourceId, destinationId)),
	).toMatchObject({ name: 'BlobNotFound', id: sourceId });
	expect(expectErr(await second.blobs.get(destinationId)).name).toBe(
		'BlobNotFound',
	);
	expect(await expectOk(await first.blobs.get(sourceId)).text()).toBe(
		'first store',
	);
});

test('concurrent copies publish only one destination and preserve both sources', async () => {
	const { blobs } = setup();
	const firstId = generateBlobId();
	const secondId = generateBlobId();
	const destinationId = generateBlobId();
	expectOk(await blobs.put(firstId, new Blob(['first'])));
	expectOk(await blobs.put(secondId, new Blob(['second'])));
	const results = await Promise.all([
		blobs.copy(firstId, destinationId),
		blobs.copy(secondId, destinationId),
	]);
	expect(results.filter((result) => result.error === null)).toHaveLength(1);
	expect(
		results.filter((result) => result.error?.name === 'BlobAlreadyExists'),
	).toHaveLength(1);
	expect(['first', 'second']).toContain(
		await expectOk(await blobs.get(destinationId)).text(),
	);
	expect(await expectOk(await blobs.get(firstId)).text()).toBe('first');
	expect(await expectOk(await blobs.get(secondId)).text()).toBe('second');
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
	const blobs = createBrowserBlobStore({
		...setup().scope,
		indexedDb: failingIndexedDb,
		locks: testLocks,
	});
	const id = generateBlobId();

	const error = expectErr(await blobs.get(id));
	expect(error).toMatchObject({ name: 'BlobStoreFailed', id, cause });
	expect(expectErr(await blobs.copy(id, generateBlobId()))).toMatchObject({
		name: 'BlobStoreFailed',
		id,
		cause,
	});
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
	const blobs = createBrowserBlobStore({
		...setup().scope,
		indexedDb: blockedIndexedDb,
		locks: testLocks,
	});

	const error = expectErr(await blobs.get(id));
	expect(error).toMatchObject({ name: 'BlobStoreFailed', id });
	if (error.name !== 'BlobStoreFailed')
		throw new Error('expected store failure');
	expect(error.cause).toEqual(
		new Error('Blob IndexedDB open is blocked by another connection'),
	);
	expect(isClosed).toBeTrue();
});

/**
 * An in-test Web Locks manager with shared readers and exclusive erasure.
 * It refuses conflicts with `ifAvailable`. Injected rather than
 * installed on `navigator`, so a test can hold a name and watch the refusal.
 */
function fakeLocks() {
	const held = new Set<string>();
	const readers = new Map<string, number>();
	const locks: BlobLockManager = {
		async request(name, { mode }, callback) {
			if (held.has(name) || (mode === 'exclusive' && readers.has(name)))
				return callback(null);
			if (mode === 'exclusive') held.add(name);
			else readers.set(name, (readers.get(name) ?? 0) + 1);
			try {
				return await callback({ name });
			} finally {
				if (mode === 'exclusive') held.delete(name);
				else {
					const count = (readers.get(name) ?? 1) - 1;
					if (count === 0) readers.delete(name);
					else readers.set(name, count);
				}
			}
		},
	};
	return { held, locks };
}

async function databaseNames(): Promise<string[]> {
	return (await indexedDB.databases())
		.map(({ name }) => name)
		.filter((name): name is string => name !== undefined);
}

test('erase refuses a put before its bytes finish converting, while another shared read succeeds', async () => {
	const { scope } = setup();
	const { locks } = fakeLocks();
	const store = createBrowserBlobStore({
		...scope,
		indexedDb: indexedDB,
		locks,
	});
	const bytes = Promise.withResolvers<ArrayBuffer>();
	const started = Promise.withResolvers<void>();
	const blob = new Blob(['pending']);
	blob.arrayBuffer = () => {
		started.resolve();
		return bytes.promise;
	};
	const id = generateBlobId();
	const put = store.put(id, blob);
	await started.promise;
	expect(expectErr(await store.stat(id)).name).toBe('BlobNotFound');
	expect(
		expectErr(await eraseBlobStore({ ...scope, indexedDb: indexedDB, locks }))
			.name,
	).toBe('BlobStoreHeld');
	bytes.resolve(new TextEncoder().encode('pending').buffer);
	expectOk(await put);
	expectOk(await eraseBlobStore({ ...scope, indexedDb: indexedDB, locks }));
	expect(await databaseNames()).not.toContain(browserBlobStoreName(scope));
});

test('an exclusive erase excludes every ordinary verb without opening a database', async () => {
	const { scope, databaseName } = setup();
	const { held, locks } = fakeLocks();
	const store = createBrowserBlobStore({
		...scope,
		indexedDb: indexedDB,
		locks,
	});
	held.add(`epicenter.blobs:${databaseName}`);
	const id = generateBlobId();
	for (const result of await Promise.all([
		store.put(id, new Blob(['blocked'])),
		store.get(id),
		store.copy(id, generateBlobId()),
		store.stat(id),
		store.delete(id),
	])) {
		expect(expectErr<BlobStoreError>(result)).toMatchObject({
			name: 'BlobStoreFailed',
			cause: { name: 'BlobStoreHeld' },
		});
	}
	for (const result of await store.statMany([id])) {
		expect(expectErr(result)).toMatchObject({
			name: 'BlobStoreFailed',
			cause: { name: 'BlobStoreHeld' },
		});
	}
	expect(await databaseNames()).not.toContain(databaseName);
});

test('batch stat reads only metadata in one transaction and preserves input order', async () => {
	const { scope, blobs } = setup();
	const first = generateBlobId();
	const absent = generateBlobId();
	const last = generateBlobId();
	expectOk(await blobs.put(first, new Blob(['one'])));
	expectOk(await blobs.put(last, new Blob(['second'])));
	const transactions: (string | string[])[] = [];
	const monitored = Object.create(indexedDB) as IDBFactory;
	monitored.open = (name, version) => {
		const request = indexedDB.open(name, version);
		request.addEventListener('success', () => {
			const database = request.result;
			const transaction = database.transaction.bind(database);
			database.transaction = (stores, mode, options) => {
				transactions.push(stores);
				return transaction(stores, mode, options);
			};
		});
		return request;
	};
	const store = createBrowserBlobStore({
		...scope,
		indexedDb: monitored,
		locks: testLocks,
	});
	const result = await store.statMany([last, absent, first, last]);
	expect(result).toHaveLength(4);
	expect(expectOk(result[0]!)).toMatchObject({ size: 6 });
	expect(expectErr(result[1]!)).toMatchObject({
		name: 'BlobNotFound',
		id: absent,
	});
	expect(expectOk(result[2]!)).toMatchObject({ size: 3 });
	expect(expectOk(result[3]!)).toMatchObject({ size: 6 });
	expect(transactions).toEqual(['blob-metadata']);
	expect(await store.statMany([])).toEqual([]);
	expect(transactions).toEqual(['blob-metadata']);
});

test('an aborted metadata batch returns a storage failure for every requested id', async () => {
	const { scope, blobs } = setup();
	const id = generateBlobId();
	expectOk(await blobs.put(id, new Blob(['preserved'])));
	const monitored = Object.create(indexedDB) as IDBFactory;
	monitored.open = (name, version) => {
		const request = indexedDB.open(name, version);
		request.addEventListener('success', () => {
			const database = request.result;
			const transaction = database.transaction.bind(database);
			database.transaction = (stores, mode, options) => {
				const result = transaction(stores, mode, options);
				queueMicrotask(() => result.abort());
				return result;
			};
		});
		return request;
	};
	const store = createBrowserBlobStore({
		...scope,
		indexedDb: monitored,
		locks: testLocks,
	});
	const ids = [id, generateBlobId()];
	const results = await store.statMany(ids);
	expect(results).toHaveLength(2);
	expect(results.map((result) => expectErr(result).name)).toEqual([
		'BlobStoreFailed',
		'BlobStoreFailed',
	]);
	expect(await expectOk(await blobs.get(id)).text()).toBe('preserved');
});

test('a blocked delete reports failure but retains exclusion until the request actually settles', async () => {
	const { scope } = setup();
	const { locks } = fakeLocks();
	const request = {} as IDBOpenDBRequest;
	const indexedDb = {
		deleteDatabase() {
			queueMicrotask(() =>
				request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent),
			);
			return request;
		},
	} as unknown as IDBFactory;
	const result = await eraseBlobStore({ ...scope, indexedDb, locks });
	expect(expectErr(result).name).toBe('BlobEraseFailed');
	const store = createBrowserBlobStore({
		...scope,
		indexedDb: indexedDB,
		locks,
	});
	expect(expectErr(await store.get(generateBlobId()))).toMatchObject({
		cause: { name: 'BlobStoreHeld' },
	});
	request.onsuccess?.(new Event('success'));
	// Let the request and lock-release promise settle.
	await Bun.sleep(0);
	expect(expectErr(await store.get(generateBlobId())).name).toBe(
		'BlobNotFound',
	);
}, 15_000);
