/**
 * Application handle tests.
 *
 * Verifies the clean-break API owns local acquisition, readiness, and closure.
 * Reopening fake IndexedDB proves rows survive a handle lifetime, not a browser restart.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { asPrincipalId } from '@epicenter/principal';
import { installTestLocks } from '@epicenter/data/test-locks';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { createEpicenter } from './index.js';
import { createBrowserAppBlobs } from './browser.js';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { Ok } from 'wellcrafted/result';

installTestLocks();

const testSqlite: DeviceSqliteOwner = {
	open: async () => ({
		run: async () => Ok({ changes: 0 }),
		all: async () => Ok([]),
		batch: async () => Ok({ changes: [] }),
	}),
	delete: async () => undefined,
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

test('the app SQLite capability follows the captured local or account scope', async () => {
	const scopes: unknown[] = [];
	const owner: DeviceSqliteOwner = {
		open: async (_appId, scope) => {
			scopes.push(scope);
			return {
				run: async () => Ok({ changes: 0 }),
				all: async () => Ok([]),
				batch: async () => Ok({ changes: [] }),
			};
		},
		delete: async () => undefined,
	};
	let requests = 0;
	const account: Account = {
		authorityId: 'test-authority',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch() {
			requests++;
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
	await expect(localApp.sqlite.open('search')).rejects.toThrow(
		'not ready',
	);
	expectOk(await localApp.ready);
	const localDatabase = expectOk(await localApp.sqlite.open('search'));
	const accountApp = epicenter.openAccount(account);
	expectOk(await accountApp.ready);
	await accountApp.sqlite.open('search');
	expect(scopes).toEqual([
		{ kind: 'local' },
		{ kind: 'account', authorityId: 'test-authority', principalId: 'alice' },
	]);
	await localApp.close();
	expect(() => localDatabase.run('select 1')).toThrow('disposed');
	await accountApp.close();
});

test('closing waits for an admitted SQLite delete', async () => {
	let beginDelete!: () => void;
	let releaseDelete!: () => void;
	const deleteStarted = new Promise<void>((resolve) => (beginDelete = resolve));
	const deleteReleased = new Promise<void>((resolve) => (releaseDelete = resolve));
	const owner: DeviceSqliteOwner = {
		open: async () => ({
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			batch: async () => Ok({ changes: [] }),
		}),
		delete: async () => {
			beginDelete();
			await deleteReleased;
		},
	};
	const app = createEpicenter({
		appId: 'so.epicenter.app-test',
		definition,
		sqlite: owner,
		blobs: testBlobs,
	}).openLocal();
	expectOk(await app.ready);
	const deleting = app.sqlite!.delete('search');
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
	const account: Account = {
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch() {
			throw new Error('Must not fetch.');
		},
		async openWebSocket() {
			throw new Error('Must not dial.');
		},
		async getProfile() {
			throw new Error('Must not fetch a profile.');
		},
	};
	expect(() => create().openAccount(account)).toThrow(
		'stable authority identity',
	);
	expect(
		(await indexedDB.databases()).filter(({ name }) =>
			name?.split('/').includes('so.epicenter.app-test'),
		),
	).toEqual([]);
});
