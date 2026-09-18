/**
 * Application handle tests.
 *
 * Verifies the clean-break API owns local acquisition, readiness, and closure.
 * Reopening fake IndexedDB proves rows survive a handle lifetime, not a browser restart.
 */
import { expect, test } from 'bun:test';
import { defineTable, field, plainText } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import {
	type AppSqliteDatabase,
	type DeviceError,
	SecretError,
	secretLabel,
} from '@epicenter/device';
import {
	createSqliteOwner,
	type DeviceSqliteOwner,
} from '@epicenter/device/owner';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createAiConnections } from './ai-connections.js';
import { encodeFrame } from './data/sync/frames.js';
import { defineApp } from './index.js';
import { openApp } from './open.js';
import { createBrowserRecording } from './recording/browser.js';
import { createMemoryRuntime } from './testing.js';

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

const definition = defineApp({
	id: 'so.epicenter.app-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
		recordings: defineTable({ audio: field.string(), content: plainText() }),
	},
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

test('local handle opens without account and survives close and reopen', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const first = await create();
	expect(first.account).toBeUndefined();

	expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
	expect(Object.hasOwn(first.device, 'tables')).toBe(true);
	expect(Object.hasOwn(first, 'blobs')).toBe(true);

	first.device.tables.notes.create({ title: 'kept locally' });
	await first.close();

	const second = await create();

	expect(second.device.tables.notes.rows.map((row) => row.title)).toEqual([
		'kept locally',
	]);
	await second.close();
});

test.each([
	'before acquisition',
	'during acquisition',
] as const)('capabilities retain the original account when a replacement is created %s', async (timing) => {
	const runtime = createMemoryRuntime();
	const requested = Promise.withResolvers<void>();
	const releaseRequest = Promise.withResolvers<void>();
	const identities: unknown[] = [];
	const owner: DeviceSqliteOwner = {
		acquire: async (appId) => {
			identities.push(appId);
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
		supportsShared: false,
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
	const fixtureDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				sqlite: owner,
				ai: { runtime: null, account: null },
			},
		});
	const localApp = await openFixture();

	const localDatabase = expectOk(await localApp.device.sqlite.open('search'));
	await localApp.close();
	const openingAccount = openFixture(account);
	if (timing === 'during acquisition') await requested.promise;
	const replacement: Account = Object.freeze({
		...account,
		principalId: asPrincipalId('bob'),
		baseURL: 'https://replacement.test',
	});
	expect(replacement).not.toBe(account);
	releaseRequest.resolve();
	const accountApp = await openingAccount;

	expectOk(await accountApp.device.sqlite.open('search'));
	expectOk(await accountApp.blobs.local.add(new Blob(['captured'])));
	expect(accountApp.account!.identity).toEqual({
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
	});
	expect(identities).toEqual([
		'so.epicenter.app-test',
		'so.epicenter.app-test',
	]);
	await localApp.close();
	expect(() => localDatabase.run('select 1')).toThrow();
	await accountApp.close();
});

test('closing waits for an admitted SQLite delete', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
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
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});

	const deleting = app.device.sqlite.delete('search');
	await deleteStarted;
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	const replacementDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const replacement = openApp(replacementDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	await expect(replacement).rejects.toMatchObject({ name: 'AlreadyOpen' });
	releaseDelete();
	await deleting;
	await closing;
	expect(closed).toBe(true);

	const reopenedDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const reopened = await openApp(reopenedDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});

	await reopened.close();
});

test('every retained SQL verb refuses closed use without reaching the shared owner', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
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
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});
	const { open, delete: remove } = app.device.sqlite;
	expect(calls).toEqual([]);

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
	for (const operation of operations) expect(operation).toThrow();
	await closing;
	for (const operation of operations) expect(operation).toThrow();
	expect(calls).toEqual(admitted);
});

test.each([
	'run',
	'all',
	'batch',
	'query',
] as const)('an admitted SQL %s can reenter close and keeps the claim until it settles', async (verb) => {
	const runtime = createMemoryRuntime();
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
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
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});

	const database = expectOk(await app.device.sqlite.open('search'));
	const pending: Promise<Result<unknown, DeviceError>> =
		verb === 'batch'
			? database.batch([])
			: verb === 'query'
				? database.query('select 1', { tables: [] })
				: database[verb]('select 1');
	try {
		await started.promise;
		expect(reentrant).toBe(app.close());
		const duplicate = create();
		await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

		released.resolve();
		expectOk(await pending);
		await app.close();
	} finally {
		released.resolve();
		await app.close();
	}
});

