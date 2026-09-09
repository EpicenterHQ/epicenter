/**
 * What `defineApplication` decides before it acquires anything.
 *
 * Checks lazy declaration, default storage and settings, independent runtime and
 * AI replacement, and definition inference through the public declaration.
 */

import 'fake-indexeddb/auto';
import { expect, test, spyOn } from 'bun:test';
import { resources } from '#platform/resources';
import { installTestLocks } from '@epicenter/device/test-locks';
import { expectOk } from 'wellcrafted/testing';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { defineApplication } from './index.js';
import { browser, createBrowserAppBlobs } from './browser.js';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { Ok } from 'wellcrafted/result';

installTestLocks();

const sqlite: DeviceSqliteOwner = {
	acquire: async () => ({
		open: async () => ({
			query: async () => Ok({ columns: [], rows: [], truncated: false }),
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			batch: async () => Ok({ changes: [] }),
		}),
		delete: async () => undefined,

		close: async () => undefined,
	}),
};
const blobs = createBrowserAppBlobs();

const definition = defineData({ id: 'so.epicenter.notes', tables: {}, kv: {} });

test('the application id is explicit and independent from the definition id', () => {
	// The opening application is its own segment of the store address
	// (ADR-0324), so a reader application opening the notes definition is a
	// different replica rather than the same one under another name.
	expect(
		defineApplication({
			appId: 'so.epicenter.notes',
			definition,
			runtime: {
				...browser,
				sqlite,
				blobs,
			},
			ai: { runtime: null, account: null },
		}).appId,
	).toBe('so.epicenter.notes');
	expect(
		defineApplication({
			appId: 'so.epicenter.reader',
			definition,
			runtime: {
				...browser,
				sqlite,
				blobs,
			},
			ai: { runtime: null, account: null },
		}).appId,
	).toBe('so.epicenter.reader');
});

test('an application id this platform cannot file refuses at construction', () => {
	// It throws rather than answering a `Result`, because an id reaching this
	// is a constant in a build and a wrong one is a bug, not a condition.
	expect(() =>
		defineApplication({
			appId: 'not an app id',
			definition,
			runtime: {
				...browser,
				sqlite,
				blobs,
			},
			ai: { runtime: null, account: null },
		}),
	).toThrow('is not valid');
});

test('declaring the default application acquires neither browser storage nor AI settings', async () => {
	const acquire = spyOn(resources.sqlite, 'acquire');
	try {
		const application = defineApplication({
			appId: 'test.' + crypto.randomUUID(),
			definition,
		});
		expect(application.appId).toStartWith('test.');
		expect(acquire).not.toHaveBeenCalled();
	} finally {
		acquire.mockRestore();
	}
});

test.each([
	undefined,
	'legacy-settings',
])('default resources preserve browser blob storage and AI settings key %s', async (settingsKey) => {
	const appId = 'test.' + crypto.randomUUID();
	const stored = new Map<string, string>();
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => stored.get(key) ?? null,
				setItem: (key: string, value: string) => stored.set(key, value),
				removeItem: (key: string) => stored.delete(key),
			},
			addEventListener() {},
			removeEventListener() {},
		},
	});
	const acquire = spyOn(resources.sqlite, 'acquire').mockImplementation(
		sqlite.acquire,
	);
	const application = defineApplication({ appId, definition, settingsKey });
	const app = application.openLocal();
	try {
		expectOk(await app.ready);
		expect(acquire).toHaveBeenCalledWith(appId, { library: 'local' });
		const blobId = expectOk(await app.blobs.add(new Blob(['default bytes'])));
		expect(await expectOk(await app.blobs.get(blobId)).text()).toBe(
			'default bytes',
		);
		app.ai.configuration!.add({ baseUrl: 'https://inference.example/v1' });
		expect([...stored.keys()]).toEqual([`${settingsKey ?? appId}.app-ai`]);
		await app.close();
		const reopened = application.openLocal();
		try {
			expectOk(await reopened.ready);
			expect(await expectOk(await reopened.blobs.get(blobId)).text()).toBe(
				'default bytes',
			);
			expect(reopened.ai.configuration!.read()).toHaveLength(1);
		} finally {
			await reopened.close();
		}
	} finally {
		await app.close();
		acquire.mockRestore();
		if (previousWindow)
			Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});

test('an explicit runtime selects all resources while explicit AI omits default configuration', async () => {
	const calls: string[] = [];
	const appId = 'test.' + crypto.randomUUID();
	const application = defineApplication({
		appId,
		definition,
		runtime: {
			sqlite: {
				async acquire(id, account) {
					calls.push('sqlite');
					return sqlite.acquire(id, account);
				},
			},
			blobs(input) {
				calls.push('blobs');
				return browser.blobs(input);
			},
			secrets(...args) {
				calls.push('secrets');
				return browser.secrets(...args);
			},
			recording(...args) {
				calls.push('recording');
				return browser.recording(...args);
			},
		},
		ai: { runtime: null, account: null },
	});
	expect(calls).toEqual([]);
	const app = application.openLocal();
	try {
		expectOk(await app.ready);
		expect(calls.sort()).toEqual(['blobs', 'recording', 'secrets', 'sqlite']);
		expect(app.ai.configuration).toBeNull();
		expect(app.ai.account).toBeNull();
		expect(app.ai.runtime).toBeNull();
	} finally {
		await app.close();
	}
});

test('definition inference retains table and field names through a runtime override', async () => {
	const application = defineApplication({
		appId: 'test.' + crypto.randomUUID(),
		definition: defineData({
			id: 'test.inference',
			tables: { notes: defineTable({ title: field.string() }) },
			kv: {},
		}),
		runtime: { ...browser, sqlite },
		ai: { runtime: null, account: null },
	});
	const app = application.openLocal();
	try {
		expectOk(await app.ready);
		app.tables.notes.create({ title: 'Typed title' });
		const title: string = app.tables.notes.rows[0]!.title;
		expect(title).toBe('Typed title');
		if (false) {
			// @ts-expect-error: definition has no tasks table.
			app.tables.tasks;
			// @ts-expect-error: title is a string field.
			app.tables.notes.create({ title: 12 });
		}
	} finally {
		await app.close();
	}
});
