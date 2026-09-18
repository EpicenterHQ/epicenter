/**
 * App scope ownership: device state survives account replacement, account data
 * stays isolated, and retirement stops sibling sync before physical cleanup.
 */
import 'fake-indexeddb/auto';
import { Database } from 'bun:sqlite';
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@epicenter/auth';
import * as dataBrowser from '@epicenter/data/browser';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import { secretLabel } from '@epicenter/device';
import { createSqliteOwner } from '@epicenter/device/owner';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { encodeFrame } from '../../data/src/sync/frames.js';
import { browser } from './browser.js';
import { defineApplication } from './index.js';
import { createBrowserRecording } from './recording/browser.js';

installTestLocks();
const definition = defineData({
	id: 'so.epicenter.scopes-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string() }),
	},
});
function accountFor(person: string, supportsShared = false): Account {
	return Object.freeze({
		supportsShared,
		authorityId: 'scope-test',
		principalId: asPrincipalId(person),
		baseURL: 'https://scopes.test',
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
			throw new Error('Unused');
		},
	});
}

test('device rows, SQLite and secrets survive signed-out, Alice and Bob lifetimes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'app-scopes-'));
	const sqlite = createSqliteOwner({
		async open(appId, name) {
			const database = new Database(join(root, `${appId}-${name}.sqlite`));
			const driver = createBunSqliteAdapter(database);
			return {
				async run(sql, parameters) {
					driver.run(sql, parameters);
					return Ok({ changes: 1 });
				},
				async all(sql, parameters) {
					return Ok(driver.all(sql, parameters));
				},
				async query() {
					return Ok({ columns: [], rows: [], truncated: false });
				},
				async batch(statements) {
					driver.transaction(() => {
						for (const s of statements) driver.run(s.sql, s.parameters);
					});
					return Ok({ changes: [] });
				},
				async close() {
					database.close();
				},
			};
		},
		async delete(appId, name) {
			await rm(join(root, `${appId}-${name}.sqlite`));
		},
	});
	const application = defineApplication({
		appId: `test.${crypto.randomUUID()}`,
		definition,
		runtime: { ...browser, sqlite },
		ai: { runtime: null, account: null },
	});
	try {
		const local = application.open(undefined);
		expectOk(await local.ready);
		expect(local.account).toBeNull();
		local.device.tables.notes.create({ title: 'device note' });
		const database = expectOk(await local.device.sqlite.open('mail'));
		expectOk(await database.run('CREATE TABLE cached (value TEXT)'));
		expectOk(await database.run("INSERT INTO cached VALUES ('mail cache')"));
		expectOk(
			await local.device.secrets.put(secretLabel('gmail'), 'gmail-token'),
		);
		await local.close();
		for (const person of ['alice', 'bob', 'alice']) {
			const app = application.open(accountFor(person));
			try {
				expectOk(await app.ready);
				expect(app.device.tables.notes.rows.map((r) => r.title)).toEqual([
					'device note',
				]);
				const db = expectOk(await app.device.sqlite.open('mail'));
				expect(expectOk(await db.all('SELECT value FROM cached'))).toEqual([
					{ value: 'mail cache' },
				]);
				expect(
					expectOk(await app.device.secrets.get(secretLabel('gmail'))),
				).toBe('gmail-token');
				expect(app.account!.shared).toBeNull();
				const notes = app.account!.personal.tables.notes;
				expect(notes.rows.every((r) => r.title === person)).toBe(true);
				if (!notes.rows.length) notes.create({ title: person });
			} finally {
				await app.close();
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each([
	['personal', false],
	['shared', false],
	['personal', true],
] as const)('%s retirement stops siblings before cleanup even if transport close fails=%s', async (retiring, throwOnClose) => {
	const events = { personal: new EventTarget(), shared: new EventTarget() };
	const closed: string[] = [];
	let recorderStopped = false;
	const failure = new Error('Socket close failed');
	const invalidated: string[] = [];
	const disposed: string[] = [];
	const invalidate = Promise.withResolvers<void>();
	const acquireData = dataBrowser.acquireAppData;
	const acquisition = spyOn(dataBrowser, 'acquireAppData').mockImplementation(
		async (definition, options) => {
			const library = options.library;
			if (library === 'local') return acquireData(definition, options);
			return Ok({
				durable: { commit() {} },
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				discard() {
					invalidated.push(library);
					return invalidate.promise;
				},
				dispose() {
					disposed.push(library);
				},
				replication: {
					address: {
						baseURL: 'https://scopes.test',
						dataId: definition.id,
						generation: 1,
					},
					transport: {
						async openWebSocket() {
							return Object.assign(events[library], {
								readyState: 1,
								binaryType: '',
								send() {},
								close() {
									closed.push(library);
									if (throwOnClose && library !== retiring) throw failure;
								},
							}) as unknown as WebSocket;
						},
					},
				},
			});
		},
	);
	const app = defineApplication({
		appId: `test.${crypto.randomUUID()}`,
		definition,
		runtime: {
			...browser,
			recording(...args) {
				const recorder = createBrowserRecording(...args);
				return {
					...recorder,
					close() {
						recorderStopped = true;
						return recorder.close();
					},
				};
			},
			sqlite: {
				async acquire() {
					return {
						async open() {
							throw new Error('unused');
						},
						async delete() {},
						async close() {},
					};
				},
			},
		},
		ai: { runtime: null, account: null },
	}).open(accountFor('alice', true));
	try {
		expectOk(await app.ready);
		expect(app.account!.shared).not.toBeNull();
		await Bun.sleep(0);
		events[retiring].dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
		expect(app.signal.aborted).toBe(true);
		expect(new Set(closed)).toEqual(new Set(['personal', 'shared']));
		expect(recorderStopped).toBe(true);
		for (const event of Object.values(events))
			event.dispatchEvent(
				new MessageEvent('message', {
					data: encodeFrame({ kind: 'retired' }).buffer,
				}),
			);
		expect(invalidated).toEqual([retiring]);
		expect(disposed).toEqual([]);
		expect(() => app.device.tables.notes.create({ title: 'late' })).toThrow();
		await app.libraryReplaced!;
		invalidate.resolve();

		if (throwOnClose) await expect(app.close()).rejects.toBe(failure);
		else await app.close();
		expect(app.canRetryClose).toBe(false);
		expect(new Set(disposed)).toEqual(new Set(['personal', 'shared']));
	} finally {
		invalidate.resolve();
		await app.close().catch(() => {});
		acquisition.mockRestore();
	}
});

test('an abort callback reentering close receives the memoized completion', async () => {
	const app = defineApplication({
		appId: `test.${crypto.randomUUID()}`,
		definition,
		runtime: {
			...browser,
			sqlite: {
				async acquire() {
					return {
						async open() {
							throw new Error('unused');
						},
						async delete() {},
						async close() {},
					};
				},
			},
		},
		ai: { runtime: null, account: null },
	}).open();
	expectOk(await app.ready);
	let reentrant: Promise<void> | undefined;
	app.signal.addEventListener('abort', () => {
		reentrant = app.close();
	});
	const closing = app.close();
	expect(reentrant).toBe(closing);
	await closing;
});