test('a late SQL open refuses publication and physically closes without deleting files', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const opening = Promise.withResolvers<
		AppSqliteDatabase & { close(): Promise<void> }
	>();
	const started = Promise.withResolvers<void>();
	let deletes = 0;
	let physicalCloses = 0;
	const physical = {
		...(await (
			await testSqlite.acquire('so.epicenter.app-test')
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
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});

	const pending = app.device.sqlite.open('search');
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

test('close drains admitted local writes before releasing the app claim', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const fixtureDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				blobs(input) {
					const bytes = runtime.blobs(input);
					const put = bytes.local.put;
					bytes.local.put = async (...args) => {
						entered.resolve();
						await gate.promise;
						return put(...args);
					};
					return bytes;
				},
				ai: { runtime: null, account: null },
			},
		});
	const app = await openFixture();

	const writing = app.blobs.local.add(new Blob(['saved']));
	await entered.promise;
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	gate.resolve();
	const blobId = expectOk(await writing);
	await closing;
	const reopened = await openFixture();

	expect(await expectOk(await reopened.blobs.local.get(blobId)).text()).toBe(
		'saved',
	);
	await reopened.close();
});

test('the app handle owns scoped blob reads and writes by BlobId', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const app = await create();

	const id = expectOk(
		await app.blobs.local.add(new Blob(['audio'], { type: 'audio/wav' })),
	);
	const stored = expectOk(await app.blobs.local.get(id));
	expect(id).toMatch(/^blob_[a-z0-9]{21}\.wav$/);
	expect(await stored.text()).toBe('audio');
	expect(expectOk(await app.blobs.local.stat(id)).size).toBe(5);

	await app.close();
	expect(() => app.blobs.local.add(new Blob(['late']))).toThrow();
});

test('rows reference independently saved blobs and deleting a row leaves bytes intact', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const app = await create();

	const blobId = expectOk(
		await app.blobs.local.add(new Blob(['recorded bytes'])),
	);
	const row = app.device.tables.recordings.create({ audio: blobId });
	app.device.tables.recordings.delete(row.id);
	expect(await expectOk(await app.blobs.local.get(blobId)).text()).toBe(
		'recorded bytes',
	);
	await app.close();
	const reopened = await create();

	expect(reopened.device.tables.recordings.get(row.id)).toBeUndefined();
	expect(
		expectOk(await reopened.blobs.local.list()).items.map((item) => item.id),
	).toContain(blobId);
	await reopened.close();
});

test('repeated close shares completion and permits a fresh open afterward', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const app = await create();

	app.device.tables.notes.create({ title: 'flushed on close' });
	const notes = app.device.tables.notes;
	const persistence = app.device.persistence;
	const encode = app.device.encodeStateSince;
	const closing = app.close();
	expect(app.close()).toBe(closing);
	expect(() => notes.create({ title: 'too late' })).toThrow();
	expect(() => notes.rows).toThrow();
	expect(() => persistence.get()).toThrow();
	expect(() => persistence.subscribe(() => {})).toThrow();
	expect(() => encode()).toThrow();
	await closing;

	const reopened = await create();

	expect(reopened.device.tables.notes.rows[0]?.title).toBe('flushed on close');
	await reopened.close();
});

test('account acquisition hydrates the existing handles and survives refused sync', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const seed = await create();

	seed.device.tables.notes.create({ title: 'from the account' });
	const snapshot = seed.device.encodeStateSince();
	await seed.close();
	let fetches = 0;
	let dials = 0;
	const account: Account = {
		supportsShared: false,
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
	const app = await create(account);
	const notes = app.account!.personal.tables.notes;
	expect(app.account!.identity).toEqual({
		authorityId: 'test-authority',
		principalId: account.principalId,
	});

	expect(app.account!.personal.tables.notes).toBe(notes);
	expect(notes.rows[0]?.title).toBe('from the account');
	expect(fetches).toBe(1);
	expect(dials).toBe(1);
	notes.create({ title: 'still editable' });
	await app.close();

	const reopened = await create(account);

	expect(fetches).toBe(1);
	expect(reopened.account!.personal.tables.notes.rows).toHaveLength(2);
	await reopened.close();
});

