/**
 * Application handle tests.
 *
 * Verifies the clean-break API owns local acquisition, readiness, and closure.
 * Reopening fake IndexedDB proves rows survive a handle lifetime, not a browser restart.
 */
import 'fake-indexeddb/auto';
import { expect, spyOn, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { type BlobStore, generateBlobId } from '@epicenter/blobs';
import * as dataBrowser from '@epicenter/data/browser';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import {
	type AppSqliteDatabase,
	type DeviceError,
	SecretError,
	secretLabel,
} from '@epicenter/device';
import { createBrowserSecrets } from '@epicenter/device/browser';
import {
	createSqliteOwner,
	type DeviceSqliteOwner,
} from '@epicenter/device/owner';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { encodeFrame } from '../../data/src/sync/frames.js';
import { createAiConfiguration } from './ai-configuration.js';
import { browser, createBrowserAppBlobs } from './browser.js';
import { defineApplication } from './index.js';
import { openApp } from './open.js';
import { createBrowserRecording } from './recording/browser.js';

installTestLocks();

const testSqlite: DeviceSqliteOwner = {
	acquire: async () => ({
		open: async () => ({
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			query: async () => Ok({ columns: [], rows: [], truncated: false }),
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
	defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: testSqlite,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	});

/** The authority returns the stored seed bytes after minting a generation. */
function createGenerationFetch(): Account['fetch'] {
	let state: Blob | null = null;
	return async (_input, init) => {
		if (init?.method !== 'POST') throw new Error('Expected current download');
		state ??= await new Response(init.body).blob();
		return createCurrentDownloadResponse({
			generation: 1,
			head: 1,
			snapshot: {
				position: 1,
				bytes: new Uint8Array(await state.arrayBuffer()),
			},
			tail: [],
		});
	};
}

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
						query: async () => Ok({ columns: [], rows: [], truncated: false }),
						batch: async () => Ok({ changes: [] }),
					};
				},
				delete: async () => undefined,

				close: async () => undefined,
			};
		},
	};
	let requests = 0;
	const fetchGeneration = createGenerationFetch();
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch(input, init) {
			requests++;
			if (requests === 1) {
				requested.resolve();
				await releaseRequest.promise;
			}
			return fetchGeneration(input, init);
		},
		async openWebSocket() {
			throw new Error('Not needed for SQLite scope.');
		},
		async getProfile() {
			throw new Error('Not needed for SQLite scope.');
		},
	};
	const epicenter = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	});
	const localApp = epicenter.openLocal();
	expect(() => localApp.sqlite.open('search')).toThrow('not ready');
	expectOk(await localApp.ready);
	const localDatabase = expectOk(await localApp.sqlite.open('search'));
	const accountApp =
		entry === 'app'
			? epicenter.openPersonal(account)
			: openApp(definition, {
					appId: 'so.epicenter.app-test',
					choice: { library: 'personal', account },
					blobs: testBlobs,
					sqlite: owner,
					recording: createBrowserRecording,
					secrets: createBrowserSecrets,
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
		'epicenter/so.epicenter.app-test/accounts/test-authority/alice/data/so.epicenter.app-test/personal/current',
	);
	expect(names).toContain(
		'epicenter/so.epicenter.app-test/accounts/test-authority/alice/blobs',
	);
	expect(names.some((name) => name?.includes('replacement-authority'))).toBe(
		false,
	);
	expect(identities).toEqual([
		{ library: 'local' },
		{
			library: 'personal',
			account: { authorityId: 'test-authority', principalId: 'alice' },
		},
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
				query: async () => Ok({ columns: [], rows: [], truncated: false }),
				batch: async () => Ok({ changes: [] }),
			}),
			delete: async () => {
				beginDelete();
				await deleteReleased;
			},

			close: async () => undefined,
		}),
	};
	const app = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await app.ready);
	const deleting = app.sqlite.delete('search');
	await deleteStarted;
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	const replacement = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	await Promise.resolve();
	expect(closed).toBe(false);
	expect(expectErr(await replacement.ready).name).toBe('AlreadyOpen');
	releaseDelete();
	await deleting;
	await closing;
	expect(closed).toBe(true);
	await replacement.close();
	const reopened = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
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
					query: async () => {
						calls.push('query');
						return Ok({ columns: [], rows: [], truncated: false });
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
	const app = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	const { open, delete: remove } = app.sqlite;
	for (const operation of [() => open('search'), () => remove('search')])
		expect(operation).toThrow('not ready');
	expect(calls).toEqual([]);
	expectOk(await app.ready);
	const { run, all, batch, query } = expectOk(await open('search'));
	expectOk(await run('select 1'));
	expectOk(await all<{ value: number }>('select 1 as value'));
	expectOk(await batch([{ sql: 'select 1' }]));
	expectOk(await query('select 1', { tables: [] }));
	expectOk(await remove('search'));
	const admitted = [...calls];
	const operations = [
		() => open('search'),
		() => remove('search'),
		() => run('select 1'),
		() => all('select 1'),
		() => batch([]),
		() => query('select 1', { tables: [] }),
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
	'query',
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
					query: async () => {
						await wait();
						return Ok({ columns: [], rows: [], truncated: false });
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
	const app = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await app.ready);
	const database = expectOk(await app.sqlite.open('search'));
	const pending: Promise<Result<unknown, DeviceError>> =
		verb === 'batch'
			? database.batch([])
			: verb === 'query'
				? database.query('select 1', { tables: [] })
				: database[verb]('select 1');
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
			await testSqlite.acquire('so.epicenter.app-test', { library: 'local' })
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
	const app = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
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
	const app = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: {
				acquire: async () => ({
					async open() {
						return {
							...(await (
								await testSqlite.acquire('so.epicenter.app-test', {
									library: 'local',
								})
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
		},
		ai: { runtime: null, account: null },
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
		const duplicate = defineApplication({
			appId: 'so.epicenter.app-test',
			definition,
			runtime: {
				...browser,
				sqlite: testSqlite,
				blobs: testBlobs,
			},
			ai: { runtime: null, account: null },
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
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: { position: 1, bytes: snapshot },
				tail: [],
			});
		},
		async openWebSocket() {
			dials += 1;
			throw new Error('Offline');
		},
		async getProfile() {
			throw new Error('Opening data must not fetch a profile.');
		},
	};
	const app = create().openPersonal(account);
	const notes = app.tables.notes;
	expect(app.account).toEqual({
		authorityId: 'test-authority',
		principalId: account.principalId,
	});
	expectOk(await app.ready);
	expect(app.tables.notes).toBe(notes);
	expect(notes.rows[0]?.title).toBe('from the account');
	expect(fetches).toBe(1);
	expect(dials).toBe(1);
	notes.create({ title: 'still editable' });
	await app.close();

	const reopened = create().openPersonal(account);
	expectOk(await reopened.ready);
	expect(fetches).toBe(1);
	expect(reopened.tables.notes.rows).toHaveLength(2);
	await reopened.close();
});

test('invalid definitions and missing account identity throw before opening storage', async () => {
	await clearStorage();
	const invalid = defineApplication({
		appId: 'so.epicenter.app-test',
		definition: { id: '', tables: {}, kv: {} },
		runtime: {
			...browser,
			sqlite: testSqlite,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
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
		async acquire(appId, replica) {
			acquisitions++;
			const lifetime = await testSqlite.acquire(appId, replica);
			return {
				...lifetime,
				async close() {
					started.resolve();
					await released.promise;
				},
			};
		},
	};
	const first = defineApplication({
		appId: 'so.epicenter.app-test',
		definition,
		runtime: {
			...browser,
			sqlite: owner,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await first.ready);
	const siblingDefinition = defineData({
		id: 'so.epicenter.sibling',
		tables: {},
		kv: {},
	});
	const sibling = () =>
		defineApplication({
			appId: 'so.epicenter.app-test',
			definition: siblingDefinition,
			runtime: {
				...browser,
				sqlite: owner,
				blobs: testBlobs,
			},
			ai: { runtime: null, account: null },
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

test('failed durable release retains SQL and the common library claim', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	let sqlCloses = 0;
	const epicenter = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				async acquire(...args) {
					const lifetime = await testSqlite.acquire(...args);
					return {
						...lifetime,
						async close() {
							sqlCloses++;
						},
					};
				},
			},
		},
		ai: { runtime: null, account: null },
	});
	const app = epicenter.openLocal();
	expectOk(await app.ready);
	const close = spyOn(IDBDatabase.prototype, 'close');
	close.mockImplementation(function (this: IDBDatabase) {
		throw new Error('Durable close failed');
	});
	try {
		await expect(app.close()).rejects.toThrow('Durable close failed');
		expect(sqlCloses).toBe(0);
		const duplicate = epicenter.openLocal();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
	} finally {
		close.mockRestore();
	}
});

test('failed bootstrap cleanup retains SQL and library ownership before ready', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	let sqlCloses = 0;
	const epicenter = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				async acquire(...args) {
					const lifetime = await testSqlite.acquire(...args);
					return {
						...lifetime,
						async close() {
							sqlCloses++;
						},
					};
				},
			},
		},
		ai: { runtime: null, account: null },
	});
	const closing = spyOn(IDBDatabase.prototype, 'close').mockImplementation(
		() => {
			throw new Error('Bootstrap close failed');
		},
	);
	try {
		const app = epicenter.openLocal();
		expect(expectErr(await app.ready).name).toBe('StorageFailed');
		await app.close();
		expect(sqlCloses).toBe(0);
		const duplicate = epicenter.openLocal();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
	} finally {
		closing.mockRestore();
	}
});

test('retained AI shares readiness and close drains response work before releasing storage', async () => {
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const released: string[] = [];
	let signal: AbortSignal | null | undefined;
	const app = defineApplication({
		appId: 'so.epicenter.capability-test',
		definition,
		ai: {
			account: null,
			runtime: {
				baseURL: 'https://inference.test/v1',
				fetch: async (_input, init) => {
					signal = init?.signal;
					started.resolve();
					await drain.promise;
					released.push('capability');
					return Response.json({ data: [] });
				},
			},
		},
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire('so.epicenter.capability-test', {
						library: 'local',
					})),
					close: async () => {
						released.push('storage');
					},
				}),
			},
		},
	}).openLocal();
	const client = app.ai.runtime!.client;
	expect(() => app.ai.configured()).toThrow('not ready');
	expectOk(await app.ready);
	const request = (async () => await client.models.list())();
	void request.catch(() => {});
	await started.promise;
	const closing = app.close();
	expect(signal?.aborted).toBe(true);
	await expect((async () => await client.models.list())()).rejects.toThrow();
	expect(app.close()).toBe(closing);
	expect(released).toEqual([]);
	drain.resolve();
	await closing;
	await expect(request).rejects.toThrow();
	expect(released).toEqual(['capability', 'storage']);
});

