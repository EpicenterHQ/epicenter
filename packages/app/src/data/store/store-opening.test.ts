/**
 * Document opening and closure regressions.
 *
 * Retained capabilities must enforce closure at their operation boundary, and
 * repeated close calls must share completion through persistence and disposal.
 * Closing stops persistence notifications before the final flush settles.
 * Deferred acquisition hydrates the existing handles without authoring updates;
 * refusals, exceptions, corrupt replay, and early close release their resources.
 * Manual promises control the interleavings. A loopback socket verifies shutdown
 * during sync attachment; these tests do not simulate a browser restart.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { defineApp, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createSqliteDurablePort } from './log.js';
import type { DurableOp } from './persistence.js';
import {
	createStoreOverPort,
	type StoreBacking,
	StoreError,
	StoreUnusableError,
	syncEngineOf,
} from './store.js';

const definition = expectOk(
	compileData(
		defineApp({
			id: 'so.epicenter.store-opening-test',
			kv: { theme: field.string() },
			tables: {
				notes: defineTable({ title: field.string(), content: plainText() }),
			},
		}),
	),
);

async function setup() {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const { store, view, close, ready } = createStoreOverPort({
		definition,

		acquire: async () =>
			Ok({ durable: port, loaded: port.load(), dispose: () => raw.close() }),
	});
	expectOk(await ready);
	const notes = view.tables.notes;
	if (notes === undefined) throw new Error('The fixture declares notes');
	const row = notes.create({ title: 'accepted before close' });
	if (row instanceof Promise)
		throw new Error('The fixture declares plain notes');
	const content = row.content;
	if (!(content instanceof Y.Type)) throw new Error('The row has no content');
	return { store, view, notes, row, content, close, port };
}

// ============================================================================
// Retained capabilities
// ============================================================================

test('retained reads and writes throw as soon as close starts', async () => {
	const { store, view, notes, row, close } = await setup();
	const { kv, transact } = view;
	const { get, create, update, delete: deleteRow, ids } = notes;
	const { get: getKv, update: updateKv } = kv;
	const { stored, rowFile, pressure, stateVector, encodeStateSince } = store;
	let transactionCalls = 0;
	const operations = [
		() => get(row.id),
		() => ids(),
		() => notes.rows,
		() => notes.nonconforming,
		() => create({ title: 'must not be written' }),
		() => update(row.id, { title: 'must not be written' }),
		() => deleteRow(row.id),
		() => getKv('theme'),
		() => kv.nonconforming,
		() => updateKv({ theme: 'must not be written' }),
		() => transact(() => transactionCalls++),
		() => stored(),
		() => rowFile('notes', row.id),
		() => pressure(),
		() => stateVector(),
		() => encodeStateSince(),
	];
	const closing = close();
	try {
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
		await closing;
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
		expect(transactionCalls).toBe(0);
	} finally {
		await closing;
	}
});

test('retained subscriptions refuse registration after close starts while teardown stays safe', async () => {
	const { store, view, notes, content, close } = await setup();
	const { subscribe, watch } = notes;
	const { subscribe: subscribeKv } = view.kv;
	const { onCommitted } = store;
	const listener = () => undefined;
	const stops = [
		subscribe(listener),
		watch(content, listener),
		subscribeKv(listener),
		onCommitted(listener),
	];
	const operations = [
		() => subscribe(listener),
		() => watch(content, listener),
		() => subscribeKv(listener),
		() => onCommitted(listener),
	];
	const closing = close();
	try {
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
		await closing;
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
	} finally {
		await closing;
		for (const stop of stops) {
			expect(stop).not.toThrow();
			expect(stop).not.toThrow();
		}
	}
});

test('retained persistence methods throw after close starts without blocking teardown', async () => {
	const { store, close } = await setup();
	const { get, subscribe, flush } = store.persistence;
	const stop = subscribe(() => undefined);
	const operations = [get, () => subscribe(() => undefined), flush];
	const closing = close();
	try {
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
		await closing;
		for (const operation of operations) {
			expect(operation).toThrow(StoreUnusableError);
		}
	} finally {
		await closing;
		expect(stop).not.toThrow();
		expect(stop).not.toThrow();
	}
});

// ============================================================================
// Close completion
// ============================================================================

test('close stops status delivery before the pending flush settles', async () => {
	const commit = Promise.withResolvers<void>();
	const { store, view, close, ready } = createStoreOverPort({
		definition,

		acquire: async () =>
			Ok({
				durable: { commit: () => commit.promise },
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
			}),
	});
	expectOk(await ready);
	let notifications = 0;
	store.persistence.subscribe(() => {
		// Count before any store access: a swallowed observer error must not
		// conceal a notification delivered after its capability was revoked.
		notifications++;
	});
	view.kv.update({ theme: 'dark' });
	const closing = close();
	try {
		expect(notifications).toBe(1);
		commit.resolve();
		await closing;
		expect(notifications).toBe(1);
	} finally {
		commit.resolve();
		await closing;
	}
});

test('repeated close shares the pending commit and final disposal completion', async () => {
	const commit = Promise.withResolvers<void>();
	const disposal = Promise.withResolvers<void>();
	const disposing = Promise.withResolvers<void>();
	let commitCalls = 0;
	let disposalCalls = 0;
	let destroyCalls = 0;
	let disposalClosing: Promise<void> | undefined;
	let destructionClosing: Promise<void> | undefined;
	let settled = false;
	const { store, view, close, ready } = createStoreOverPort({
		definition,

		acquire: async () =>
			Ok({
				durable: {
					commit() {
						commitCalls++;
						return commit.promise;
					},
				},
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				dispose() {
					disposalCalls++;
					disposalClosing = close();
					disposing.resolve();
					return disposal.promise;
				},
			}),
	});
	expectOk(await ready);
	const notes = view.tables.notes;
	if (notes === undefined) throw new Error('The fixture declares notes');
	const row = notes.create({ title: 'pending durable write' });
	if (row instanceof Promise)
		throw new Error('The fixture declares plain notes');
	const { content } = row;
	if (!(content instanceof Y.Type) || content.doc === null) {
		throw new Error('The content is not attached to its document');
	}
	content.doc.on('destroy', () => {
		destroyCalls++;
		destructionClosing = close();
	});
	expect(store.persistence.get()).toBe('pending');
	const closing = close();
	void closing.then(() => {
		settled = true;
	});
	try {
		expect(close()).toBe(closing);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(disposalCalls).toBe(0);
		expect(destroyCalls).toBe(0);
		commit.resolve();
		await disposing.promise;
		expect(settled).toBe(false);
		expect(close()).toBe(closing);
		expect(commitCalls).toBe(1);
		expect(disposalCalls).toBe(1);
		expect(destroyCalls).toBe(1);
		expect(disposalClosing).toBe(closing);
		expect(destructionClosing).toBe(closing);
		disposal.resolve();
		await closing;
		expect(settled).toBe(true);
		expect(close()).toBe(closing);
	} finally {
		commit.resolve();
		disposal.resolve();
		await closing;
	}
});

// ============================================================================
// Asynchronous acquisition
// ============================================================================

test('retained table and KV handles hydrate in place without replaying authored work', async () => {
	const {
		store: seed,
		view: seedView,
		row,
		port,
		close: closeSeed,
	} = await setup();
	seedView.kv.update({ theme: 'dark' });
	syncEngineOf(seed).acknowledge(1, 7);
	await seed.persistence.flush();
	const loaded = port.load();
	await closeSeed();
	const acquisition = Promise.withResolvers<Result<StoreBacking, never>>();
	const batches: DurableOp[][] = [];
	const backing: StoreBacking = {
		loaded,
		durable: {
			commit: (ops) => {
				batches.push([...ops]);
			},
		},
	};
	const { store, view, ready, close } = createStoreOverPort({
		definition,
		acquire: () => acquisition.promise,
	});
	const { tables, kv, transact } = view;
	const notes = tables.notes;
	if (notes === undefined) throw new Error('The fixture declares notes');
	const { get, create, subscribe } = notes;
	const { get: getKv, update: updateKv } = kv;
	let transactionCalls = 0;
	try {
		for (const operation of [
			() => get(row.id),
			() => notes.rows,
			() => create({ title: 'premature' }),
			() => subscribe(() => undefined),
			() => getKv('theme'),
			() => updateKv({ theme: 'premature' }),
			() => kv.subscribe(() => undefined),
			() => transact(() => transactionCalls++),
			() => store.persistence,
		]) {
			expect(operation).toThrow('not ready');
		}
		acquisition.resolve(Ok(backing));
		expectOk(await ready);
		expect(view.tables).toBe(tables);
		expect(view.tables.notes).toBe(notes);
		expect(view.kv).toBe(kv);
		expect(notes.get).toBe(get);
		expect(kv.update).toBe(updateKv);
		expect(get(row.id)?.title).toBe('accepted before close');
		expect(getKv('theme')).toBe('dark');
		expect(notes.rows).toHaveLength(1);
		expect(transactionCalls).toBe(0);
		expect(batches).toEqual([]);
		expect(syncEngineOf(store).cursor()).toBe(7);
		expect(syncEngineOf(store).coalesce()?.id).toBe(loaded.lastId);
		updateKv({ theme: 'light' });
		expect(getKv('theme')).toBe('light');
		await store.persistence.flush();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toMatchObject([
			{ kind: 'append', id: loaded.lastId + 1, authoritySeq: undefined },
		]);
	} finally {
		acquisition.resolve(Ok(backing));
		await close();
	}
});

test('an acquisition refusal reaches ready without another Result wrapper', async () => {
	const refusal = StoreError.LocksUnsupported({ address: 'test-opening' });
	const { view, ready, close } = createStoreOverPort({
		definition,
		acquire: async () => refusal,
	});
	const { kv } = view;
	try {
		expect(expectErr(await ready)).toBe(refusal.error);
		expect(() => kv.get('theme')).toThrow(StoreUnusableError);
		const closing = close();
		expect(close()).toBe(closing);
		await closing;
	} finally {
		await close();
	}
});

test.each([
	'synchronous throw',
	'rejected promise',
])('acquisition %s becomes StorageFailed with its original cause', async (failure) => {
	const cause = new Error('Acquisition failed before returning resources');
	const { view, ready, close } = createStoreOverPort({
		definition,
		acquire() {
			if (failure === 'synchronous throw') throw cause;
			return Promise.reject(cause);
		},
	});
	const { kv } = view;
	try {
		expect(expectErr(await ready)).toMatchObject({
			name: 'StorageFailed',
			cause,
		});
		expect(() => kv.update({ theme: 'late' })).toThrow(StoreUnusableError);
	} finally {
		await close();
	}
});

test('close before acquisition resolves skips hydration and waits for disposal once', async () => {
	const acquisition = Promise.withResolvers<Result<StoreBacking, never>>();
	const acquired = Promise.withResolvers<void>();
	const disposal = Promise.withResolvers<void>();
	const disposing = Promise.withResolvers<void>();
	let disposalCalls = 0;
	let commitCalls = 0;
	let settled = false;
	const backing: StoreBacking = {
		durable: {
			commit: () => {
				commitCalls++;
			},
		},
		// If close accidentally hydrates this, readiness reports StorageFailed.
		loaded: {
			updates: [new Uint8Array([1, 2, 3])],
			outbox: [],
			cursor: 0,
			lastId: 0,
		},
		dispose() {
			disposalCalls++;
			disposing.resolve();
			return disposal.promise;
		},
	};
	const { view, ready, close } = createStoreOverPort({
		definition,
		acquire() {
			acquired.resolve();
			return acquisition.promise;
		},
	});
	const { kv } = view;
	await acquired.promise;
	const closing = close();
	void closing.then(() => {
		settled = true;
	});
	try {
		expect(close()).toBe(closing);
		expect(() => kv.get('theme')).toThrow(StoreUnusableError);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(disposalCalls).toBe(0);
		acquisition.resolve(Ok(backing));
		await disposing.promise;
		expect(disposalCalls).toBe(1);
		expect(settled).toBe(false);
		disposal.resolve();
		expect(expectErr(await ready).name).toBe('ClosedWhileOpening');
		await closing;
		expect(close()).toBe(closing);
		expect(disposalCalls).toBe(1);
		expect(commitCalls).toBe(0);
		expect(() => kv.get('theme')).toThrow(StoreUnusableError);
	} finally {
		acquisition.resolve(Ok(backing));
		disposal.resolve();
		await closing;
	}
});

test('corrupt replay releases acquired backing and never exposes partially hydrated rows', async () => {
	const { port, row, close: closeSeed } = await setup();
	const loaded = port.load();
	await closeSeed();
	let disposalCalls = 0;
	let commitCalls = 0;
	const { view, ready, close } = createStoreOverPort({
		definition,
		acquire: async (): Promise<Result<StoreBacking, never>> =>
			Ok({
				durable: {
					commit: () => {
						commitCalls++;
					},
				},
				loaded: {
					...loaded,
					updates: [...loaded.updates, new Uint8Array([1, 2, 3])],
				},
				dispose: () => {
					disposalCalls++;
				},
			}),
	});
	const notes = view.tables.notes;
	if (notes === undefined) throw new Error('The fixture declares notes');
	try {
		expect(expectErr(await ready).name).toBe('StorageFailed');
		expect(disposalCalls).toBe(1);
		expect(commitCalls).toBe(0);
		expect(() => notes.get(row.id)).toThrow(StoreUnusableError);
		expect(() => notes.create({ title: 'late' })).toThrow(StoreUnusableError);
		await close();
		expect(disposalCalls).toBe(1);
	} finally {
		await close();
	}
});

test.each([
	'corrupt replay',
	'early close',
])('cleanup throwing after %s preserves the ready refusal while close rejects', async (failure) => {
	const cleanupError = new Error('The acquired backing could not be released');
	let disposalCalls = 0;
	const { view, ready, close } = createStoreOverPort({
		definition,
		acquire: async (): Promise<Result<StoreBacking, never>> =>
			Ok({
				durable: {
					commit() {
						throw new Error('Opening must not append');
					},
				},
				loaded: {
					updates: [new Uint8Array([1, 2, 3])],
					outbox: [],
					cursor: 0,
					lastId: 0,
				},
				dispose() {
					disposalCalls++;
					throw cleanupError;
				},
			}),
	});
	// Observe both channels immediately, including the intentionally rejected
	// close promise. Neither rejection may escape the test as unhandled.
	const [opening] = await Promise.allSettled([
		ready,
		failure === 'early close' ? close() : Promise.resolve(),
	]);
	const closing = close();
	await expect(closing).rejects.toBe(cleanupError);
	expect(close()).toBe(closing);
	expect(disposalCalls).toBe(1);
	expect(() => view.kv.get('theme')).toThrow(StoreUnusableError);
	if (opening.status !== 'fulfilled') {
		throw new Error('ready rejected instead of preserving its typed refusal', {
			cause: opening.reason,
		});
	}
	expect(expectErr(opening.value)).toMatchObject({
		name: failure === 'early close' ? 'ClosedWhileOpening' : 'StorageFailed',
	});
});

// ============================================================================
// Reentrant shutdown
// ============================================================================

test('close inside transact waits for the update emitted when the transaction ends', async () => {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const commit = Promise.withResolvers<void>();
	let disposalCalls = 0;
	let commitCalls = 0;
	let settled = false;
	const { view, close, ready } = createStoreOverPort({
		definition,

		acquire: async () =>
			Ok({
				loaded: port.load(),
				durable: {
					commit(ops) {
						commitCalls++;
						return commit.promise.then(() => port.commit(ops));
					},
				},
				dispose: () => {
					disposalCalls++;
				},
			}),
	});
	expectOk(await ready);
	const closing = view.transact(() => {
		view.kv.update({ theme: 'last transaction' });
		return close();
	});
	void closing.then(() => {
		settled = true;
	});
	try {
		// Advance to the next task, allowing all queued microtasks to drain.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(commitCalls).toBe(1);
		expect(settled).toBe(false);
		expect(disposalCalls).toBe(0);
		expect(port.load().updates).toHaveLength(0);
		commit.resolve();
		await closing;
		expect(disposalCalls).toBe(1);
		const reopened = createStoreOverPort({
			definition,

			acquire: async () => Ok({ durable: port, loaded: port.load() }),
		});
		expectOk(await reopened.ready);
		try {
			expect(reopened.view.kv.get('theme')).toBe('last transaction');
		} finally {
			await reopened.close();
		}
	} finally {
		commit.resolve();
		await closing;
		raw.close();
	}
});

test.each([
	'committed',
	'table',
	'kv',
	'persistence',
] as const)('close from the first %s subscriber skips the rest of its copied notification batch', async (channel) => {
	const commit = Promise.withResolvers<void>();
	const { store, view, close, ready } = createStoreOverPort({
		definition,

		acquire: async () =>
			Ok({
				durable: { commit: () => commit.promise },
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
			}),
	});
	expectOk(await ready);
	const notes = view.tables.notes;
	if (notes === undefined) throw new Error('The fixture declares notes');
	const subscribe = {
		committed: store.onCommitted,
		table: notes.subscribe,
		kv: view.kv.subscribe,
		persistence: store.persistence.subscribe,
	}[channel];
	let firstCalls = 0;
	let lateCalls = 0;
	subscribe(() => {
		firstCalls++;
		void close();
	});
	subscribe(() => {
		lateCalls++;
	});
	try {
		if (channel === 'table') notes.create({ title: 'triggers shutdown' });
		else view.kv.update({ theme: 'triggers shutdown' });
		expect(firstCalls).toBe(1);
		expect(lateCalls).toBe(0);
		commit.resolve();
		await close();
		expect(firstCalls).toBe(1);
		expect(lateCalls).toBe(0);
	} finally {
		commit.resolve();
		await close();
	}
});

test('close during sync attachment releases the late socket and refuses readiness', async () => {
	const disconnected = Promise.withResolvers<void>();
	let socketCloses = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			message() {
				throw new Error('The abandoned connection must not send');
			},
			close() {
				socketCloses++;
				disconnected.resolve();
			},
		},
	});
	let dials = 0;
	let disposalCalls = 0;
	let dialClosing: Promise<void> | undefined;
	const { ready, close } = createStoreOverPort({
		definition,
		acquire: async (): Promise<Result<StoreBacking, never>> =>
			Ok({
				durable: {
					commit() {
						throw new Error('The closed opener must not append');
					},
				},
				loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
				dispose: () => {
					disposalCalls++;
				},
				async discard() {
					throw new Error('This test never retires a generation');
				},
				replication: {
					address: {
						baseURL: server.url.origin,
						dataId: definition.id,
						generation: 1,
					},
					transport: {
						openWebSocket(address) {
							dials++;
							dialClosing = close();
							const socket = new WebSocket(address.url);
							return new Promise<WebSocket>((resolve, reject) => {
								socket.addEventListener('open', () => resolve(socket), {
									once: true,
								});
								socket.addEventListener('error', reject, { once: true });
							});
						},
					},
				},
			}),
	});
	try {
		expect(expectErr(await ready).name).toBe('ClosedWhileOpening');
		await disconnected.promise;
		expect(dials).toBe(1);
		expect(socketCloses).toBe(1);
		expect(disposalCalls).toBe(1);
		expect(dialClosing).toBe(close());
	} finally {
		await close();
		// Let the server finish processing its socket-close event before stop.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await server.stop(true);
	}
});
