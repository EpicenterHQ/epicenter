/**
 * Delivery follows durable completion, including slow writes and failed acks.
 * Manually held commits expose races hidden by synchronous SQLite fixtures.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { compileData, defineData, field } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createSqliteDurablePort } from '../store/log.js';
import type { DurableOp } from '../store/persistence.js';
import { createStoreOverPort, syncEngineOf } from '../store/store.js';
import { encodeFrame } from './frames.js';
import { createSyncConnection } from './connection.js';
import { decodeFrame } from './frames.js';

const definition = defineData({
	id: 'so.epicenter.scheduling',
	kv: { value: field.number() },
	tables: {},
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function setup() {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	let held = true;
	const pending: (() => void)[] = [];
	const batches: DurableOp[][] = [];
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		async acquire() {
			return Ok({
				loaded: port.load(),
				durable: {
					commit(ops) {
						batches.push([...ops]);
						if (!held) return port.commit(ops);
						return new Promise<void>((resolve) => {
							pending.push(() => {
								port.commit(ops);
								resolve();
							});
						});
					},
				},
			});
		},
	});
	expectOk(await parts.ready);
	return {
		...parts,
		port,
		batches,
		async release() {
			await tick();
			pending.shift()?.();
			await tick();
		},
		async drain() {
			held = false;
			pending.shift()?.();
			await parts.store.persistence.flush();
		},
		async [Symbol.asyncDispose]() {
			held = false;
			pending.shift()?.();
			await parts.close();
			raw.close();
		},
	};
}

test('a durable append wakes an idle connection after the original send window', async () => {
	await using replica = await setup();
	const sent: Uint8Array[] = [];
	const timers = new Set<{ run(): void; delay: number }>();
	using connection = createSyncConnection({
		onRetired() {
			throw new Error('Unexpected retirement in this transport test');
		},
		store: replica.store,
		idleMs: 1,
		dial(attempt) {
			attempt.opened({ send: (bytes) => sent.push(bytes) });
			attempt.received(encodeFrame({ kind: 'admitted' }));
			return () => {};
		},
		schedule(run, delay) {
			const timer = { run, delay };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
	});
	const idle = () => {
		for (const timer of [...timers]) {
			if (timer.delay !== 1) continue;
			timers.delete(timer);
			timer.run();
		}
	};
	connection.start();
	replica.view.kv.update({ value: 1 });
	idle();
	expect(sent).toHaveLength(0);
	await replica.drain();
	idle();
	expect(sent.map((bytes) => expectOk(decodeFrame(bytes)).kind)).toEqual([
		'push',
	]);
});

test('an acknowledgement pending on disk suppresses live resend but recovers as debt', async () => {
	await using replica = await setup();
	replica.view.kv.update({ value: 1 });
	await replica.release();
	const engine = syncEngineOf(replica.store);
	const sent = engine.coalesce();
	expect(sent).toBeDefined();
	engine.acknowledge(sent!.id, 1);
	expect(engine.coalesce()).toBeUndefined();
	expect(replica.port.load().outbox.map((entry) => entry.id)).toEqual([
		sent!.id,
	]);
	const restarted = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		async acquire() {
			return Ok({ loaded: replica.port.load(), durable: replica.port });
		},
	});
	expectOk(await restarted.ready);
	expect(syncEngineOf(restarted.store).coalesce()?.id).toBe(sent!.id);
	await restarted.close();
});

test('a burst during an owed fold produces one replacement and preserves reopen state', async () => {
	await using replica = await setup();
	for (let value = 1; value <= 64; value += 1)
		replica.view.kv.update({ value });
	await replica.release();
	for (let value = 65; value <= 67; value += 1)
		replica.view.kv.update({ value });
	await replica.drain();
	expect(
		replica.batches.flat().filter((op) => op.kind === 'mergeOwed'),
	).toHaveLength(1);
	const restarted = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		async acquire() {
			return Ok({ loaded: replica.port.load(), durable: replica.port });
		},
	});
	expectOk(await restarted.ready);
	expect(restarted.view.kv.get('value')).toBe(67);
	await restarted.close();
});

test('an edit in the completion microtask starts its own durable drain', async () => {
	const raw = new Database(':memory:');
	const port = createSqliteDurablePort({ sqlite: createBunSqliteAdapter(raw) });
	const batches: number[] = [];
	const parts = createStoreOverPort({
		definition: expectOk(compileData(definition)),
		async acquire() {
			return Ok({
				loaded: port.load(),
				durable: {
					commit(ops) {
						port.commit(ops);
						batches.push(ops.length);
						if (batches.length === 1) {
							void Promise.resolve()
								.then(() => {})
								.then(() => {
									parts.view.kv.update({ value: 2 });
								});
						}
					},
				},
			});
		},
	});
	try {
		expectOk(await parts.ready);
		parts.view.kv.update({ value: 1 });
		await tick();
		expect(batches).toEqual([1, 1]);
		expect(parts.store.persistence.get()).toBe('saved');
	} finally {
		await parts.close();
		raw.close();
	}
});