test.each([
	'recording',
	'capability',
] as const)('close waits for both producers when %s cleanup fails', async (failing) => {
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let released = false;
	let settled = false;
	const appId = 'test.' + crypto.randomUUID();
	const app = defineApplication({
		appId,
		definition,
		ai: {
			account: null,
			runtime: {
				baseURL: 'https://inference.test/v1',
				fetch: async () => {
					started.resolve();
					await drain.promise;
					return Response.json({ data: [] });
				},
			},
			configuration: () => ({
				...createAiConfiguration({
					storageKey: appId,
					storage: { getItem: () => null, setItem() {}, removeItem() {} },
				}),
				close() {
					if (failing === 'capability') throw new Error('capability failed');
				},
			}),
		},
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire(appId, { library: 'local' })),
					close: async () => {
						released = true;
					},
				}),
			},
			recording: (id, account, options) => ({
				...createBrowserRecording(id, account, options),
				close: async () => {
					if (failing === 'recording') throw new Error('recording failed');
					await drain.promise;
				},
			}),
		},
	}).openLocal();
	expectOk(await app.ready);
	const request = (async () => await app.ai.runtime!.client.models.list())();
	void request.catch(() => {});
	await started.promise;
	const closed = app.close();
	void closed.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(settled).toBe(false);
	drain.resolve();
	await expect(closed).rejects.toThrow(
		failing === 'recording'
			? 'recording failed'
			: 'AI transport cleanup failed',
	);
	await expect(request).rejects.toThrow();
	expect(released).toBe(false);
});

