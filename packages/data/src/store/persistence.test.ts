import { field, plainText } from '@epicenter/data/definition';
/**
 * The optimistic persistence boundary (ADR-0238, amended by ADR-0300):
 * acceptance is live, persistence is an ordered best-effort queue, and sync
 * sends accepted work after its bytes become durable.
 *
 * These tests reach the SQLite file directly, like `sync.test.ts`, because
 * the properties under test are properties of the durable record's shape.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	compileData,
	defineData,
	defineTable,
} from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import { createSqliteDurablePort } from './log.js';
import { createPersistenceController, type DurableOp } from './persistence.js';
import {
	createStoreOverPort,
	type DeclaredData,
	syncEngineOf,
} from './store.js';

/** Wrap one application-document update the way the wire carries it. */

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.select(['light', 'dark']) },
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

/** The parsed form the over-port constructors take (ADR-0240). */
function parsed() {
	const { data, error } = compileData(database);
	if (error !== null) throw new Error(error.message);
	return data;
}

/** Failed flushes are the subject here, not noise worth printing. */
const silent: Logger = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

/**
 * A real SQLite durable engine behind a gate that can refuse whole batches,
 * which is exactly the failure shape the port contract promises: all or
 * nothing.
 */
async function openFailable() {
	const raw = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(raw);
	const inner = createSqliteDurablePort({ sqlite });
	const gate = { failing: false };
	/** Every batch the engine accepted, for tests that pin op ordering. */
	const batches: DurableOp[][] = [];
	const { store, close, view, ready } = createStoreOverPort({
		definition: parsed(),

		log: silent,
		acquire: async () =>
			Ok({
				durable: {
					commit(ops) {
						if (gate.failing) throw new Error('durable storage refused');
						inner.commit(ops);
						batches.push([...ops]);
					},
				},
				loaded: inner.load(),
			}),
	});
	expectOk(await ready);
	return {
		store,
		close,
		db: view as unknown as DeclaredData<typeof database>,
		sqlite,
		gate,
		batches,
		durableUpdateCount: () =>
			sqlite.all<{ count: number }>('SELECT COUNT(*) AS count FROM _updates')[0]
				?.count ?? 0,
		durableOutboxIds: () =>
			sqlite
				.all<{ id: number }>(
					'SELECT id FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
				)
				.map((row) => row.id),
		durableCursor: () =>
			sqlite.all<{ seq: number | null }>(
				'SELECT MAX(authoritySeq) AS seq FROM _updates',
			)[0]?.seq ?? 0,
	};
}

/** Reopen over the same durable sqlite: the restart. */
async function reopen(sqlite: ReturnType<typeof createBunSqliteAdapter>) {
	const port = createSqliteDurablePort({ sqlite });
	const { store, view, ready } = createStoreOverPort({
		definition: parsed(),

		log: silent,
		acquire: async () => Ok({ durable: port, loaded: port.load() }),
	});
	expectOk(await ready);
	return { store, db: view as unknown as DeclaredData<typeof database> };
}

function titles(db: Awaited<ReturnType<typeof openFailable>>['db']): string[] {
	return db.tables.notes.rows.map((row) => row.title as string).sort();
}

