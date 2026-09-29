/**
 * Browser App durability and ownership regressions.
 * Current and local addresses remain stable, account data reopens offline, and
 * historical caches remain byte-for-byte untouched. Native IndexedDB request
 * failures must roll back and release acquired connections.
 */
import 'fake-indexeddb/auto';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { openLocal, openPersonal } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { claimApp } from '@epicenter/device/app-claim';
import { createMemorySqliteOwner } from '@epicenter/device/memory';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { indexedDbStoreRuntime } from '../../platform/documents.js';
import { acquireStoreData, openIdbBacking } from './browser.js';
import { idbRequest, idbTransactionDone } from './idb-updates.js';

installTestLocks();
const sql = createMemorySqliteOwner();
const runtime = { ...indexedDbStoreRuntime, sqlite: sql.owner.acquire };
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', {
	configurable: true,
	value: Object.assign(new EventTarget(), {
		localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	}),
});
afterAll(() => {
	if (previousWindow)
		Object.defineProperty(globalThis, 'window', previousWindow);
	else Reflect.deleteProperty(globalThis, 'window');
});

function definitionFor() {
	return defineStore({
		id: `so.epicenter.browsertest.${crypto.randomUUID()}`,
		kv: {},
		tables: {
			notes: defineTable({
				fields: { title: field.string() },
				body: plainText(),
			}),
		},
	});
}
function accountFor(person = 'alice'): Account {
	return {
		authorityId: 'test-authority',
		principalId: asPrincipalId(person),
		baseURL: 'https://browser.test',
		async fetch(_input, init) {
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await new Response(init?.body).arrayBuffer()),
				},
				tail: [],
			});
		},
		async openWebSocket() {
			return Object.assign(new EventTarget(), {
				readyState: 0,
				close() {},
				send() {},
			}) as unknown as WebSocket;
		},
		async getProfile() {
			throw new Error('This fixture never reads a profile');
		},
	};
}
const currentAddress = (id: string, person = 'alice') =>
	`epicenter/${id}/accounts/test-authority/${person}/data/${id}/personal/current`;
const localAddress = (id: string) =>
	`epicenter/${id}/device/no-account/data/${id}/1`;

// ============================================================================
// Current and local opening
// ============================================================================

test('current and local addresses retain their durable spellings', async () => {
	const definition = definitionFor();
	const local = await openLocal(definition, { runtime });

	await local.close();
	const app = await openPersonal(definition, {
		runtime,
		account: accountFor(),
	});
	try {
		const names = (await indexedDB.databases()).map(({ name }) => name);
		expect(names).toContain(localAddress(definition.id));
		expect(names).toContain(currentAddress(definition.id));
	} finally {
		await app.close();
	}
});

test('a second Personal cannot acquire an open Personal and can retry after closure', async () => {
	const definition = definitionFor();
	const account = accountFor();
	const first = await openPersonal(definition, { runtime, account: account });

	const second = openPersonal(definition, { runtime, account: account });
	await expect(second).rejects.toMatchObject({ name: 'AlreadyOpen' });

	await first.close();
	const third = await openPersonal(definition, { runtime, account: account });

	await third.close();
});

test('different applications and accounts cannot read each others rows', async () => {
	const definition = definitionFor();
	const first = await openPersonal(definition, {
		runtime,
		account: accountFor(),
	});

	first.tables.notes.create({ title: 'Alice kept work' });
	await first.close();
	for (const [declaration, account] of [
		[definition, accountFor('bob')],
		[definitionFor(), accountFor()],
	] as const) {
		const isolated = await openPersonal(declaration, {
			runtime,
			account: account,
		});

		expect(isolated.tables.notes.rows).toHaveLength(0);
		await isolated.close();
	}
	const offline = accountFor();
	offline.fetch = async () => {
		throw new Error('Offline');
	};
	const reopened = await openPersonal(definition, {
		runtime,
		account: offline,
	});

	expect(reopened.tables.notes.rows.map((row) => row.title)).toEqual([
		'Alice kept work',
	]);
	await reopened.close();
});