test('one captured Account supplies library and AI; local opening never borrows it', async () => {
	const appId = 'test.' + crypto.randomUUID();
	const supplied: Account[] = [];
	let inferenceRequests = 0;
	const fetchGeneration = createGenerationFetch();
	const account: Account = {
		authorityId: 'captured',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://captured.example',
		async fetch(input, init) {
			if (String(input).endsWith('/models')) {
				inferenceRequests++;
				return Response.json({ data: [] });
			}
			return fetchGeneration(input, init);
		},
		async openWebSocket() {
			throw new Error('No test sync server');
		},
		async getProfile() {
			throw new Error('No test profile');
		},
	};
	const application = defineApplication({
		appId,
		definition,
		ai: {
			runtime: null,
			account: (captured) => {
				supplied.push(captured);
				return { baseURL: `${captured.baseURL}/v1`, fetch: captured.fetch };
			},
		},
		runtime: {
			...browser,
			sqlite: testSqlite,
			blobs: testBlobs,
		},
	});
	const local = application.openLocal();
	expect(local.ai.account).toBeNull();
	expect(supplied).toEqual([]);
	expectOk(await local.ready);
	await local.close();
	const app = application.openPersonal(account);
	const retained = app.ai.account!.client;
	Reflect.set(account, 'principalId', asPrincipalId('bob'));
	account.fetch = async () => {
		throw new Error('Replacement must not run');
	};
	expectOk(await app.ready);
	expect(app.account?.principalId).toBe(asPrincipalId('alice'));
	expect(supplied[0]?.principalId).toBe(asPrincipalId('alice'));
	await retained.models.list();
	expect(inferenceRequests).toBe(1);
	await app.close();
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	expect(inferenceRequests).toBe(1);
});