describe('acceptance is live, durability is a visible debt', () => {
	test('a blocked store keeps accepting, and reads follow immediately', async () => {
		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;

		expectOk(replica.db.tables.notes.create({ title: 'first' }));
		expectOk(replica.db.tables.notes.create({ title: 'second' }));

		expect(titles(replica.db)).toEqual(['first', 'second']);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('blocked');
		// Nothing reached the durable engine.
		expect(replica.durableUpdateCount()).toBe(0);
		expect(replica.durableOutboxIds()).toEqual([]);
	});

	test('a later edit retries, and the retained work lands in order, once', async () => {
		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'a' }));
		expectOk(replica.db.tables.notes.create({ title: 'b' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('blocked');

		replica.gate.failing = false;
		// The next accepted edit is the retry trigger; no autonomous loop.
		expectOk(replica.db.tables.notes.create({ title: 'c' }));

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('saved');
		// Exactly one outbox entry per authored transaction, in order.
		expect(replica.durableOutboxIds()).toEqual([1, 2, 3]);
		// The durable log replays to the same three rows: nothing dropped,
		// nothing duplicated.
		const restarted = await reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['a', 'b', 'c']);
	});

	test('an explicit flush() retries without needing another edit', async () => {
		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'retained' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('blocked');

		replica.gate.failing = false;
		await replica.store.persistence.flush();

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('saved');
		expect(replica.durableOutboxIds()).toEqual([1]);
	});

	test('closing while blocked loses only the in-memory work, deliberately', async () => {
		const replica = await openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'durable before' }));
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'accepted only' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('blocked');

		// Disposal attempts one final flush and then lets go; it never hangs on
		// a blocked engine.
		await replica.close();

		const restarted = await reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['durable before']);
		expect(restarted.store.persistence.get()).toBe('saved');
	});

	test('kv and type-field edits are accepted while blocked, like table writes', async () => {
		const replica = await openFailable();
		const made = expectOk(replica.db.tables.notes.create({ title: 'holder' }));
		await replica.store.persistence.flush();
		replica.gate.failing = true;

		// KV: accepted live, visible at once.
		expectOk(replica.db.kv.update({ theme: 'dark' }));
		expect(replica.db.kv.get('theme')).toBe('dark');

		// A row's content node: an edit keeps writing text while blocked. The
		// type is live on the document the store already holds, so a blocked
		// engine never blocks acceptance.
		const content = replica.db.tables.notes.get(made.id)?.content;
		if (content === undefined) throw new Error('the row has no content');
		content.applyDelta(content.change.insert('typed while blocked') as never);
		expect(content.toString()).toContain('typed while blocked');

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('blocked');
		// Nothing reached the durable engine; everything above is the debt.
		expect(replica.durableUpdateCount()).toBe(1);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'retry trigger' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replica.store.persistence.get()).toBe('saved');
		const restarted = await reopen(replica.sqlite);
		expect(restarted.db.kv.get('theme')).toBe('dark');
		const survived = restarted.db.tables.notes.get(made.id)?.content;
		expect(survived?.toString()).toContain('typed while blocked');
	});

	test('the status is subscribable, and transitions fire once per change', async () => {
		const replica = await openFailable();
		const seen: string[] = [];
		replica.store.persistence.subscribe(() =>
			seen.push(replica.store.persistence.get()),
		);

		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'x' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(['pending', 'blocked']);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'y' }));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(['pending', 'blocked', 'pending', 'saved']);
	});

	test('an asynchronous engine reports pending, and mid-flight edits coalesce in order', async () => {
		// The browser shape: the port commits on its own schedule, and the
		// store never waits for it. Reads follow acceptance.
		const raw = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(raw);
		const inner = createSqliteDurablePort({ sqlite });
		const release: (() => void)[] = [];
		const { store, view, ready } = createStoreOverPort({
			definition: parsed(),

			log: silent,
			acquire: async () =>
				Ok({
					durable: {
						commit(ops) {
							const batch = [...ops];
							return new Promise<void>((resolve) => {
								release.push(() => {
									inner.commit(batch);
									resolve();
								});
							});
						},
					},
					loaded: inner.load(),
				}),
		});
		expectOk(await ready);
		const db = view as unknown as DeclaredData<typeof database>;

		expectOk(db.tables.notes.create({ title: 'a' }));
		expect(store.persistence.get()).toBe('pending');
		// Acceptance is not waiting on the flight: live reads already hold the
		// row.
		expect(db.tables.notes.rows.map((row) => row.title)).toEqual(['a']);

		await new Promise<void>((resolve) => setImmediate(resolve));
		// Two more accepted mid-flight; they must ride the NEXT batch together.
		expectOk(db.tables.notes.create({ title: 'b' }));
		expectOk(db.tables.notes.create({ title: 'c' }));

		const settled = store.persistence.flush();
		release.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		release.shift()?.();
		await settled;

		expect(store.persistence.get()).toBe('saved');
		// Exactly one durable outbox entry per authored transaction, in order:
		// nothing dropped, nothing reordered, nothing duplicated.
		expect(
			sqlite
				.all<{ id: number }>(
					'SELECT id FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
				)
				.map((row) => row.id),
		).toEqual([1, 2, 3]);
		const restarted = await reopen(sqlite);
		expect(titles(restarted.db)).toEqual(['a', 'b', 'c']);
	});
});