test('invalid definitions throw before opening storage', async () => {
	// Runtime validation also refuses defaults hidden by a broad schema type.
	const invalid = () =>
		defineApp({
			id: 'so.epicenter.app-test',
			tables: {},
			kv: {
				name: { ...field.string(), default: 'invalid' } as ReturnType<
					typeof field.string
				>,
			},
		});
	expect(invalid).toThrow();
});

test('physical SQL close retains the App claim across schema variants', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let acquisitions = 0;
	const owner: DeviceSqliteOwner = {
		async acquire(appId) {
			acquisitions++;
			const lifetime = await testSqlite.acquire(appId);
			return {
				...lifetime,
				async close() {
					started.resolve();
					await released.promise;
				},
			};
		},
	};
	const firstDefinition = defineApp({
		...definition,
		id: 'so.epicenter.app-test',
	});
	const first = await openApp(firstDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: owner,
			ai: { runtime: null, account: null },
		},
	});

	const siblingDefinition = defineApp({
		id: 'so.epicenter.sibling',
		tables: {},
		kv: {},
	});
	const sibling = () =>
		openApp(defineApp({ ...siblingDefinition, id: 'so.epicenter.app-test' }), {
			account: undefined,
			runtime: {
				...runtime,
				sqlite: owner,
				ai: { runtime: null, account: null },
			},
		});
	const duplicate = sibling();
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

	expectOk(await first.device.sqlite.open('search'));
	const closing = first.close();
	try {
		await started.promise;
		const duringClose = sibling();
		await expect(duringClose).rejects.toMatchObject({ name: 'AlreadyOpen' });

		expect(acquisitions).toBe(1);
	} finally {
		released.resolve();
		await closing;
	}
	const reopened = await sibling();

	expectOk(await reopened.device.sqlite.open('search'));
	expect(acquisitions).toBe(2);
	await reopened.close();
});

test('failed durable release still closes SQL and retains the common App claim', async () => {
	const runtime = createMemoryRuntime();
	const acquireData = runtime.data;
	runtime.data = async (...args) => {
		const result = await acquireData(...args);
		if (result.error) return result;
		return Ok({
			...result.data,
			dispose() {
				throw new Error('Durable close failed');
			},
		});
	};
	const appId = `test.${crypto.randomUUID()}`;
	let sqlCloses = 0;
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
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
				ai: { runtime: null, account: null },
			},
		});
	const app = await openFixture();

	expectOk(await app.device.sqlite.open('search'));

	await expect(app.close()).rejects.toThrow('Durable close failed');
	expect(sqlCloses).toBe(1);
	const duplicate = openFixture();
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

	// Failed disposal intentionally retains this isolated runtime's admission.
});

test('failed bootstrap cleanup retains App ownership without acquiring SQL', async () => {
	const runtime = createMemoryRuntime();
	const acquireData = runtime.data;
	runtime.data = async (...args) => {
		const result = await acquireData(...args);
		if (result.error) return result;
		return Ok({
			...result.data,
			loaded: { ...result.data.loaded, updates: [new Uint8Array([255])] },
			dispose() {
				throw new Error('Bootstrap close failed');
			},
		});
	};
	const appId = `test.${crypto.randomUUID()}`;
	let sqlCloses = 0;
	let sqlAcquisitions = 0;
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				sqlite: {
					async acquire(...args) {
						sqlAcquisitions++;
						const lifetime = await testSqlite.acquire(...args);
						return {
							...lifetime,
							async close() {
								sqlCloses++;
							},
						};
					},
				},
				ai: { runtime: null, account: null },
			},
		});

	const app = openFixture();
	await expect(app).rejects.toBeInstanceOf(AggregateError);
	expect(sqlCloses).toBe(0);
	expect(sqlAcquisitions).toBe(0);
	const duplicate = openFixture();
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

	// Failed disposal intentionally retains this isolated runtime's admission.
});