test('opening failure retires retained SDK clients through internal close', async () => {
	let requests = 0;
	const app = defineApplication({
		appId: 'test.' + crypto.randomUUID(),
		definition,
		ai: {
			account: null,
			runtime: {
				baseURL: 'https://runtime.example/v1',
				fetch: async () => {
					requests++;
					return Response.json({ data: [] });
				},
			},
		},
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => {
					throw new Error('storage unavailable');
				},
			},
		},
	}).openLocal();
	const retained = app.ai.runtime!.client;
	expectErr(await app.ready);
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	expect(requests).toBe(0);
	await app.close();
});

test('App secrets require readiness and survive closing and reopening the same document scope', async () => {
	const label = secretLabel('gmail');
	const first = create();
	const app = first.openLocal();
	expect(() => app.secrets.put(label, 'before-ready')).toThrow('not ready');
	expectOk(await app.ready);
	expectOk(await app.secrets.put(label, 'kept'));
	await app.close();
	expect(() => app.secrets.get(label)).toThrow();
	expect(() => app.secrets.delete(label)).toThrow();
	const reopened = first.openLocal();
	expectOk(await reopened.ready);
	expect(expectOk(await reopened.secrets.get(label))).toBe('kept');
	expectOk(await reopened.secrets.delete(label));
	await reopened.close();
});

test('App close drains admitted secret writes before releasing its SQL lifetime', async () => {
	const write = Promise.withResolvers<void>();
	let backingClosed = false;
	let writes = 0;
	const app = defineApplication({
		appId: 'so.epicenter.secret-drain',
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					open: async () => {
						throw new Error('No database needed');
					},
					delete: async () => {},
					close: async () => {
						backingClosed = true;
					},
				}),
			},
			secrets: (_appId, _account, { assertUsable } = {}) => ({
				close: () => write.promise,
				value: {
					put() {
						assertUsable?.();
						writes++;
						return write.promise.then(() => Ok(undefined));
					},
					get: async () => Ok(null),
					delete: async () => Ok(undefined),
				},
			}),
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await app.ready);
	const saving = app.secrets.put(secretLabel('gmail'), 'token');
	const closing = app.close();
	expect(() => app.secrets.put(secretLabel('gmail'), 'late')).toThrow();
	await Promise.resolve();
	expect(writes).toBe(1);
	expect(backingClosed).toBe(false);
	write.resolve();
	expectOk(await saving);
	await closing;
	expect(backingClosed).toBe(true);
});

