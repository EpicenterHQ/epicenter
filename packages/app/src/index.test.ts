/**
 * What `defineApp` decides before it acquires anything.
 *
 * Checks inert declarations, build-selected resources, and schema inference.
 * Internal composition exercises resource failures and lifetime cleanup.
 */

import 'fake-indexeddb/auto';
import { expect, spyOn, test } from 'bun:test';
import { defineTable, field } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { openMemory } from '@epicenter/app/memory';
import type { Account } from '@epicenter/auth';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { installTestLocks } from '@epicenter/device/test-locks';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { resources } from '#platform/resources';
import { createAiConnections } from './ai-connections.js';
import { composeApp } from './compose.js';
import { defineApp } from './index.js';
import { openApp } from './open.js';
import {
	resources as browser,
	createBrowserAppBlobs,
} from './platform/browser.js';

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

const definition = defineApp({ id: 'so.epicenter.notes', tables: {}, kv: {} });

test('App readiness includes catalog hydration and failed hydration releases the library', async () => {
	const hydrated = Promise.withResolvers<void>();
	const appId = `test.${crypto.randomUUID()}`;
	let released = false;
	const applicationDefinition = defineApp({ ...definition, id: appId });
	const application = (account?: Account) =>
		composeApp(applicationDefinition, {
			appId: applicationDefinition.id,
			account,
			...browser,
			sqlite,
			blobs,
			ai: {
				runtime: null,
				account: null,
				connections() {
					const owner = createAiConnections({
						storageKey: appId,
						storage: { getItem: () => null, setItem() {} },
					});
					return {
						...owner,
						ready: hydrated.promise,
						close() {
							released = true;
							owner.close();
						},
					};
				},
			},
		});
	const app = application();
	let ready = false;
	void app.ready.then(() => {
		ready = true;
	});
	await Bun.sleep(0);
	expect(ready).toBe(false);
	hydrated.reject(new Error('Catalog unavailable.'));
	expect((await app.ready).error).not.toBeNull();
	expect(released).toBe(true);
	await app.close();
	const replacementDefinition = defineApp({ ...definition, id: appId });
	const replacement = composeApp(replacementDefinition, {
		appId: replacementDefinition.id,
		account: undefined,
		...browser,
		sqlite,
		blobs,
		ai: { account: null, runtime: null },
	});
	expectOk(await replacement.ready);
	await replacement.close();
});

test('the declaration exposes one identity and the schema without implementation options', () => {
	const application = defineApp({ ...definition, title: 'Notes' });
	expect(application.id).toBe(definition.id);
	expect(application.title).toBe('Notes');
	expect(application.tables).toBe(definition.tables);
	expect(application.kv).toBe(definition.kv);
	expect(Object.keys(application).sort()).toEqual([
		'id',
		'kv',
		'tables',
		'title',
	]);
	expect(Object.isFrozen(application)).toBe(true);
});

test('an application id this platform cannot file refuses at construction', () => {
	expect(() => defineApp({ ...definition, id: 'not an app id' })).toThrow(
		'is not valid',
	);
});

test('declaring the default application acquires neither browser storage nor AI settings', async () => {
	const acquire = spyOn(resources.sqlite, 'acquire');
	try {
		const application = defineApp({
			...definition,
			id: 'test.' + crypto.randomUUID(),
		});
		expect(application.id).toStartWith('test.');
		expect(acquire).not.toHaveBeenCalled();
	} finally {
		acquire.mockRestore();
	}
});

test('default resources preserve blobs and the no-account AI catalog', async () => {
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
			dispatchEvent() {
				return true;
			},
			addEventListener() {},
			removeEventListener() {},
		},
	});
	const acquire = spyOn(resources.sqlite, 'acquire').mockImplementation(
		sqlite.acquire,
	);
	const application = defineApp({ ...definition, id: appId });
	const app = openApp(application);
	try {
		expectOk(await app.ready);
		expect(acquire).not.toHaveBeenCalled();
		const blobId = expectOk(
			await app.blobs.local.add(new Blob(['default bytes'])),
		);
		expect(await expectOk(await app.blobs.local.get(blobId)).text()).toBe(
			'default bytes',
		);
		await app.device.connections.custom!.add({
			baseUrl: 'https://inference.example/v1',
		});
		expect([...stored.keys()]).toEqual([
			'epicenter/ai/no-account.app-ai-connections',
		]);
		await app.close();
		const reopened = openApp(application);
		try {
			expectOk(await reopened.ready);
			expect(
				await expectOk(await reopened.blobs.local.get(blobId)).text(),
			).toBe('default bytes');
			expect(reopened.device.connections.custom!.getAll()).toHaveLength(1);
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

test('composition uses its resources and explicit AI omits default connections', async () => {
	const calls: string[] = [];
	const appId = 'test.' + crypto.randomUUID();
	const applicationDefinition = defineApp({ ...definition, id: appId });
	const application = (account?: Account) =>
		composeApp(applicationDefinition, {
			appId: applicationDefinition.id,
			account,
			sqlite: {
				async acquire(id) {
					calls.push('sqlite');
					return sqlite.acquire(id);
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
			ai: { runtime: null, account: null },
		});
	expect(calls).toEqual([]);
	const app = application();
	try {
		expectOk(await app.ready);
		expect(calls.sort()).toEqual(['blobs', 'recording', 'secrets']);
		expectOk(await app.device.sqlite.delete('unused'));
		expect(calls.sort()).toEqual(['blobs', 'recording', 'secrets', 'sqlite']);
		expect(app.device.connections.custom).toBeNull();
		expect(app.account).toBeUndefined();
		expect(app.device.connections.runtime).toBeNull();
	} finally {
		await app.close();
	}
});

test('composition retains table and field names', async () => {
	const applicationDefinition = defineApp({
		tables: { notes: defineTable({ title: field.string() }) },
		kv: {},
		id: 'test.' + crypto.randomUUID(),
	});
	const application = (account?: Account) =>
		composeApp(applicationDefinition, {
			appId: applicationDefinition.id,
			account,
			...browser,
			sqlite,
			ai: { runtime: null, account: null },
		});
	const app = application();
	try {
		expectOk(await app.ready);
		app.device.tables.notes.create({ title: 'Typed title' });
		const title: string = app.device.tables.notes.rows[0]!.title;
		expect(title).toBe('Typed title');
	} finally {
		await app.close();
	}
});

test('the same declaration compiles and opens in memory without acquiring App resources', async () => {
	const schema = defineApp({
		id: 'test.schema',
		kv: { language: field.string() },
		tables: { notes: defineTable({ title: field.string() }) },
	});
	const acquire = spyOn(resources.sqlite, 'acquire');
	try {
		for (const title of [undefined, 'Notes']) {
			const input = { ...schema, ...(title === undefined ? {} : { title }) };
			const declaration = defineApp(input);
			expect(declaration.tables).toBe(input.tables);
			expect(declaration.kv).toBe(input.kv);
			expectOk(compileData(declaration));
			expect(compileData(declaration)).toBe(compileData(declaration));
			const memory = await openMemory(declaration);
			try {
				memory.tables.notes.create({ title: 'Shared schema' });
				expect(memory.tables.notes.rows[0]?.title).toBe('Shared schema');
			} finally {
				await memory[Symbol.asyncDispose]();
			}
		}
		expect(acquire).not.toHaveBeenCalled();
	} finally {
		acquire.mockRestore();
	}
});
