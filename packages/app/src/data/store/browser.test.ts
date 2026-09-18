/**
 * Browser App durability and ownership regressions.
 * Current and local addresses remain stable, account data reopens offline, and
 * historical caches remain byte-for-byte untouched. Native IndexedDB request
 * failures must roll back and release acquired connections.
 */
import 'fake-indexeddb/auto';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { defineApp, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { openApp } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { claimApp } from '@epicenter/device/library-claim';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { openDB } from 'idb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { acquireAppData, openIdbBacking } from './browser.js';

installTestLocks();
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
	return defineApp({
		id: `so.epicenter.browsertest.${crypto.randomUUID()}`,
		kv: {},
		tables: {
			notes: defineTable({ title: field.string(), content: plainText() }),
		},
	});
}
function accountFor(person = 'alice'): Account {
	return {
		authorityId: 'test-authority',
		principalId: asPrincipalId(person),
		baseURL: 'https://browser.test',
		supportsShared: false,
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
	const local = openApp(definition);
	expectOk(await local.ready);
	await local.close();
	const app = openApp(definition, { account: accountFor() });
	try {
		expectOk(await app.ready);
		const names = (await indexedDB.databases()).map(({ name }) => name);
		expect(names).toContain(localAddress(definition.id));
		expect(names).toContain(currentAddress(definition.id));
	} finally {
		await app.close();
	}
});

test('a second App cannot acquire an open library and can retry after closure', async () => {
	const definition = definitionFor();
	const account = accountFor();
	const first = openApp(definition, { account: account });
	expectOk(await first.ready);
	const second = openApp(definition, { account: account });
	expect(expectErr(await second.ready).name).toBe('AlreadyOpen');
	await second.close();
	await first.close();
	const third = openApp(definition, { account: account });
	expectOk(await third.ready);
	await third.close();
});

test('different applications and accounts cannot read each others rows', async () => {
	const definition = definitionFor();
	const first = openApp(definition, { account: accountFor() });
	expectOk(await first.ready);
	first.account.personal.tables.notes.create({ title: 'Alice kept work' });
	await first.close();
	for (const [declaration, account] of [
		[definition, accountFor('bob')],
		[definitionFor(), accountFor()],
	] as const) {
		const isolated = openApp(declaration, { account: account });
		expectOk(await isolated.ready);
		expect(isolated.account.personal.tables.notes.rows).toHaveLength(0);
		await isolated.close();
	}
	const offline = accountFor();
	offline.fetch = async () => {
		throw new Error('Offline');
	};
	const reopened = openApp(definition, { account: offline });
	expectOk(await reopened.ready);
	expect(
		reopened.account.personal.tables.notes.rows.map((row) => row.title),
	).toEqual(['Alice kept work']);
	await reopened.close();
});

test('a failed current bootstrap releases ownership and a later attempt hydrates', async () => {
	const definition = definitionFor();
	const unavailable = accountFor();
	unavailable.fetch = async () => new Response(null, { status: 503 });
	const failed = openApp(definition, { account: unavailable });
	expect(expectErr(await failed.ready).name).toBe('StorageFailed');
	await failed.close();
	const retry = openApp(definition, { account: accountFor() });
	expectOk(await retry.ready);
	expect(retry.account.personal.tables.notes.rows).toHaveLength(0);
	await retry.close();
});

test('invalid account segments never create a current cache', async () => {
	const definition = definitionFor();
	const parsed = expectOk(compileData(definition));
	const before = await indexedDB.databases();
	for (const person of ['', 'alice/../bob', '.', '..']) {
		expect(
			expectErr(
				await acquireAppData(parsed, {
					appId: definition.id,
					library: 'personal',
					account: accountFor(person),
				}),
			).name,
		).toBe('Unaddressable');
	}
	expect(await indexedDB.databases()).toEqual(before);
});