test('a secret operation can reenter close and forwards its storage Result unchanged', async () => {
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const failure = SecretError.StorageFailed({
		cause: new Error('Keychain unavailable'),
	});
	let closing: Promise<void> | undefined;
	let released = false;
	const app = defineApplication({
		appId: 'so.epicenter.secret-reentrant',
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					open: async () => {
						throw new Error('No database needed');
					},
					delete: async () => {},
					close: async () => {
						released = true;
					},
				}),
			},
			secrets: () => ({
				close: () => release.promise,
				value: {
					put: async () => {
						closing = app.close();
						entered.resolve();
						await release.promise;
						return failure;
					},
					get: async () => Ok(null),
					delete: async () => Ok(undefined),
				},
			}),
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await app.ready);
	const writing = app.secrets.put(secretLabel('gmail'), 'token');
	await entered.promise;
	expect(released).toBe(false);
	release.resolve();
	expect(await writing).toBe(failure);
	await closing;
	expect(released).toBe(true);
});

test('a late capability constructor failure releases scheduled acquisition and prior capabilities', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	const released = Promise.withResolvers<void>();
	const events: string[] = [];
	const failure = new Error('Secrets construction failed');
	const application = defineApplication({
		appId,
		definition,
		ai: {
			account: null,
			runtime: null,
			configuration: () => ({
				...createAiConfiguration({
					storageKey: appId,
					storage: { getItem: () => null, setItem() {}, removeItem() {} },
				}),
				close() {
					events.push('ai');
				},
			}),
		},
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire(appId, { library: 'local' })),
					close: async () => {
						events.push('storage');
						released.resolve();
					},
				}),
			},
			recording: (...args) => {
				const recorder = createBrowserRecording(...args);
				return {
					...recorder,
					async close() {
						await recorder.close();
						events.push('recording');
					},
				};
			},
			secrets: () => {
				throw failure;
			},
		},
	});
	expect(() => application.openLocal()).toThrow(failure);
	await released.promise;
	expect(events).toContain('recording');
	expect(events).toContain('ai');
	expect(events.at(-1)).toBe('storage');
	const next = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: testSqlite,
		},
		ai: { runtime: null, account: null },
	}).openLocal();
	expectOk(await next.ready);
	await next.close();
});

test.each([
	false,
	true,
])('failed data opening authorizes recorder recovery and retains the opening error when cleanup fails=%s', async (cleanupFails) => {
	const appId = `test.${crypto.randomUUID()}`;
	let recoveryAllowed: boolean | undefined;
	let sqlClosed = false;
	const cleanupFailure = new Error('Capture release failed');
	const account: Account = {
		authorityId: 'failure-test',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://failure.test',
		fetch: async () => new Response('unavailable', { status: 503 }),
		openWebSocket: async () => {
			throw new Error('Unused');
		},
		getProfile: async () => {
			throw new Error('Unused');
		},
	};
	const application = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire(appId, {
						library: 'personal',
						account,
					})),
					close: async () => {
						sqlClosed = true;
					},
				}),
			},
			recording: (id, identity, options) => ({
				...createBrowserRecording(id, identity, options),
				async close() {
					recoveryAllowed = options?.canRecover?.();
					if (cleanupFails) throw cleanupFailure;
				},
			}),
		},
		ai: { runtime: null, account: null },
	});
	const app = application.openPersonal(account);
	const failure = expectErr(await app.ready);
	expect(failure).not.toBe(cleanupFailure);
	expect(recoveryAllowed).toBe(true);
	if (cleanupFails) {
		await expect(app.close()).rejects.toBe(cleanupFailure);
		expect(sqlClosed).toBe(false);
		const duplicate = application.openPersonal(account);
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close().catch(() => {});
	} else {
		await app.close();
		expect(sqlClosed).toBe(true);
	}
});

