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
import { asPrincipalId } from '@epicenter/principal';
import { indexedDB } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import type { BlobStoreError } from './blob-store.js';
import {
	type BlobLockManager,
	browserBlobStoreName,
	claimUnscopedBrowserBlobs,
	createBrowserBlobSources,
	createBrowserBlobStore,
	deleteUnscopedBrowserBlobs,
	eraseBlobStore,
	unscopedBrowserBlobs,
} from './browser.js';

const testLocks = fakeLocks().locks;

const APP_ID = 'so.epicenter.test';

let principalSequence = 0;

/** One fresh account per test, so no test reads another's database. */
function setup() {
	const principalId = asPrincipalId(`principal-${principalSequence++}`);
	const scope = { appId: APP_ID, principalId };
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
			principalId: asPrincipalId('principal-1'),
		}),
	).toBe('epicenter/v5/so.epicenter.whispering/principal-1/blobs');
});

test('a segment that could be read as a path is refused at construction', () => {
	for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
		expect(() =>
			browserBlobStoreName({ appId: APP_ID, principalId: asPrincipalId(bad) }),
		).toThrow();
		expect(() =>
			browserBlobStoreName({
				appId: bad,
				principalId: asPrincipalId('principal-1'),
			}),
		).toThrow();
	}
	// Refused, never canonicalized: whitespace and case are the authority's.
	expect(
		browserBlobStoreName({ appId: APP_ID, principalId: asPrincipalId(' P ') }),
	).toBe(`epicenter/v5/${APP_ID}/ P /blobs`);
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
	});
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