describe('owed work collapses so an offline chain stays bounded (ADR-0301)', () => {
	test('owed appends past the threshold merge into one row', async () => {
		const replica = await openFailable();
		// A device with no connection: nothing is ever coalesced, so nothing is
		// ever acknowledged, and under the old rule every one of these rows was
		// unfoldable forever.
		for (let i = 0; i < 80; i += 1) {
			expectOk(replica.db.tables.notes.create({ title: `note ${i}` }));
		}

		// Far fewer rows than edits, and every one of them still owed: a merge
		// changes what carries the bytes, never whether the authority has them.
		await replica.store.persistence.flush();
		const owed = replica.durableOutboxIds();
		expect(owed.length).toBeLessThan(80);
		expect(replica.durableCursor()).toBe(0);

		// And the document is intact across a restart, which is the only thing
		// the merge is allowed to preserve.
		const restarted = await reopen(replica.sqlite);
		expect(restarted.db.tables.notes.rows.length).toBe(80);
	});

	test('work already handed to the sender is not replaced under it', async () => {
		const replica = await openFailable();
		for (let i = 0; i < 10; i += 1) {
			expectOk(replica.db.tables.notes.create({ title: `early ${i}` }));
		}
		// The sender takes what exists. Everything at or below this id is now
		// named by a submission that may still be in flight.
		await replica.store.persistence.flush();
		const sent = syncEngineOf(replica.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');

		for (let i = 0; i < 80; i += 1) {
			expectOk(replica.db.tables.notes.create({ title: `later ${i}` }));
		}

		// The rows the sender was handed are untouched, so the acknowledgement
		// it is waiting on can still name them.
		await replica.store.persistence.flush();
		const owed = replica.durableOutboxIds();
		expect(owed.filter((id) => id <= sent.id).length).toBe(10);
		syncEngineOf(replica.store).acknowledge(sent.id, 7);
		await replica.store.persistence.flush();
		expect(replica.durableCursor()).toBe(7);
		expect(replica.durableOutboxIds().every((id) => id > sent.id)).toBe(true);
	});
});

describe('sync reads only durable facts', () => {
	test('coalesce offers nothing while the append is still in the queue', async () => {
		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'not yet durable' }));

		// The live document holds the edit and the person can see it; the sender
		// cannot, because what is owed is a property of the durable record
		// (ADR-0302). A blocked append cannot be sent until storage recovers.
		expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'now everything lands' }));
		// Both edits land together and merge into one submission.
		await replica.store.persistence.flush();
		const merged = syncEngineOf(replica.store).coalesce();
		expect(merged?.id).toBe(2);
	});

	test('onSendable fires when accepted bytes become durable', async () => {
		const replica = await openFailable();
		let nudges = 0;
		syncEngineOf(replica.store).onSendable(() => {
			nudges += 1;
		});

		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(replica.db.tables.notes.create({ title: 'accepted' }));
		expect(nudges).toBe(0);

		replica.gate.failing = false;
		expectOk(replica.db.tables.notes.create({ title: 'flushed' }));
		await replica.store.persistence.flush();
		expect(nudges).toBe(1);
	});

	test('a remote update is live at once, and its cursor waits for the bytes', async () => {
		const author = await openFailable();
		expectOk(author.db.tables.notes.create({ title: 'from the authority' }));
		const update = author.store.encodeStateSince();

		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(syncEngineOf(replica.store).applyRemote(update, { advanceTo: 7 }));

		// Live: the rows are readable immediately, because acceptance does not
		// wait on storage (ADR-0238).
		expect(titles(replica.db)).toEqual(['from the authority']);
		// The cursor is the DURABLE one and there is no other. It stays behind
		// the document while the flush is blocked, so a reconnect dials from
		// behind and re-receives what this document already holds. That is a
		// bounded re-download and nothing worse, because an update is
		// idempotent.
		expect(syncEngineOf(replica.store).cursor()).toBe(0);
		// Durable: neither the bytes nor the bookmark, because they commit
		// together or not at all (ADR-0231 via ADR-0238's whole-queue flush).
		expect(replica.durableUpdateCount()).toBe(0);
		expect(replica.durableCursor()).toBe(0);

		replica.gate.failing = false;
		await replica.store.persistence.flush();
		expect(replica.durableCursor()).toBe(7);
		const restarted = await reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['from the authority']);
		expect(syncEngineOf(restarted.store).cursor()).toBe(7);
	});

	test('an acknowledged entry stays off the live sender while its retirement is retained', async () => {
		const replica = await openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'sent' }));
		await replica.store.persistence.flush();
		const sent = syncEngineOf(replica.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');

		await replica.store.persistence.flush();
		replica.gate.failing = true;
		syncEngineOf(replica.store).acknowledge(sent.id, 1);

		// The durable record remains recoverable debt after a crash, but this
		// session already knows the authority accepted it.
		expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();
		expect(replica.durableOutboxIds()).toEqual([sent.id]);

		// Once the flush lands, the ack does too and the entry stops being owed.
		replica.gate.failing = false;
		await replica.store.persistence.flush();
		expect(replica.durableOutboxIds()).toEqual([]);
		expect(syncEngineOf(replica.store).coalesce()).toBeUndefined();
	});

	test('a remote update lost with a blocked close is simply re-received', async () => {
		const author = await openFailable();
		expectOk(author.db.tables.notes.create({ title: 'from the authority' }));
		const update = author.store.encodeStateSince();

		const replica = await openFailable();
		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(syncEngineOf(replica.store).applyRemote(update, { advanceTo: 1 }));
		expect(titles(replica.db)).toEqual(['from the authority']);
		await replica.close();

		// The restart honestly recovers only the durable prefix: no row, and a
		// cursor that never advanced, so the authority re-serves from zero.
		const restarted = await reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual([]);
		expect(syncEngineOf(restarted.store).cursor()).toBe(0);

		// Re-receiving the same bytes is the designed recovery, and it is safe
		// because an update is idempotent.
		expectOk(
			syncEngineOf(restarted.store).applyRemote(update, { advanceTo: 1 }),
		);
		expect(titles(restarted.db)).toEqual(['from the authority']);
		await restarted.store.persistence.flush();
		expect(syncEngineOf(restarted.store).cursor()).toBe(1);
	});

	test('an acknowledgement drops only the work it names; queued work lands intact', async () => {
		const replica = await openFailable();
		expectOk(replica.db.tables.notes.create({ title: 'sent' }));
		await replica.store.persistence.flush();
		const sent = syncEngineOf(replica.store).coalesce();
		if (sent === undefined) throw new Error('nothing to send');

		await replica.store.persistence.flush();
		replica.gate.failing = true;
		expectOk(
			replica.db.tables.notes.create({ title: 'authored while blocked' }),
		);
		syncEngineOf(replica.store).acknowledge(sent.id, 1);

		replica.gate.failing = false;
		await replica.store.persistence.flush();

		// One batch carried the retained append and the drop; the drop removed
		// only the entry the authority confirmed, never the newer work.
		expect(replica.durableOutboxIds()).toEqual([2]);
		const restarted = await reopen(replica.sqlite);
		expect(titles(restarted.db)).toEqual(['authored while blocked', 'sent']);
	});
});

