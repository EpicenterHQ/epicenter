/**
 * Application handle tests.
 *
 * Verifies the clean-break API owns local acquisition, readiness, and closure.
 * Reopening fake IndexedDB proves rows survive a handle lifetime, not a browser restart.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { type BlobStore, generateBlobId } from '@epicenter/blobs';
import { type AppSqliteDatabase, DeviceError } from '@epicenter/device';
import {
	createSqliteOwner,
	type DeviceSqliteOwner,
} from '@epicenter/device/owner';
import { asPrincipalId } from '@epicenter/principal';
import { installTestLocks } from '@epicenter/data/test-locks';
import { openAppData } from '@epicenter/data/browser';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createEpicenter } from './index.js';
import { createBrowserAppBlobs } from './browser.js';
import { createBrowserRecording } from '@epicenter/recorder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { Ok, type Result } from 'wellcrafted/result';

installTestLocks();

const testSqlite: DeviceSqliteOwner = {
	acquire: async () => ({
		open: async () => ({
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			batch: async () => Ok({ changes: [] }),
		}),
		delete: async () => undefined,

		close: async () => undefined,
	}),
};
const testBlobs = createBrowserAppBlobs();

const definition = defineData({
	id: 'so.epicenter.app-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
		recordings: defineTable({ audio: field.blob(), content: plainText() }),
	},
});

const create = () =>
	createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: testSqlite,
		blobs: testBlobs,
	});

async function clearStorage() {
	for (const { name } of await indexedDB.databases()) {
		if (name === undefined) continue;
		if (
			!name.startsWith('epicenter/v5/so.epicenter.app-test/') &&
			!name.startsWith('epicenter/so.epicenter.app-test/')
		)
			continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

test('local handle opens without account and survives close and reopen', async () => {
	await clearStorage();
	const first = create().openLocal();
	expect(first.account).toBeNull();
	expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
	expect(Object.hasOwn(first, 'tables')).toBe(true);
	expect(Object.hasOwn(first, 'blobs')).toBe(true);
	expectOk(await first.ready);
	first.tables.notes.create({ title: 'kept locally' });
	await first.close();

	const second = create().openLocal();
	expectOk(await second.ready);
	expect(second.tables.notes.rows.map((row) => row.title)).toEqual([
		'kept locally',
	]);
	await second.close();
});

test.each([
	['app', 'before acquisition'],
	['app', 'during acquisition'],
	['data', 'before acquisition'],
	['data', 'during acquisition'],
] as const)('%s capabilities retain one account when the input changes %s', async (entry, timing) => {
	await clearStorage();
	const requested = Promise.withResolvers<void>();
	const releaseRequest = Promise.withResolvers<void>();
	const identities: unknown[] = [];
	const owner: DeviceSqliteOwner = {
		acquire: async (_appId, account) => {
			identities.push(account);
			return {
				open: async () => {
					return {
						run: async () => Ok({ changes: 0 }),
						all: async () => Ok([]),
						batch: async () => Ok({ changes: [] }),
					};
				},
				delete: async () => undefined,

				close: async () => undefined,
			};
		},
	};
	let requests = 0;
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch() {
			requests++;
			if (requests === 1) {
				requested.resolve();
				await releaseRequest.promise;
			}
			return requests === 1
				? Response.json({ generations: [] })
				: Response.json({ generation: 1, position: 0 });
		},
		async openWebSocket() {
			throw new Error('Not needed for SQLite scope.');
		},
		async getProfile() {
			throw new Error('Not needed for SQLite scope.');
		},
	};
	const epicenter = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	});
	const localApp = epicenter.openLocal();
	expect(() => localApp.sqlite.open('search')).toThrow('not ready');
	expectOk(await localApp.ready);
	const localDatabase = expectOk(await localApp.sqlite.open('search'));
	const accountApp =
		entry === 'app'
			? epicenter.openAccount(account)
			: openAppData(definition, {
					appId: 'so.epicenter.app-test',
					account,
					blobs: testBlobs({ appId: 'so.epicenter.app-test', account }),
					sqlite: owner,
					recording: createBrowserRecording('so.epicenter.app-test', account),
				});
	if (timing === 'during acquisition') await requested.promise;
	Reflect.set(account, 'authorityId', 'replacement-authority');
	Reflect.set(account, 'principalId', asPrincipalId('bob'));
	Reflect.set(account, 'baseURL', 'https://replacement.test');
	account.fetch = async () => {
		throw new Error('Replacement transport must not run.');
	};
	releaseRequest.resolve();
	expectOk(await accountApp.ready);
	expectOk(await accountApp.sqlite.open('search'));
	expectOk(await accountApp.blobs.add(new Blob(['captured'])));
	expect(accountApp.account).toEqual({
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
	});
	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toContain(
		'epicenter/so.epicenter.app-test/accounts/test-authority/alice/data/so.epicenter.app-test/1',
	);
	expect(names).toContain(
		'epicenter/so.epicenter.app-test/accounts/test-authority/alice/blobs',
	);
	expect(names.some((name) => name?.includes('replacement-authority'))).toBe(
		false,
	);
	expect(identities).toEqual([
		null,
		{ authorityId: 'test-authority', principalId: 'alice' },
	]);
	await localApp.close();
	expect(() => localDatabase.run('select 1')).toThrow('disposed');
	await accountApp.close();
});

test('closing waits for an admitted SQLite delete', async () => {
	let beginDelete!: () => void;
	let releaseDelete!: () => void;
	const deleteStarted = new Promise<void>((resolve) => (beginDelete = resolve));
	const deleteReleased = new Promise<void>(
		(resolve) => (releaseDelete = resolve),
	);
	const owner: DeviceSqliteOwner = {
		acquire: async () => ({
			open: async () => ({
				run: async () => Ok({ changes: 0 }),
				all: async () => Ok([]),
				batch: async () => Ok({ changes: [] }),
			}),
			delete: async () => {
				beginDelete();
				await deleteReleased;
			},

			close: async () => undefined,
		}),
	};
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await app.ready);
	const deleting = app.sqlite.delete('search');
	await deleteStarted;
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	const replacement = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(expectErr(await replacement.ready).name).toBe('AlreadyOpen');
	releaseDelete();
	await deleting;
	await closing;
	expect(closed).toBe(true);
	await replacement.close();
	const reopened = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await reopened.ready);
	await reopened.close();
});

test('every retained SQL verb refuses closed use without reaching the shared owner', async () => {
	const calls: string[] = [];
	const owner: DeviceSqliteOwner = {
		acquire: async () => ({
			async open() {
				calls.push('open');
				return {
					run: async () => {
						calls.push('run');
						return Ok({ changes: 1 });
					},
					all: async () => {
						calls.push('all');
						return Ok([]);
					},
					batch: async () => {
						calls.push('batch');
						return Ok({ changes: [1] });
					},
				};
			},
			async delete() {
				calls.push('delete');
			},

			close: async () => undefined,
		}),
	};
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	const { open, delete: remove } = app.sqlite;
	for (const operation of [() => open('search'), () => remove('search')])
		expect(operation).toThrow('not ready');
	expect(calls).toEqual([]);
	expectOk(await app.ready);
	const { run, all, batch } = expectOk(await open('search'));
	expectOk(await run('select 1'));
	expectOk(await all<{ value: number }>('select 1 as value'));
	expectOk(await batch([{ sql: 'select 1' }]));
	expectOk(await remove('search'));
	const admitted = [...calls];
	const operations = [
		() => open('search'),
		() => remove('search'),
		() => run('select 1'),
		() => all('select 1'),
		() => batch([]),
	];
	const closing = app.close();
	for (const operation of operations) expect(operation).toThrow('disposed');
	await closing;
	for (const operation of operations) expect(operation).toThrow('disposed');
	expect(calls).toEqual(admitted);
});

test.each([
	'run',
	'all',
	'batch',
] as const)('an admitted SQL %s can reenter close and keeps the claim until it settles', async (verb) => {
	const released = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let reentrant: Promise<void> | undefined;
	const owner: DeviceSqliteOwner = {
		acquire: async () => ({
			async open() {
				async function wait() {
					reentrant = app.close();
					started.resolve();
					await released.promise;
				}
				return {
					run: async () => {
						await wait();
						return Ok({ changes: 1 });
					},
					all: async () => {
						await wait();
						return Ok([]);
					},
					batch: async () => {
						await wait();
						return Ok({ changes: [1] });
					},
				};
			},
			delete: async () => undefined,

			close: async () => undefined,
		}),
	};
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await app.ready);
	const database = expectOk(await app.sqlite.open('search'));
	const pending: Promise<Result<unknown, DeviceError>> =
		verb === 'batch' ? database.batch([]) : database[verb]('select 1');
	try {
		await started.promise;
		expect(reentrant).toBe(app.close());
		const duplicate = create().openLocal();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
		released.resolve();
		expectOk(await pending);
		await app.close();
	} finally {
		released.resolve();
		await app.close();
	}
});

test('a late SQL open refuses publication and physically closes without deleting files', async () => {
	const opening = Promise.withResolvers<
		AppSqliteDatabase & { close(): Promise<void> }
	>();
	const started = Promise.withResolvers<void>();
	let deletes = 0;
	let physicalCloses = 0;
	const physical = {
		...(await (
			await testSqlite.acquire('so.epicenter.app-test', null)
		).open('search')),
		async close() {
			physicalCloses++;
		},
	};
	const owner = createSqliteOwner({
		open() {
			started.resolve();
			return opening.promise;
		},
		async delete() {
			deletes++;
		},
	});
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await app.ready);
	const pending = app.sqlite.open('search');
	const outcome = Promise.allSettled([pending]);
	await started.promise;
	const closing = app.close();
	let closed = false;
	void closing.then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(closed).toBe(false);
		opening.resolve(physical);
		expect(await outcome).toEqual([
			{
				status: 'rejected',
				reason: expect.objectContaining({ name: 'StoreUnusableError' }),
			},
		]);
		await closing;
		expect(deletes).toBe(0);
		expect(physicalCloses).toBe(1);
	} finally {
		opening.resolve(physical);
		await closing;
	}
});

test('reentrant failed cleanup still drains SQL, blobs, and owning creation before releasing the claim', async () => {
	const sql = Promise.withResolvers<Result<{ changes: number }, DeviceError>>();
	const reading =
		Promise.withResolvers<Awaited<ReturnType<BlobStore['get']>>>();
	const writing = Promise.withResolvers<Result<void, never>>();
	const writeStarted = Promise.withResolvers<void>();
	const compensating = Promise.withResolvers<Result<void, never>>();
	const compensated = Promise.withResolvers<void>();
	const cause = new Error('page cleanup failed');
	const sqlCause = new Error('SQL rejected');
	let reentrant: Promise<void> | undefined;
	const originals = ['document', 'addEventListener', 'removeEventListener'].map(
		(name) =>
			[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: {
			acquire: async () => ({
				async open() {
					return {
						...(await (
							await testSqlite.acquire('so.epicenter.app-test', null)
						).open('search')),
						run: () => sql.promise,
					};
				},
				delete: async () => undefined,

				close: async () => undefined,
			}),
		},
		blobs(input) {
			const backing = testBlobs(input);
			return {
				...backing,
				local: {
					...backing.local,
					get: () => reading.promise,
					put() {
						writeStarted.resolve();
						return writing.promise;
					},
					delete() {
						compensated.resolve();
						return compensating.promise;
					},
				},
			};
		},
	}).openLocal();
	Object.defineProperties(globalThis, {
		document: {
			configurable: true,
			value: {
				visibilityState: 'visible',
				addEventListener() {},
				removeEventListener() {
					reentrant = app.close();
					throw cause;
				},
			},
		},
		addEventListener: { configurable: true, value: () => undefined },
		removeEventListener: { configurable: true, value: () => undefined },
	});
	let closing: Promise<void> | undefined;
	try {
		expectOk(await app.ready);
		const database = expectOk(await app.sqlite.open('search'));
		const run = database.run('select 1');
		const read = app.blobs.get(generateBlobId());
		const create = app.tables.recordings.create({ audio: new Blob(['bytes']) });
		const outcomes = Promise.allSettled([run, create]);
		await writeStarted.promise;
		closing = app.close();
		const closed = Promise.allSettled([closing]);
		expect(reentrant).toBe(closing);
		expect(app.close()).toBe(closing);
		sql.reject(sqlCause);
		writing.resolve(Ok(undefined));
		await compensated.promise;
		const duplicate = createEpicenter({
			appId: 'so.epicenter.app-test',
			definition,
			sqlite: testSqlite,
			blobs: testBlobs,
		}).openLocal();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
		reading.resolve(Ok(new Blob(['read'])));
		expect(await expectOk(await read).text()).toBe('read');
		let settled = false;
		void closed.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		compensating.resolve(Ok(undefined));
		expect(await outcomes).toEqual([
			{ status: 'rejected', reason: sqlCause },
			{
				status: 'rejected',
				reason: expect.objectContaining({ name: 'StoreUnusableError' }),
			},
		]);
		expect(await closed).toEqual([{ status: 'rejected', reason: cause }]);
	} finally {
		sql.resolve(Ok({ changes: 0 }));
		reading.resolve(Ok(new Blob()));
		writing.resolve(Ok(undefined));
		compensating.resolve(Ok(undefined));
		await (closing ?? app.close()).catch(() => undefined);
		for (const [name, descriptor] of originals) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, descriptor);
		}
	}
	const reopened = create().openLocal();
	expectOk(await reopened.ready);
	await reopened.close();
});

test('the app handle owns scoped blob reads and writes by BlobId', async () => {
	await clearStorage();
	const app = create().openLocal();
	expectOk(await app.ready);

	const id = expectOk(
		await app.blobs.add(new Blob(['audio'], { type: 'audio/wav' })),
	);
	const stored = expectOk(await app.blobs.get(id));
	expect(id).toMatch(/^blob_[a-z0-9]{21}$/);
	expect(await stored.text()).toBe('audio');
	expect(expectOk(await app.blobs.stat(id)).size).toBe(5);

	await app.close();
	expect(() => app.blobs.add(new Blob(['late']))).toThrow('disposed');
});

test('owning table create saves bytes before publishing an ID and both survive reopen', async () => {
	await clearStorage();
	const first = create().openLocal();
	const { create: record } = first.tables.recordings;
	expect(() => record({ audio: new Blob(['early']) })).toThrow('not ready');
	expectOk(await first.ready);
	const row = expectOk(await record({ audio: new Blob(['recorded bytes']) }));
	expect(row.audio).toMatch(/^blob_[a-z0-9]{21}$/);
	expect(await expectOk(await first.blobs.get(row.audio)).text()).toBe(
		'recorded bytes',
	);
	await first.close();
	expect(() => record({ audio: new Blob(['late']) })).toThrow('disposed');
	const reopened = create().openLocal();
	expectOk(await reopened.ready);
	expect(reopened.tables.recordings.get(row.id)?.audio).toBe(row.audio);
	expect(await expectOk(await reopened.blobs.get(row.audio)).text()).toBe(
		'recorded bytes',
	);
	await reopened.close();
});

test('closing during acquisition reports closure and releases the resource', async () => {
	await clearStorage();
	const app = create().openLocal();
	const closing = app.close();
	expect(expectErr(await app.ready).name).toBe('ClosedWhileOpening');
	await closing;
});

test('access is gated and a rejected duplicate cannot release the first app', async () => {
	await clearStorage();
	const first = create().openLocal();
	const notes = first.tables.notes;
	const kv = first.kv;
	const { add, statMany } = first.blobs;
	expect(() => notes.rows).toThrow('not ready');
	expect(() => kv.subscribe(() => {})).toThrow('not ready');
	expect(() => add(new Blob(['premature']))).toThrow('not ready');
	expect(() => statMany([])).toThrow('not ready');
	expectOk(await first.ready);
	expect(first.tables.notes).toBe(notes);
	expect(first.kv).toBe(kv);
	expect(first.blobs.add).toBe(add);

	const duplicate = create().openLocal();
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	expect(() => duplicate.blobs.add(new Blob(['rejected']))).toThrow('disposed');
	await duplicate.close();
	first.tables.notes.create({ title: 'still owned by the first app' });

	const another = create().openLocal();
	expect(expectErr(await another.ready).name).toBe('AlreadyOpen');
	await another.close();
	expect(first.tables.notes.rows).toHaveLength(1);
	await first.close();
});

test('repeated close shares completion and permits a fresh open afterward', async () => {
	await clearStorage();
	const app = create().openLocal();
	expectOk(await app.ready);
	app.tables.notes.create({ title: 'flushed on close' });
	const notes = app.tables.notes;
	const persistence = app.persistence;
	const encode = app.encodeStateSince;
	const closing = app.close();
	expect(app.close()).toBe(closing);
	expect(() => notes.create({ title: 'too late' })).toThrow();
	expect(() => notes.rows).toThrow();
	expect(() => persistence.get()).toThrow();
	expect(() => persistence.subscribe(() => {})).toThrow();
	expect(() => encode()).toThrow();
	await closing;

	const reopened = create().openLocal();
	expectOk(await reopened.ready);
	expect(reopened.tables.notes.rows[0]?.title).toBe('flushed on close');
	await reopened.close();
});

test('account acquisition hydrates the existing handles and survives refused sync', async () => {
	await clearStorage();
	const seed = create().openLocal();
	expectOk(await seed.ready);
	seed.tables.notes.create({ title: 'from the account' });
	const snapshot = seed.encodeStateSince();
	await seed.close();
	let fetches = 0;
	let dials = 0;
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch() {
			fetches += 1;
			return fetches === 1
				? Response.json({ generations: [1] })
				: new Response(new Uint8Array(snapshot));
		},
		async openWebSocket() {
			dials += 1;
			throw new Error('Offline');
		},
		async getProfile() {
			throw new Error('Opening data must not fetch a profile.');
		},
	};
	const app = create().openAccount(account);
	const notes = app.tables.notes;
	expect(app.account).toEqual({
		authorityId: 'test-authority',
		principalId: account.principalId,
	});
	expectOk(await app.ready);
	expect(app.tables.notes).toBe(notes);
	expect(notes.rows[0]?.title).toBe('from the account');
	expect(fetches).toBe(2);
	expect(dials).toBe(1);
	notes.create({ title: 'still editable' });
	await app.close();

	const reopened = create().openAccount(account);
	expectOk(await reopened.ready);
	expect(fetches).toBe(2);
	expect(reopened.tables.notes.rows).toHaveLength(2);
	await reopened.close();
});

test('invalid definitions and missing account identity throw before opening storage', async () => {
	await clearStorage();
	const invalid = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition: { id: '', tables: {}, kv: {} },
		sqlite: testSqlite,
		blobs: testBlobs,
	});
	expect(() => invalid.openLocal()).toThrow();
	expect(
		(await indexedDB.databases()).filter(({ name }) =>
			name?.split('/').includes('so.epicenter.app-test'),
		),
	).toEqual([]);
});

test('physical SQL close retains the library claim across sibling definitions', async () => {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let acquisitions = 0;
	const owner: DeviceSqliteOwner = {
		async acquire(appId, account) {
			acquisitions++;
			const lifetime = await testSqlite.acquire(appId, account);
			return {
				...lifetime,
				async close() {
					started.resolve();
					await released.promise;
				},
			};
		},
	};
	const first = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await first.ready);
	const siblingDefinition = defineData({
		id: 'so.epicenter.sibling',
		tables: {},
		kv: {},
	});
	const sibling = () =>
		createEpicenter({
			appId: 'so.epicenter.app-test',
			definition: siblingDefinition,
			sqlite: owner,
			blobs: testBlobs,
		}).openLocal();
	const duplicate = sibling();
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	await duplicate.close();
	const closing = first.close();
	try {
		await started.promise;
		const duringClose = sibling();
		expect(expectErr(await duringClose.ready).name).toBe('AlreadyOpen');
		await duringClose.close();
		expect(acquisitions).toBe(1);
	} finally {
		released.resolve();
		await closing;
	}
	const reopened = sibling();
	expectOk(await reopened.ready);
	expect(acquisitions).toBe(2);
	await reopened.close();
});
