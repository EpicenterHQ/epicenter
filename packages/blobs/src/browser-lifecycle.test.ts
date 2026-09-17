/**
 * Browser Blob Store Tests
 *
 * Verifies the IndexedDB implementation of the canonical local blob contract.
 *
 * Key behaviors:
 * - Blob bytes and metadata survive reopening the store
 * - Immutable ids refuse replacement without changing the original bytes
 * - Missing reads are typed, deletion is idempotent, and failures stay typed
 */

import { expect, test } from 'bun:test';
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

let appSequence = 0;

/** A distinct application namespace isolates each test's database. */
function setup() {
	const scope = { appId: `${APP_ID}.test${appSequence++}` };
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

test('the name selects one application without an account or library', () => {
	expect(browserBlobStoreName({ appId: APP_ID })).toBe(
		`epicenter/${APP_ID}/blobs`,
	);
});

test('invalid application identifiers fail before opening storage', () => {
	for (const appId of ['', '.', '..', 'a/b', 'a\\b', 'app'])
		expect(() => browserBlobStoreName({ appId })).toThrow();
});

test('separate applications cannot read one another', async () => {
	const first = setup().blobs;
	const second = setup().blobs;
	const id = generateBlobId('bin');
	expectOk(await first.put(id, new Blob(['first'])));
	expectErr(await second.get(id));
	expectOk(await second.put(id, new Blob(['second'])));
	expect(await expectOk(await first.get(id)).text()).toBe('first');
});

test('get and stat return BlobNotFound for an unknown id', async () => {
	const { blobs } = setup();
	const id = generateBlobId('bin');

	const getError = expectErr(await blobs.get(id));
	const statError = expectErr(await blobs.stat(id));
	expect(getError).toMatchObject({ name: 'BlobNotFound', id });
	expect(statError).toMatchObject({ name: 'BlobNotFound', id });
});

test('delete removes data and metadata and remains idempotent', async () => {
	const { blobs } = setup();
	const id = generateBlobId('bin');
	expectOk(await blobs.put(id, new Blob(['temporary'])));

	expectOk(await blobs.delete(id));
	expectErr(await blobs.get(id));
	expectErr(await blobs.stat(id));
	expectOk(await blobs.delete(id));
});

test('browser source acquisitions own independent disposal that revokes exactly once', async () => {
	const { blobs } = setup();
	const id = generateBlobId('bin');
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
	const id = generateBlobId('bin');
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
	const id = generateBlobId('bin');
	const sources = createBrowserBlobSources(blobs);

	const error = expectErr(await sources.open(id));
	expect(error).toMatchObject({ name: 'BlobNotFound', id });
});

test('browser source creation failures remain typed after storage succeeds', async () => {
	const { blobs } = setup();
	const id = generateBlobId('bin');
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
	const id = generateBlobId('bin');
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
	const id = generateBlobId('bin');
	for (const result of await Promise.all([
		store.put(id, new Blob(['blocked'])),
		store.get(id),
		store.stat(id),
		store.delete(id),
		store.list(),
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
	expect(expectErr(await store.get(generateBlobId('bin')))).toMatchObject({
		cause: { name: 'BlobStoreHeld' },
	});
	request.onsuccess?.(new Event('success'));
	// Let the request and lock-release promise settle.
	await Bun.sleep(0);
	expect(expectErr(await store.get(generateBlobId('bin'))).name).toBe(
		'BlobNotFound',
	);
}, 15_000);