test('close drains retained AI response work before releasing storage', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const released: string[] = [];
	let signal: AbortSignal | null | undefined;
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.capability-test',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire('so.epicenter.capability-test')),
					close: async () => {
						released.push('storage');
					},
				}),
			},
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
		},
	});
	const client = app.device.connections.runtime!.client;
	expect(app.device.connections.custom).toBeNull();

	expectOk(await app.device.sqlite.open('search'));
	const request = (async () => await client.models.list())();
	void request.catch(() => {});
	await started.promise;
	const closing = app.close();
	expect(signal?.aborted).toBe(true);
	await expect((async () => await client.models.list())()).rejects.toThrow();
	expect(app.close()).toBe(closing);
	expect(released).toEqual(['storage']);
	drain.resolve();
	await closing;
	await expect(request).rejects.toThrow();
	expect(released).toEqual(['storage', 'capability']);
});

test.each([
	'recording',
	'capability',
] as const)('close waits for both producers when %s cleanup fails', async (failing) => {
	const runtime = createMemoryRuntime();
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let released = false;
	let settled = false;
	const appId = 'test.' + crypto.randomUUID();
	const appDefinition = defineApp({ ...definition, id: appId });
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: {
				acquire: async () => ({
					...(await testSqlite.acquire(appId)),
					close: async () => {
						released = true;
					},
				}),
			},
			recording: (id, options) => ({
				...createBrowserRecording(id, options),
				close: async () => {
					if (failing === 'recording') throw new Error('recording failed');
					await drain.promise;
				},
			}),
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
				connections: () => ({
					...createAiConnections({
						storageKey: appId,
						storage: { getItem: () => null, setItem() {} },
					}),
					close() {
						if (failing === 'capability') throw new Error('capability failed');
					},
				}),
			},
		},
	});

	expectOk(await app.device.sqlite.open('search'));
	const request = (async () =>
		await app.device.connections.runtime!.client.models.list())();
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
	expect(released).toBe(true);
});

test('one captured Account supplies data and AI; local opening never borrows it', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const appId = 'test.' + crypto.randomUUID();
	const supplied: Account[] = [];
	let inferenceRequests = 0;
	const fetchGeneration = createGenerationFetch();
	const account: Account = {
		supportsShared: false,
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
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				ai: {
					runtime: null,
					account: (captured) => {
						supplied.push(captured);
						return { baseURL: `${captured.baseURL}/v1`, fetch: captured.fetch };
					},
				},
			},
		});
	const local = await openFixture();
	expect(local.account).toBeUndefined();
	expect(supplied).toEqual([]);

	await local.close();
	const app = await openFixture(account);
	const retained = (app.account?.connection ?? null)!.client;
	expect(supplied[0]).toBe(account);

	expect(app.account!.identity?.principalId).toBe(asPrincipalId('alice'));
	expect(supplied[0]?.principalId).toBe(asPrincipalId('alice'));
	await retained.models.list();
	expect(inferenceRequests).toBe(1);
	await app.close();
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	expect(inferenceRequests).toBe(1);
});

test('SQL acquisition failure does not block App readiness and close still retires SDK clients', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	let requests = 0;
	const appDefinition = defineApp({
		...definition,
		id: 'test.' + crypto.randomUUID(),
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			sqlite: {
				acquire: async () => {
					throw new Error('storage unavailable');
				},
			},
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
		},
	});
	const retained = app.device.connections.runtime!.client;

	expectErr(await app.device.sqlite.open('unavailable'));
	await app.close();
	await expect((async () => await retained.models.list())()).rejects.toThrow();
	expect(requests).toBe(0);
	await app.close();
});

test('App secrets survive closure and reopen but refuse retained closed use', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const create = (account?: Account) =>
		openApp(definition, { account, runtime });
	const label = secretLabel('gmail');
	const app = await create();

	expectOk(await app.device.secrets.put(label, 'kept'));
	await app.close();
	expect(() => app.device.secrets.get(label)).toThrow();
	expect(() => app.device.secrets.delete(label)).toThrow();
	const reopened = await create();

	expect(expectOk(await reopened.device.secrets.get(label))).toBe('kept');
	expectOk(await reopened.device.secrets.delete(label));
	await reopened.close();
});