test('a failed current bootstrap releases ownership and a later attempt hydrates', async () => {
	const definition = definitionFor();
	const unavailable = accountFor();
	unavailable.fetch = async () => new Response(null, { status: 503 });
	const failed = openPersonal(definition, { runtime, account: unavailable });
	await expect(failed).rejects.toMatchObject({ name: 'StorageFailed' });

	const retry = await openPersonal(definition, {
		runtime,
		account: accountFor(),
	});

	expect(retry.tables.notes.rows).toHaveLength(0);
	await retry.close();
});

test('invalid account segments never create a current cache', async () => {
	const definition = definitionFor();
	const parsed = expectOk(compileData(definition));
	const before = await indexedDB.databases();
	for (const person of ['', 'alice/../bob', '.', '..']) {
		expect(
			expectErr(
				await acquireStoreData(
					parsed,
					{
						kind: 'personal',
						account: accountFor(person),
					},
					{ factory: indexedDB, keyRange: IDBKeyRange },
				),
			).name,
		).toBe('Unaddressable');
	}
	expect(await indexedDB.databases()).toEqual(before);
});

test('a runtime without Web Locks refuses Local opening before storage acquisition', async () => {
	const definition = definitionFor();
	const held = Object.getOwnPropertyDescriptor(navigator, 'locks');
	if (!held) throw new Error('The test must install Web Locks');
	Reflect.deleteProperty(navigator, 'locks');
	try {
		const app = openLocal(definition, { runtime });
		await expect(app).rejects.toMatchObject({ name: 'LocksUnsupported' });

		expect((await indexedDB.databases()).map(({ name }) => name)).not.toContain(
			localAddress(definition.id),
		);
	} finally {
		Object.defineProperty(navigator, 'locks', held);
	}
});

// ============================================================================
// Persisted bytes and failure containment
// ============================================================================

test('opening leaves historical numbered and superseded caches untouched', async () => {
	const definition = definitionFor();
	const historical = [
		`epicenter/${definition.id}/accounts/test-authority/alice/data/${definition.id}/1`,
		`epicenter/v4/${definition.id}/${definition.id}/1`,
		`epicenter/${definition.id}/private`,
	];
	const payload = new Uint8Array([7, 8, 9]);
	for (const address of historical) {
		const opening = indexedDB.open(address, 1);
		opening.onupgradeneeded = () => opening.result.createObjectStore('proof');
		const database = await idbRequest(opening);
		const write = database.transaction('proof', 'readwrite');
		const done = idbTransactionDone(write);
		write.objectStore('proof').put(payload, 'untouched');
		await done;
		database.close();
	}
	const app = await openPersonal(definition, {
		runtime,
		account: accountFor(),
	});

	expect(app.tables.notes.rows).toHaveLength(0);
	await app.close();
	for (const address of historical) {
		const database = await idbRequest(indexedDB.open(address, 1));
		expect(
			await idbRequest(
				database.transaction('proof').objectStore('proof').get('untouched'),
			),
		).toEqual(payload);
		database.close();
	}
});

test('local body text and attributes survive a close and reopen', async () => {
	const definition = definitionFor();
	const first = await openLocal(definition, { runtime });

	const row = first.tables.notes.create({ title: 'x' });
	first.tables.notes
		.body(row.id)!
		.applyDelta(
			first.tables.notes.body(row.id)!.change.insert('buy milk') as never,
		);
	first.tables.notes.body(row.id)!.setAttr('cursor' as never, 8 as never);
	await first.close();
	const reopened = await openLocal(definition, { runtime });
	try {
		const body = reopened.tables.notes.body(row.id);
		expect(body?.toString()).toContain('buy milk');
		expect(body?.getAttr('cursor' as never)).toBe(8);
	} finally {
		await reopened.close();
	}
});