test('failed recorder cleanup still drains SQL and keeps the claim after drain', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	const write = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const failure = new Error('Recorder cleanup failed');
	let released = false;
	let settled = false;
	const application = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: {
				async acquire(id, replica) {
					const lifetime = await testSqlite.acquire(id, replica);
					return {
						...lifetime,
						async open(name) {
							const database = await lifetime.open(name);
							return {
								...database,
								async run() {
									entered.resolve();
									await write.promise;
									return Ok({ changes: 1 });
								},
							};
						},
						async close() {
							released = true;
							await lifetime.close();
						},
					};
				},
			},
			recording: (...args) => {
				const owner = createBrowserRecording(...args);
				return {
					value: owner.value,
					async close() {
						await owner.close();
						throw failure;
					},
				};
			},
		},
		ai: { runtime: null, account: null },
	});
	const app = application.openLocal();
	expectOk(await app.ready);
	for (const capability of [
		app.sqlite,
		app.blobs,
		app.secrets,
		app.recording,
	]) {
		expect(Object.hasOwn(capability, 'close')).toBe(false);
		expect(Object.hasOwn(capability, 'acquire')).toBe(false);
	}
	const database = expectOk(await app.sqlite.open('cache'));
	const writing = database.run('UPDATE cache SET value = 1');
	await entered.promise;
	const closing = app.close();
	void closing.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(settled).toBe(false);
	expect(released).toBe(false);
	write.resolve();
	expectOk(await writing);
	await expect(closing).rejects.toBe(failure);
	expect(released).toBe(false);
	const duplicate = application.openLocal();
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	await duplicate.close().catch(() => {});
});

test('App retirement closes its recorder while retaining the library claim through invalidation failure and retry', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	const events = new EventTarget();
	const socket = Object.assign(events, {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
	}) as unknown as WebSocket;
	let invalidation = Promise.withResolvers<void>();
	let disposed = 0;
	let recorderCloses = 0;
	const account: Account = {
		authorityId: 'retirement-test',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://retirement.test',
		async fetch() {
			throw new Error('This test uses its isolated backing');
		},
		async openWebSocket() {
			return socket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const acquire = spyOn(dataBrowser, 'acquireAppData').mockImplementation(
		async () =>
			Ok({
				durable: { commit() {} },
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				discard: () => invalidation.promise,
				dispose() {
					disposed += 1;
				},
				replication: {
					address: {
						baseURL: account.baseURL,
						dataId: definition.id,
						generation: 1,
					},
					transport: account,
				},
			}),
	);
	const application = defineApplication({
		appId,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: testSqlite,
			recording(...args) {
				const owner = createBrowserRecording(...args);
				return {
					...owner,
					close() {
						recorderCloses += 1;
						return owner.close();
					},
				};
			},
		},
		ai: { runtime: null, account: null },
	});
	const app = application.openPersonal(account);
	try {
		expectOk(await app.ready);
		await Bun.sleep(0);
		expect(app.signal.aborted).toBe(false);
		events.dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
		expect(app.signal.aborted).toBe(true);
		const notice = await app.retirement;
		expect(recorderCloses).toBe(1);
		expect(disposed).toBe(0);
		expect(() => app.tables.notes.create({ title: 'late' })).toThrow();
		invalidation.reject(new Error('Invalidation failed'));
		await expect(app.close()).rejects.toThrow('Invalidation failed');
		expect(disposed).toBe(0);
		const duplicate = application.openPersonal(account);
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
		invalidation = Promise.withResolvers<void>();
		const retried = notice.retryInvalidation();
		invalidation.resolve();
		await retried;
		await app.close();
		expect(disposed).toBe(1);
		const reopened = application.openPersonal(account);
		expectOk(await reopened.ready);
		await reopened.close();
	} finally {
		invalidation.resolve();
		await app.close().catch(() => {});
		acquire.mockRestore();
	}
});