/** Write one blob the way the pre-scoping build did: straight into `epicenter-blobs`. */
async function seedUnscoped(id: string, text: string): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open('epicenter-blobs', 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore('blob-data', { keyPath: 'id' });
			request.result.createObjectStore('blob-metadata', { keyPath: 'id' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	try {
		const transaction = database.transaction(
			['blob-data', 'blob-metadata'],
			'readwrite',
		);
		const bytes = new TextEncoder().encode(text).buffer;
		transaction.objectStore('blob-data').add({ id, bytes });
		transaction
			.objectStore('blob-metadata')
			.add({ id, size: bytes.byteLength, contentType: 'audio/wav' });
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	} finally {
		database.close();
	}
}

test("erase deletes one account's database and leaves the other account's", async () => {
	const first = setup();
	const second = setup();
	const id = generateBlobId();
	expectOk(await first.blobs.put(id, new Blob(['mine'])));
	expectOk(await second.blobs.put(id, new Blob(['theirs'])));

	expectOk(
		await eraseBlobStore({
			...first.scope,
			indexedDb: indexedDB,
			locks: fakeLocks().locks,
		}),
	);

	const names = await databaseNames();
	expect(names).not.toContain(first.databaseName);
	expect(names).toContain(second.databaseName);
	expect(await expectOk(await second.blobs.get(id)).text()).toBe('theirs');
	// Nothing recreated the database by asking about it.
	expect(expectErr(await first.blobs.stat(id)).name).toBe('BlobNotFound');
	expect(await databaseNames()).toContain(first.databaseName);
});

test('erase refuses rather than queues while a claim holds the store, and refuses a runtime with no locks', async () => {
	const { scope, databaseName } = setup();
	const { held, locks } = fakeLocks();
	held.add(`epicenter.blobs:${databaseName}`);

	expect(
		expectErr(await eraseBlobStore({ ...scope, indexedDb: indexedDB, locks })),
	).toMatchObject({ name: 'BlobStoreHeld', database: databaseName });
	expect(
		expectErr(
			await eraseBlobStore({
				...scope,
				indexedDb: indexedDB,
				locks: undefined,
			}),
		).name,
	).toBe('LocksUnsupported');
});

test('a claim against a browser that never had the unscoped store creates nothing', async () => {
	const { scope } = setup();
	await deleteUnscopedBrowserBlobs({
		indexedDb: indexedDB,
		locks: fakeLocks().locks,
	});
	const ids = [generateBlobId(), generateBlobId()];

	const claim = expectOk(
		await claimUnscopedBrowserBlobs({
			...scope,
			ids,
			indexedDb: indexedDB,
			locks: fakeLocks().locks,
		}),
	);

	expect(claim).toEqual({
		claimed: 0,
		absent: 2,
		skipped: 0,
		unclaimed: { count: 0, bytes: 0 },
	});
	expect(await databaseNames()).not.toContain('epicenter-blobs');
	expect(
		expectOk(
			await unscopedBrowserBlobs({ indexedDb: indexedDB, locks: testLocks }),
		),
	).toEqual({ count: 0, bytes: 0 });
});

test('a claim moves the cited bytes, leaves the uncited ones counted, and is idempotent', async () => {
	const { scope, blobs } = setup();
	const { locks } = fakeLocks();
	const cited = generateBlobId();
	const alreadyScoped = generateBlobId();
	const somebodyElses = generateBlobId();
	const neverHere = generateBlobId();
	await seedUnscoped(cited, 'cited bytes');
	await seedUnscoped(alreadyScoped, 'older copy');
	await seedUnscoped(somebodyElses, 'not yours');
	// A duplicate left by an interrupted earlier claim: the scoped copy wins
	// and the unscoped one is released.
	expectOk(await blobs.put(alreadyScoped, new Blob(['older copy'])));

	const first = expectOk(
		await claimUnscopedBrowserBlobs({
			...scope,
			ids: [cited, alreadyScoped, neverHere],
			indexedDb: indexedDB,
			locks,
		}),
	);
	expect(first).toEqual({
		claimed: 2,
		absent: 1,
		skipped: 0,
		unclaimed: { count: 1, bytes: 'not yours'.length },
	});
	expect(await expectOk(await blobs.get(cited)).text()).toBe('cited bytes');
	expect(expectErr(await blobs.stat(somebodyElses)).name).toBe('BlobNotFound');
	expect(await databaseNames()).toContain('epicenter-blobs');

	const again = expectOk(
		await claimUnscopedBrowserBlobs({
			...scope,
			ids: [cited, alreadyScoped, neverHere],
			indexedDb: indexedDB,
			locks,
		}),
	);
	expect(again).toMatchObject({ claimed: 0, absent: 3, skipped: 0 });

	// A person's explicit choice is the only thing that deletes the rest.
	expectOk(await deleteUnscopedBrowserBlobs({ indexedDb: indexedDB, locks }));
	expect(await databaseNames()).not.toContain('epicenter-blobs');
});

test('a claim keeps even an empty unscoped store, and holds both locks while it runs', async () => {
	const { scope, databaseName } = setup();
	const { held, locks } = fakeLocks();
	const id = generateBlobId();
	await seedUnscoped(id, 'the last one');

	const claim = expectOk(
		await claimUnscopedBrowserBlobs({
			...scope,
			ids: [id],
			indexedDb: indexedDB,
			locks,
		}),
	);
	expect(claim.unclaimed).toEqual({ count: 0, bytes: 0 });
	expect(await databaseNames()).toContain('epicenter-blobs');

	held.add(`epicenter.blobs:${databaseName}`);
	await seedUnscoped(generateBlobId(), 'held');
	expect(
		expectErr(
			await claimUnscopedBrowserBlobs({
				...scope,
				ids: [id],
				indexedDb: indexedDB,
				locks,
			}),
		).name,
	).toBe('BlobStoreHeld');
	held.clear();
	held.add('epicenter.blobs:epicenter-blobs');
	expect(
		expectErr(await deleteUnscopedBrowserBlobs({ indexedDb: indexedDB, locks }))
			.name,
	).toBe('BlobStoreHeld');
	held.clear();
	expectOk(await deleteUnscopedBrowserBlobs({ indexedDb: indexedDB, locks }));
});

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
		store.stat(id),
		store.delete(id),
	])) {
		expect(expectErr<BlobStoreError>(result)).toMatchObject({
			name: 'BlobStoreFailed',
			cause: { name: 'BlobStoreHeld' },
		});
	}
	expect(await databaseNames()).not.toContain(databaseName);
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