describe('the controller against an asynchronous engine', () => {
	function createManualPort() {
		const batches: DurableOp[][] = [];
		const waiting: { resolve: () => void; reject: (cause: unknown) => void }[] =
			[];
		return {
			batches,
			commit(ops: readonly DurableOp[]): Promise<void> {
				batches.push([...ops]);
				return new Promise((resolve, reject) => {
					waiting.push({ resolve, reject });
				});
			},
			settle(outcome: 'ok' | 'fail'): Promise<void> {
				const next = waiting.shift();
				if (next === undefined) throw new Error('no batch in flight');
				if (outcome === 'ok') next.resolve();
				else next.reject(new Error('async engine refused'));
				// Let the controller's continuation run.
				return new Promise((resolve) => setTimeout(resolve, 0));
			},
		};
	}

	test('ops accepted mid-flight coalesce into the next batch', async () => {
		const port = createManualPort();
		const controller = createPersistenceController({
			assertUsable: () => undefined,
			port,
			loaded: {
				updates: [],
				outbox: [],
				cursor: 0,
				lastId: 0,
			},
			log: silent,
		});

		controller.append(new Uint8Array([1]), undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(controller.persistence.get()).toBe('pending');
		controller.append(new Uint8Array([2]), undefined);
		controller.append(new Uint8Array([3]), undefined);

		await port.settle('ok');
		// The two accepted mid-flight went out together, in order.
		await port.settle('ok');
		expect(port.batches).toHaveLength(2);
		expect(port.batches[0]?.map((op) => op.kind)).toEqual(['append']);
		expect(
			port.batches[1]?.map((op) => (op.kind === 'append' ? op.id : 0)),
		).toEqual([2, 3]);
		expect(controller.persistence.get()).toBe('saved');
	});

	test('a rejected batch is retained whole, ahead of later work', async () => {
		const port = createManualPort();
		const controller = createPersistenceController({
			assertUsable: () => undefined,
			port,
			loaded: {
				updates: [],
				outbox: [],
				cursor: 0,
				lastId: 0,
			},
			log: silent,
		});

		controller.append(new Uint8Array([1]), undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.append(new Uint8Array([2]), undefined);
		controller.append(new Uint8Array([3]), undefined);
		await port.settle('ok');
		await port.settle('fail');
		expect(controller.persistence.get()).toBe('blocked');

		controller.append(new Uint8Array([4]), undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await port.settle('ok');
		expect(controller.persistence.get()).toBe('saved');
		// One retry batch carrying everything, in the original order.
		expect(
			port.batches.at(-1)?.map((op) => (op.kind === 'append' ? op.id : 0)),
		).toEqual([2, 3, 4]);
	});
});

test('discard drops queued work before its commit microtask and never retries it', async () => {
	let commits = 0;
	const controller = createPersistenceController({
		port: {
			commit() {
				commits += 1;
			},
		},
		loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
		log: silent,
		assertUsable() {},
	});
	controller.append(new Uint8Array([1]), undefined);
	const discarded = controller.discard();
	controller.append(new Uint8Array([2]), undefined);
	controller.acknowledge(1, 1);
	await discarded;
	await controller.close();
	expect(commits).toBe(0);
	expect(controller.coalesce()).toBeUndefined();
});

test.each([
	'resolve',
	'reject',
] as const)('discard waits an overlapping commit that will %s without restoring its queue', async (outcome) => {
	const commit = Promise.withResolvers<void>();
	let commits = 0;
	let reports = 0;
	const controller = createPersistenceController({
		port: {
			commit() {
				commits += 1;
				return commit.promise;
			},
		},
		loaded: { updates: [], outbox: [], cursor: 0, lastId: 0 },
		log: {
			...silent,
			error: () => {
				reports += 1;
			},
		},
		assertUsable() {},
	});
	controller.append(new Uint8Array([1]), undefined);
	await Promise.resolve();
	controller.append(new Uint8Array([2]), undefined);
	let settled = false;
	const discarded = controller.discard().then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	if (outcome === 'resolve') commit.resolve();
	else commit.reject(new Error('Backing retirement refused this commit'));
	await discarded;
	await controller.close();
	expect(commits).toBe(1);
	expect(reports).toBe(0);
	expect(controller.coalesce()).toBeUndefined();
});