test('App close drains admitted secret writes before releasing its SQL lifetime', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const write = Promise.withResolvers<void>();
	let backingClosed = false;
	let writes = 0;
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.secret-drain',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
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
			secrets: (_appId, { assertUsable } = {}) => ({
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
			ai: { runtime: null, account: null },
		},
	});

	const saving = app.device.secrets.put(secretLabel('gmail'), 'token');
	expectOk(await app.device.sqlite.delete('unused'));
	const closing = app.close();
	expect(() => app.device.secrets.put(secretLabel('gmail'), 'late')).toThrow();
	await Promise.resolve();
	expect(writes).toBe(1);
	expect(backingClosed).toBe(false);
	write.resolve();
	expectOk(await saving);
	await closing;
	expect(backingClosed).toBe(true);
});

test('a secret operation can reenter close and forwards its storage Result unchanged', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const failure = SecretError.StorageFailed({
		cause: new Error('Keychain unavailable'),
	});
	let closing: Promise<void> | undefined;
	let released = false;
	const appDefinition = defineApp({
		...definition,
		id: 'so.epicenter.secret-reentrant',
	});
	const app = await openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
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
			ai: { runtime: null, account: null },
		},
	});

	expectOk(await app.device.sqlite.delete('unused'));
	const writing = app.device.secrets.put(secretLabel('gmail'), 'token');
	await entered.promise;
	expect(released).toBe(false);
	release.resolve();
	expect(await writing).toBe(failure);
	await closing;
	expect(released).toBe(true);
});

test('a late capability constructor failure prevents scheduled acquisition and prior capabilities', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const appId = `test.${crypto.randomUUID()}`;
	const released = Promise.withResolvers<void>();
	const events: string[] = [];
	const failure = new Error('Secrets construction failed');
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				sqlite: {
					acquire: async () => ({
						...(await testSqlite.acquire(appId)),
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
				ai: {
					account: null,
					runtime: null,
					connections: () => ({
						...createAiConnections({
							storageKey: appId,
							storage: { getItem: () => null, setItem() {} },
						}),
						close() {
							events.push('ai');
						},
					}),
				},
			},
		});
	await expect(openFixture()).rejects.toBe(failure);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(events).toContain('recording');
	expect(events).not.toContain('ai');
	expect(events).not.toContain('storage');
	const nextDefinition = defineApp({ ...definition, id: appId });
	const next = await openApp(nextDefinition, {
		account: undefined,
		runtime: {
			...runtime,
			ai: { runtime: null, account: null },
		},
	});

	await next.close();
});

test.each([
	false,
	true,
])('failed opening cleans the recorder and preserves the cause when cleanup fails=%s', async (cleanupFails) => {
	const runtime = createMemoryRuntime();
	const appId = `test.${crypto.randomUUID()}`;
	let cleanupAttempted = false;
	let sqlClosed = false;
	const cleanupFailure = new Error('Capture release failed');
	const account: Account = {
		supportsShared: false,
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
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				sqlite: {
					acquire: async () => ({
						...(await testSqlite.acquire(appId)),
						close: async () => {
							sqlClosed = true;
						},
					}),
				},
				recording: (id, options) => ({
					...createBrowserRecording(id, options),
					async close() {
						cleanupAttempted = true;
						if (cleanupFails) throw cleanupFailure;
					},
				}),
				ai: { runtime: null, account: null },
			},
		});
	const failure: unknown = await openFixture(account).catch((error) => error);
	expect(cleanupAttempted).toBe(true);
	expect(sqlClosed).toBe(false);
	if (cleanupFails) {
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).cause).toMatchObject({
			name: 'StorageFailed',
		});
		expect((failure as AggregateError).errors).toContain(cleanupFailure);
		await expect(openFixture(account)).rejects.toMatchObject({
			name: 'AlreadyOpen',
		});
		await expect(runtime.dispose()).rejects.toThrow('open Apps');
	} else {
		expect(failure).toMatchObject({ name: 'StorageFailed' });
		await runtime.dispose();
	}
});

test('failed recorder cleanup still drains SQL and keeps the claim after drain', async () => {
	const runtime = createMemoryRuntime();
	const appId = `test.${crypto.randomUUID()}`;
	const write = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const failure = new Error('Recorder cleanup failed');
	let released = false;
	let settled = false;
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				sqlite: {
					async acquire(id) {
						const lifetime = await testSqlite.acquire(id);
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
				ai: { runtime: null, account: null },
			},
		});
	const app = await openFixture();

	for (const capability of [
		app.device.sqlite,
		app.blobs,
		app.device.secrets,
		app.device.recording,
	]) {
		expect(Object.hasOwn(capability, 'close')).toBe(false);
		expect(Object.hasOwn(capability, 'acquire')).toBe(false);
	}
	const database = expectOk(await app.device.sqlite.open('cache'));
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
	expect(released).toBe(true);
	const duplicate = openFixture();
	await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });
});