test('App retirement during attachment refuses readiness without auto-releasing its backing', async () => {
	const invalidation = Promise.withResolvers<void>();
	let disposed = 0;
	const socket = {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
		addEventListener(type: string, listener: EventListener) {
			if (type === 'message')
				listener(
					new MessageEvent('message', {
						data: encodeFrame({ kind: 'retired' }).buffer,
					}),
				);
		},
	} as unknown as WebSocket;
	const account: Account = {
		authorityId: 'retirement-during-attach',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://retirement.test',
		async fetch() {
			throw new Error('Unused');
		},
		async openWebSocket() {
			return socket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const acquire = spyOn(dataBrowser, 'acquireAppData').mockImplementation(
		async () =>
			Ok({
				durable: { commit() {} },
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				discard: () => invalidation.promise,
				dispose() {
					disposed += 1;
				},
				replication: {
					address: {
						baseURL: account.baseURL,
						dataId: definition.id,
						generation: 1,
					},
					transport: account,
				},
			}),
	);
	const app = defineApplication({
		appId: `test.${crypto.randomUUID()}`,
		definition,
		runtime: {
			...browser,
			blobs: testBlobs,
			sqlite: testSqlite,
		},
		ai: { runtime: null, account: null },
	}).openPersonal(account);
	try {
		expect(expectErr(await app.ready).name).toBe('ClosedWhileOpening');
		await app.retirement;
		expect(disposed).toBe(0);
		invalidation.resolve();
		await app.close();
		expect(disposed).toBe(1);
	} finally {
		invalidation.resolve();
		await app.close().catch(() => {});
		acquire.mockRestore();
	}
});

test('replacing the Account cannot submit Alice pending Shared edits as Bob', async () => {
	const { createSessionAuth } = await import('@epicenter/auth');
	const { decodeFrame } = await import('../../data/src/sync/frames.js');
	const appId = `shared.${crypto.randomUUID()}`;
	let person = 'alice';
	const submissions: string[] = [];
	class Socket extends EventTarget {
		readyState = 0;
		binaryType = '';
		constructor(_url: string | URL, protocols?: string | string[]) {
			super();
			const offered = Array.isArray(protocols) ? protocols : [protocols];
			const actor = offered.find((value) => value?.startsWith('bearer.')) ?? '';
			this.send = (bytes: Uint8Array) => {
				const frame = expectOk(decodeFrame(bytes));
				if (frame.kind === 'push') submissions.push(actor);
			};
			setTimeout(() => {
				if (this.readyState !== 0) return;
				this.readyState = 1;
				this.dispatchEvent(new Event('open'));
				// Alice authors while her socket has not been admitted. Bob is admitted.
				if (actor.includes('bob'))
					this.dispatchEvent(
						new MessageEvent('message', {
							data: encodeFrame({ kind: 'admitted' }).buffer,
						}),
					);
			}, 0);
		}
		send(_bytes: Uint8Array) {}
		close() {
			this.readyState = 3;
			this.dispatchEvent(new Event('close'));
		}
	}
	const current = createGenerationFetch();
	const auth = createSessionAuth({
		authorityId: 'shared-replacement',
		baseURL: 'https://replace.test',
		persistedAuthStorage: {
			initial: { principalId: asPrincipalId('alice'), token: 'alice' },
			set() {},
		},
		launcher: {
			async startSignIn() {
				return { status: 'completed', token: person };
			},
		},
		WebSocket: Socket as unknown as typeof WebSocket,
		fetch: async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname === '/api/session')
				return Response.json({ principalId: person });
			if (url.pathname === '/auth/sign-out') return new Response(null);
			return current(input, init);
		},
	});
	const application = defineApplication({
		appId,
		definition,
		runtime: { ...browser, sqlite: testSqlite, blobs: testBlobs },
		ai: { runtime: null, account: null },
	});
	const state = auth.state;
	if (state.status === 'signed-out') throw new Error('Expected cached Alice');
	const alice = state.account;
	const first = application.openShared(alice);
	expectOk(await first.ready);
	first.tables.notes.create({ title: 'Alice pending private queue' });
	person = 'bob';
	expectOk(await auth.startSignIn());
	await first.close();
	await expect(alice.fetch('/api/session')).rejects.toMatchObject({
		name: 'AbortError',
	});
	const bobState = auth.state;
	if (bobState.status === 'signed-out') throw new Error('Expected Bob');
	const second = application.openShared(bobState.account);
	try {
		expectOk(await second.ready);
		expect(second.tables.notes.rows).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(submissions).toEqual([]);
	} finally {
		await second.close();
		auth[Symbol.dispose]();
	}
});