test('a runtime without Web Locks refuses App opening before storage acquisition', async () => {
	const definition = definitionFor();
	const held = Object.getOwnPropertyDescriptor(navigator, 'locks');
	if (!held) throw new Error('The test must install Web Locks');
	Reflect.deleteProperty(navigator, 'locks');
	try {
		const app = openApp(definition);
		expect(expectErr(await app.ready).name).toBe('LocksUnsupported');
		await app.close();
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
		const database = await openDB(address, 1, {
			upgrade(database) {
				database.createObjectStore('proof');
			},
		});
		await database.put('proof', payload, 'untouched');
		database.close();
	}
	const app = openApp(definition, { account: accountFor() });
	expectOk(await app.ready);
	expect(app.account.personal.tables.notes.rows).toHaveLength(0);
	await app.close();
	for (const address of historical) {
		const database = await openDB(address, 1);
		expect(await database.get('proof', 'untouched')).toEqual(payload);
		database.close();
	}
});

test('local content text and attributes survive a close and reopen', async () => {
	const definition = definitionFor();
	const first = openApp(definition);
	expectOk(await first.ready);
	const row = first.device.tables.notes.create({ title: 'x' });
	row.content.applyDelta(row.content.change.insert('buy milk') as never);
	row.content.setAttr('cursor' as never, 8 as never);
	await first.close();
	const reopened = openApp(definition);
	try {
		expectOk(await reopened.ready);
		const content = reopened.device.tables.notes.get(row.id)?.content;
		expect(content?.toString()).toContain('buy milk');
		expect(content?.getAttr('cursor' as never)).toBe(8);
	} finally {
		await reopened.close();
	}
});

test('owed updates compact without losing rows across an offline reopen', async () => {
	const definition = definitionFor();
	const app = openApp(definition, { account: accountFor() });
	expectOk(await app.ready);
	for (let index = 0; index < 70; index++) {
		app.account.personal.tables.notes.create({ title: `note ${index}` });
		await app.account.personal.persistence.flush();
	}
	await app.close();
	const database = await openDB(currentAddress(definition.id), 1);
	expect(await database.count('updates')).toBeLessThan(70);
	database.close();
	const offline = accountFor();
	offline.fetch = async () => {
		throw new Error('Offline');
	};
	const reopened = openApp(definition, { account: offline });
	expectOk(await reopened.ready);
	expect(reopened.account.personal.tables.notes.rows).toHaveLength(70);
	await reopened.close();
});

test('corrupt local bytes refuse every retry without retaining ownership', async () => {
	const definition = definitionFor();
	const backing = expectOk(await openIdbBacking(localAddress(definition.id)));
	await backing.create({ bytes: new Uint8Array([1, 2, 3, 4, 5]), position: 0 });
	backing.close();
	for (let attempt = 0; attempt < 2; attempt++) {
		const app = openApp(definition);
		expect(expectErr(await app.ready).name).toBe('StorageFailed');
		await app.close();
	}
});

test('failed local acquisition cleanup retains library exclusion', async () => {
	const definition = definitionFor();
	const closing = spyOn(IDBDatabase.prototype, 'close').mockImplementation(
		() => {
			throw new Error('Cleanup failed');
		},
	);
	try {
		const app = openApp(definition);
		expect(expectErr(await app.ready).name).toBe('StorageFailed');
		expect(expectErr(await claimApp(definition.id)).name).toBe('AlreadyOpen');
		await app.close();
		expect(expectErr(await claimApp(definition.id)).name).toBe('AlreadyOpen');
	} finally {
		closing.mockRestore();
	}
});

test('a request failure remains inside the commit rejection and rolls back', async () => {
	const backing = expectOk(await openIdbBacking('failed-request-is-contained'));
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
		await openIdbBacking('failed-request-is-contained'),
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
		expect(expectErr(await openIdbBacking(address)).name).toBe('StorageFailed');
		expect(closing).toHaveBeenCalledTimes(1);
	} finally {
		read.mockRestore();
		closing.mockRestore();
	}
	expectOk(await openIdbBacking(address)).close();
});