test('owed updates compact without losing rows across an offline reopen', async () => {
	const definition = definitionFor();
	const app = await openPersonal(definition, {
		runtime,
		account: accountFor(),
	});

	for (let index = 0; index < 70; index++) {
		app.tables.notes.create({ title: `note ${index}` });
		await app.persistence.flush();
	}
	await app.close();
	const database = await idbRequest(
		indexedDB.open(currentAddress(definition.id), 1),
	);
	expect(
		await idbRequest(
			database.transaction('updates').objectStore('updates').count(),
		),
	).toBeLessThan(70);
	database.close();
	const offline = accountFor();
	offline.fetch = async () => {
		throw new Error('Offline');
	};
	const reopened = await openPersonal(definition, {
		runtime,
		account: offline,
	});

	expect(reopened.tables.notes.rows).toHaveLength(70);
	await reopened.close();
});

test('corrupt local bytes refuse every retry without retaining ownership', async () => {
	const definition = definitionFor();
	const backing = expectOk(
		await openIdbBacking(localAddress(definition.id), {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	await backing.create({ bytes: new Uint8Array([1, 2, 3, 4, 5]), position: 0 });
	backing.close();
	for (let attempt = 0; attempt < 2; attempt++) {
		const app = openLocal(definition, { runtime });
		await expect(app).rejects.toMatchObject({ name: 'StorageFailed' });
	}
});

test('failed acquisition cleanup retains Local exclusion and both failures', async () => {
	const definition = definitionFor();
	const closing = spyOn(IDBDatabase.prototype, 'close').mockImplementation(
		() => {
			throw new Error('Cleanup failed');
		},
	);
	try {
		const failure: unknown = await openLocal(definition, { runtime }).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		const failures: unknown[] = [];
		function collect(cause: unknown) {
			failures.push(cause);
			if (cause instanceof AggregateError) cause.errors.forEach(collect);
			if (cause instanceof Error && cause.cause) collect(cause.cause);
		}
		collect(failure);
		expect(
			failures.some(
				(cause) =>
					typeof cause === 'object' &&
					cause !== null &&
					'name' in cause &&
					['StorageFailed', 'BlobStoreFailed'].includes(String(cause.name)),
			),
		).toBe(true);
		expect(failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ message: 'Cleanup failed' }),
			]),
		);
		expect(expectErr(await claimApp(definition.id)).name).toBe('AlreadyOpen');
	} finally {
		closing.mockRestore();
	}
});

test('a request failure remains inside the commit rejection and rolls back', async () => {
	const backing = expectOk(
		await openIdbBacking('failed-request-is-contained', {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	const put = IDBObjectStore.prototype.put;
	// Force the second valid append to encounter a native request failure.
	// The later ack yields before commit reaches its final settlement await.
	IDBObjectStore.prototype.put = function (value) {
		return this.add(value, 1);
	};
	try {
		await expect(
			backing.port.commit([
				{
					kind: 'append',
					id: 1,
					bytes: new Uint8Array([0, 0]),
					authoritySeq: undefined,
				},
				{
					kind: 'append',
					id: 2,
					bytes: new Uint8Array([0, 0]),
					authoritySeq: undefined,
				},
				{ kind: 'ack', throughId: 2, authoritySeq: 1 },
			]),
		).rejects.toThrow();
	} finally {
		IDBObjectStore.prototype.put = put;
		backing.close();
	}
	const reopened = expectOk(
		await openIdbBacking('failed-request-is-contained', {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	);
	try {
		expect(reopened.loaded.updates).toHaveLength(0);
	} finally {
		reopened.close();
	}
});

test('a backing read failure closes the acquired connection before returning a Result', async () => {
	const address = `test.${crypto.randomUUID()}`;
	const read = spyOn(IDBObjectStore.prototype, 'getAll').mockImplementationOnce(
		() => {
			throw new Error('Read failed');
		},
	);
	const closing = spyOn(IDBDatabase.prototype, 'close');
	try {
		expect(
			expectErr(
				await openIdbBacking(address, {
					factory: indexedDB,
					keyRange: IDBKeyRange,
				}),
			).name,
		).toBe('StorageFailed');
		expect(closing).toHaveBeenCalledTimes(1);
	} finally {
		read.mockRestore();
		closing.mockRestore();
	}
	expectOk(
		await openIdbBacking(address, {
			factory: indexedDB,
			keyRange: IDBKeyRange,
		}),
	).close();
});