test('App retirement closes its recorder while retaining the App claim after terminal invalidation failure', async () => {
	const runtime = createMemoryRuntime();
	const appId = `test.${crypto.randomUUID()}`;
	const events = new EventTarget();
	const socket = Object.assign(events, {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
	}) as unknown as WebSocket;
	const invalidation = Promise.withResolvers<void>();
	let disposed = 0;
	let recorderCloses = 0;
	const account: Account = {
		supportsShared: false,
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
	const acquireData = runtime.data;
	runtime.data = async (definition, options) =>
		options.scope === 'device'
			? acquireData(definition, options)
			: Ok({
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
				});
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
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
				ai: { runtime: null, account: null },
			},
		});
	const app = await openFixture(account);
	try {
		await Bun.sleep(0);
		expect(app.signal.aborted).toBe(false);
		events.dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
		expect(app.signal.aborted).toBe(true);
		await new Promise<void>((resolve) => {
			if (app.signal.aborted) resolve();
			else
				app.signal.addEventListener('abort', () => resolve(), { once: true });
		});
		expect(recorderCloses).toBe(1);
		expect(disposed).toBe(0);
		expect(() =>
			app.account!.personal.tables.notes.create({ title: 'late' }),
		).toThrow();
		invalidation.reject(new Error('Invalidation failed'));
		await expect(app.close()).rejects.toThrow('Invalidation failed');
		expect(disposed).toBe(0);
		const duplicate = openFixture(account);
		await expect(duplicate).rejects.toMatchObject({ name: 'AlreadyOpen' });

		const terminal = app.close();
		expect(app.close()).toBe(terminal);
		await expect(terminal).rejects.toThrow('Invalidation failed');
		expect(disposed).toBe(0);
		await expect(runtime.dispose()).rejects.toThrow('open Apps');
	} finally {
		invalidation.resolve();
		await app.close().catch(() => {});
	}
});

test('App retirement during attachment refuses readiness without auto-releasing its backing', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
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
		supportsShared: false,
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
	const acquireData = runtime.data;
	runtime.data = async (definition, options) =>
		options.scope === 'device'
			? acquireData(definition, options)
			: Ok({
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
				});
	const appDefinition = defineApp({
		...definition,
		id: `test.${crypto.randomUUID()}`,
	});
	const app = openApp(appDefinition, {
		account,
		runtime: {
			...runtime,
			ai: { runtime: null, account: null },
		},
	});
	void app.catch(() => {});
	await Bun.sleep(0);
	expect(disposed).toBe(0);
	invalidation.resolve();
	await expect(app).rejects.toMatchObject({ name: 'ClosedWhileOpening' });
	expect(disposed).toBe(1);
});

test('replacing the Account cannot submit Alice pending Personal edits as Bob', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const { createSessionAuth } = await import('@epicenter/auth');
	const { decodeFrame } = await import('./data/sync/frames.js');
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
	const fixtureDefinition = defineApp({ ...definition, id: appId });
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime: {
				...runtime,
				ai: { runtime: null, account: null },
			},
		});
	const state = auth.state;
	if (state.status === 'signed-out') throw new Error('Expected cached Alice');
	const alice = state.account;
	const first = await openFixture(alice);

	first.account!.personal.tables.notes.create({
		title: 'Alice pending private queue',
	});
	person = 'bob';
	expectOk(await auth.startSignIn());
	await first.close();
	await expect(alice.fetch('/api/session')).rejects.toMatchObject({
		name: 'AbortError',
	});
	const bobState = auth.state;
	if (bobState.status === 'signed-out') throw new Error('Expected Bob');
	const second = await openFixture(bobState.account);
	try {
		expect(second.account!.personal.tables.notes.rows).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(submissions).toEqual([]);
	} finally {
		await second.close();
		auth[Symbol.dispose]();
	}
});
