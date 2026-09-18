/**
 * App storage follows the captured account, survives reopening, and never
 * crosses into another owner's namespace. Retirement stops sibling sync.
 */
import { expect, test } from 'bun:test';
import { defineTable, field } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import { type BlobId, parseBlobId } from '@epicenter/blobs';
import { secretLabel } from '@epicenter/device';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openApp } from './open.js';
import { encodeFrame } from './data/sync/frames.js';
import { defineApp } from './index.js';
import { createMemoryRuntime } from './testing.js';
import { createBrowserRecording } from './recording/browser.js';

const definition = defineApp({
	id: 'so.epicenter.scopes-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string() }),
		recordings: defineTable({ audioBlobId: field.string() }),
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

test('device rows, SQLite, secrets and blobs isolate owners and survive returning to each owner', async () => {
	const runtime = createMemoryRuntime();
	const fixtureDefinition = defineApp({
		...definition,
		id: `test.${crypto.randomUUID()}`,
	});
	const openFixture = (account?: Account) =>
		openApp(fixtureDefinition, {
			account,
			runtime,
		});
	try {
		const seen = new Set<string>();
		const recordings = new Map<string, { id: string; audioBlobId: BlobId }>();
		for (const person of [
			undefined,
			'alice',
			undefined,
			'alice',
			'bob',
			'alice',
			undefined,
		]) {
			const owner = person ?? 'no-account';
			const app = openFixture(
				person === undefined ? undefined : accountFor(person),
			);
			try {
				expectOk(await app.ready);
				expect(app.device.tables.notes.rows.map((r) => r.title)).toEqual(
					seen.has(owner) ? [owner] : [],
				);
				const db = expectOk(await app.device.sqlite.open('mail'));
				expectOk(
					await db.run('CREATE TABLE IF NOT EXISTS cached (value TEXT)'),
				);
				expect(expectOk(await db.all('SELECT value FROM cached'))).toEqual(
					seen.has(owner) ? [{ value: owner }] : [],
				);
				expect(
					expectOk(await app.device.secrets.get(secretLabel('gmail'))),
				).toBe(seen.has(owner) ? owner : null);
				const files = expectOk(await app.blobs.local.list()).items;
				expect(files).toHaveLength(seen.has(owner) ? 1 : 0);
				expect(app.device.tables.recordings.rows).toHaveLength(
					seen.has(owner) ? 1 : 0,
				);
				for (const [otherOwner, recording] of recordings) {
					if (otherOwner === owner) continue;
					expect(
						expectErr(await app.blobs.local.get(recording.audioBlobId)).name,
					).toBe('BlobNotFound');
				}
				if (!seen.has(owner)) {
					app.device.tables.notes.create({ title: owner });
					expectOk(await db.run('INSERT INTO cached VALUES (?)', [owner]));
					expectOk(await app.device.secrets.put(secretLabel('gmail'), owner));
					const audioBlobId = expectOk(
						await app.blobs.local.add(new Blob([owner], { type: 'audio/wav' })),
					);
					const recording = app.device.tables.recordings.create({
						audioBlobId,
					});
					recordings.set(owner, { id: recording.id, audioBlobId });
				} else {
					const recording = app.device.tables.recordings.rows[0]!;
					expect({
						id: recording.id,
						audioBlobId: recording.audioBlobId,
					}).toEqual(recordings.get(owner)!);
					expect(
						await expectOk(
							await app.blobs.local.get(parseBlobId(recording.audioBlobId)!),
						).text(),
					).toBe(owner);
				}
				if (app.account) {
					const notes = app.account.personal.tables.notes;
					expect(notes.rows.map((r) => r.title)).toEqual(
						seen.has(owner) ? [owner] : [],
					);
					if (!seen.has(owner)) notes.create({ title: owner });
				} else expect(app.account).toBeUndefined();
				seen.add(owner);
			} finally {
				await app.close();
			}
		}
		const signedIn = openFixture(accountFor('alice'));
		try {
			expectOk(await signedIn.ready);
			const principal: string = signedIn.account!.identity.principalId;
			expect(principal).toBe('alice');
		} finally {
			await signedIn.close();
		}
		const signedOut = openFixture();
		try {
			expectOk(await signedOut.ready);
			expect(signedOut.account).toBeUndefined();
		} finally {
			await signedOut.close();
		}
	} finally {
		await runtime.dispose();
	}
});

test.each([
	['personal', false],
	['shared', false],
	['personal', true],
] as const)('%s retirement stops siblings before cleanup even if transport close fails=%s', async (retiring, throwOnClose) => {
	const runtime = createMemoryRuntime();
	const events = { personal: new EventTarget(), shared: new EventTarget() };
	const closed: string[] = [];
	let recorderStopped = false;
	const failure = new Error('Socket close failed');
	const invalidated: string[] = [];
	const disposed: string[] = [];
	const invalidate = Promise.withResolvers<void>();
	const acquireData = runtime.data;
	runtime.data = async (definition, options) => {
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
	};
	const appDefinition = defineApp({
		...definition,
		id: `test.${crypto.randomUUID()}`,
	});
	const app = openApp(appDefinition, {
		account: accountFor('alice', true),
		runtime: {
			...runtime,
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
			ai: { runtime: null, account: null },
		},
	});
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
	}
});

test('an abort callback reentering close receives the memoized completion', async () => {
	const runtime = createMemoryRuntime();
	const appDefinition = defineApp({
		...definition,
		id: `test.${crypto.randomUUID()}`,
	});
	const app = openApp(appDefinition, {
		account: undefined,
		runtime: {
			...runtime,
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
			ai: { runtime: null, account: null },
		},
	});
	expectOk(await app.ready);
	let reentrant: Promise<void> | undefined;
	app.signal.addEventListener('abort', () => {
		reentrant = app.close();
	});
	const closing = app.close();
	expect(reentrant).toBe(closing);
	await closing;
});
