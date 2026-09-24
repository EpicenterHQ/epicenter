/**
 * One suite, both `DurablePort` implementations, identical batches.
 *
 * There are two hand-written implementations of one port: `log.ts` over SQL,
 * and `browser.ts` over IndexedDB. Until this file existed they were tested
 * separately, each against its own expectations, so both stayed green while
 * they disagreed. Every test here drives BOTH through the same
 * `DurableOp[]` and asserts the same observable result, which is the only
 * thing that can hold two implementations of one contract together.
 *
 * What "observable" means here is deliberately narrow: what a reopen loads.
 * Row counts and storage layout are not the contract; two ports may fold at
 * different moments and still be correct, so the fold test asserts REPLAYED
 * STATE rather than shape.
 *
 * A case that fails on only one side is not automatically that side's bug.
 * It is a question about which behavior the contract intends, and the answer
 * belongs in this file's expectations once it is decided.
 */
import 'fake-indexeddb/auto';
import { installTestLocks } from './test-locks.js';

installTestLocks();

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import type { Logger } from 'wellcrafted/logger';
import { openIdbBacking } from './browser.js';
import { createRow, readRow, tableRoot } from './document.js';
import { createSqliteDurablePort, replay } from './log.js';
import {
	createPersistenceController,
	type DurableOp,
	type DurablePort,
	type DurableSnapshot,
} from './persistence.js';

const silent: Logger = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

/**
 * One durable record a test can commit to, close, and open again.
 *
 * Reopening is the whole point: a port's job is what survives, so every
 * assertion here reads a FRESH open rather than the handle that did the
 * writing. In-memory state that happens to be right proves nothing.
 */
type Record = {
	commit(ops: readonly DurableOp[]): Promise<void>;
	reopen(): Promise<{ loaded: DurableSnapshot; port: DurablePort }>;
};

type Engine = { name: string; create(label: string): Promise<Record> };

const sqliteEngine: Engine = {
	name: 'sqlite',
	async create(): Promise<Record> {
		// One database for the record's life, reopened through a new port, which
		// is the same shape `memory.ts` uses to model a close and a reopen.
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		const open = () => createSqliteDurablePort({ sqlite });
		return {
			commit: async (ops) => {
				await open().commit(ops);
			},
			reopen: async () => {
				const port = open();
				return { loaded: port.load(), port };
			},
		};
	},
};

const indexedDbEngine: Engine = {
	name: 'indexeddb',
	async create(label: string): Promise<Record> {
		const address = `conformance/${label}`;
		const open = async () => {
			const opened = await openIdbBacking(address);
			if (opened.error !== null) throw opened.error;
			return opened.data;
		};
		return {
			commit: async (ops) => {
				const backing = await open();
				await backing.port.commit(ops);
				backing.close();
			},
			reopen: async () => {
				const backing = await open();
				return { loaded: backing.loaded, port: backing.port };
			},
		};
	},
};

const ENGINES = [sqliteEngine, indexedDbEngine];

/** A distinct label per test, so IndexedDB's process-global store is not shared. */
let counter = 0;
beforeEach(() => {
	counter += 1;
});

/**
 * One update that sets a marker attribute, written the way the store itself
 * writes: a root by name, a row as an attribute on it (`document.ts`).
 *
 * Built as a delta from an empty baseline rather than a whole-state encode, so
 * a chain of these is a chain of small updates and the fold has something to
 * fold.
 */
function update(text: string): Uint8Array {
	const doc = new Y.Doc({ gc: true });
	const before = Y.encodeStateVector(doc);
	createRow(tableRoot(doc, 'marks'), 'only', { value: text });
	const bytes = Y.encodeStateAsUpdateV2(doc, before);
	doc.destroy();
	return new Uint8Array(bytes);
}

/**
 * Successive deltas from ONE writer, so the last one genuinely wins.
 *
 * Not `update()` in a loop: each of those mints its own `Y.Doc` with its own
 * client id, so N of them are N CONCURRENT writes to one attribute and the
 * winner is decided by client id rather than by order. That is correct CRDT
 * behavior and useless for asserting "the newest value survived the fold".
 */
function chain(count: number): Uint8Array[] {
	const doc = new Y.Doc({ gc: true });
	const root = tableRoot(doc, 'marks');
	const updates: Uint8Array[] = [];
	let since = Y.encodeStateVector(doc);
	for (let index = 0; index < count; index += 1) {
		createRow(root, 'only', { value: `v${index}` });
		updates.push(new Uint8Array(Y.encodeStateAsUpdateV2(doc, since)));
		since = Y.encodeStateVector(doc);
	}
	doc.destroy();
	return updates;
}

/** What a chain says once replayed, which is the only thing a caller can see. */
function readValue(chain: readonly Uint8Array[]): unknown {
	const doc = replay(chain.map((bytes) => ({ bytes })) as never);
	const value = readRow(tableRoot(doc, 'marks'), 'only')?.value;
	doc.destroy();
	return value;
}

let nextId = 0;
const append = (text: string, authoritySeq?: number): DurableOp => {
	nextId += 1;
	return { kind: 'append', id: nextId, bytes: update(text), authoritySeq };
};

for (const engine of ENGINES) {
	describe(`DurablePort conformance: ${engine.name}`, () => {
		test('an append survives a reopen', async () => {
			const record = await engine.create(`append-${counter}`);
			await record.commit([append('one')]);

			const { loaded } = await record.reopen();
			expect(readValue(loaded.updates)).toBe('one');
		});

		test('an append with no position is owed, and one with a position is not', async () => {
			const record = await engine.create(`owed-${counter}`);
			const owed = append('mine');
			const received = append('theirs', 9);
			await record.commit([owed, received]);

			const { loaded } = await record.reopen();
			// One column answers both questions. Owed is "the authority has no
			// position for this", and the cursor is the highest position any
			// append carries.
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([owed.id]);
			expect(loaded.cursor).toBe(9);
		});

		test('an ack retires the work it names AND records where it landed', async () => {
			const record = await engine.create(`ack-${counter}`);
			const first = append('a');
			const second = append('b');
			await record.commit([first, second]);

			const afterWrite = await record.reopen();
			expect(afterWrite.loaded.outbox.map((entry) => entry.id)).toEqual([
				first.id,
				second.id,
			]);
			expect(afterWrite.loaded.cursor).toBe(0);

			await record.commit([
				{ kind: 'ack', throughId: first.id, authoritySeq: 4 },
			]);
			const afterAck = await record.reopen();
			// Both halves of one fact: the covered work stops being owed, and the
			// position it reached becomes the cursor.
			expect(afterAck.loaded.outbox.map((entry) => entry.id)).toEqual([
				second.id,
			]);
			expect(afterAck.loaded.cursor).toBe(4);
		});

		test('a repeated ack does not restamp work a later ack already took', async () => {
			const record = await engine.create(`reack-${counter}`);
			const only = append('a');
			await record.commit([only]);
			await record.commit([
				{ kind: 'ack', throughId: only.id, authoritySeq: 3 },
			]);
			await record.commit([
				{ kind: 'ack', throughId: only.id, authoritySeq: 8 },
			]);

			const { loaded } = await record.reopen();
			expect(loaded.outbox).toEqual([]);
			// 3, not 8. A derived cursor can only report a position some bytes
			// actually carry, and the second ack covered nothing still owed, so
			// nothing took the 8. That is the honest behavior of deriving rather
			// than storing, and it fails in the safe direction: a cursor that
			// lags re-receives, and applying an update twice is free. A cursor
			// that ran ahead would skip entries forever.
			expect(loaded.cursor).toBe(3);
		});

		test('a folded chain replays to the same value, and leaves owed work alone', async () => {
			const record = await engine.create(`fold-${counter}`);
			// Past the fold threshold, all acknowledged, so the whole prefix is
			// foldable. Then one owed append on top, which the fold must not
			// touch: it is a suffix by construction, because ids only go up.
			// One writer, so the last value genuinely wins. Building the owed
			// append from a fresh document instead would make it CONCURRENT with
			// the chain rather than after it, and the winner would be decided by
			// client id.
			const written = chain(71);
			const numbered = written.map((bytes, index) => {
				nextId += 1;
				return {
					kind: 'append' as const,
					id: nextId,
					bytes,
					// Everything but the last is acknowledged, so the foldable
					// prefix is 70 and the owed suffix is 1.
					authoritySeq: index < 70 ? 1 : undefined,
				};
			});
			await record.commit(numbered.slice(0, 70));
			const owed = numbered[70] as DurableOp & { id: number };
			await record.commit([owed]);

			const { loaded } = await record.reopen();
			// Only the replayed state is the contract. The two ports may hold
			// different numbers of rows and both be right.
			expect(readValue(loaded.updates)).toBe('v70');
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([owed.id]);
			// The point of the fold: fewer rows than were written.
			expect(loaded.updates.length).toBeLessThan(71);
		});

		test('merged owed work replays the same and leaves one owed row', async () => {
			const record = await engine.create(`merge-${counter}`);
			// Three owed appends, no authority position on any of them, which is
			// what an offline replica accumulates.
			const written = chain(3);
			const numbered = written.map((bytes) => {
				nextId += 1;
				return {
					kind: 'append' as const,
					id: nextId,
					bytes,
					authoritySeq: undefined,
				};
			});
			await record.commit(numbered);

			// The merge the store would enqueue: the same bytes, one row, at an
			// id above every one it replaces.
			nextId += 1;
			const merged = nextId;
			await record.commit([
				{
					kind: 'mergeOwed',
					replaces: numbered.map((op) => op.id),
					id: merged,
					bytes: new Uint8Array(
						Y.mergeUpdatesV2(written as Uint8Array<ArrayBuffer>[]),
					),
				},
			]);

			const { loaded } = await record.reopen();
			// Same document, and still owed: a merge changes what carries the
			// bytes, never whether the authority has them.
			expect(readValue(loaded.updates)).toBe('v2');
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([merged]);
			expect(loaded.cursor).toBe(0);
		});

		test('an ack naming replaced ids redelivers rather than losing work', async () => {
			const record = await engine.create(`merge-race-${counter}`);
			// The race the id rule exists for. A submission goes out naming ids
			// through the second append; before its acknowledgement lands, a
			// third append arrives and a merge collapses all three.
			const written = chain(3);
			const numbered = written.map((bytes) => {
				nextId += 1;
				return {
					kind: 'append' as const,
					id: nextId,
					bytes,
					authoritySeq: undefined,
				};
			});
			await record.commit(numbered);
			const sentThrough = (numbered[1] as { id: number }).id;

			nextId += 1;
			const merged = nextId;
			await record.commit([
				{
					kind: 'mergeOwed',
					replaces: numbered.map((op) => op.id),
					id: merged,
					bytes: new Uint8Array(
						Y.mergeUpdatesV2(written as Uint8Array<ArrayBuffer>[]),
					),
				},
			]);

			// The stale acknowledgement arrives. It names ids that no longer
			// exist, so it stamps nothing.
			await record.commit([
				{ kind: 'ack', throughId: sentThrough, authoritySeq: 9 },
			]);

			const { loaded } = await record.reopen();
			// Still owed, so it goes out again: a redelivery the authority
			// absorbs by idempotence. The failure this refuses is the merged row
			// being stamped and the third append never being sent at all.
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([merged]);
			expect(readValue(loaded.updates)).toBe('v2');
		});

		test("the controller's mirror agrees with the record it mirrors", async () => {
			// The sender never reads storage. `coalesce` is synchronous over an
			// asynchronous port, so `durableOutbox()` returns a RAM mirror that
			// `succeeded()` advances by hand, in JavaScript, using the same rules
			// the port applies in its own dialect. That is two implementations of
			// one question, and the rest of this file pins the two PORTS against
			// each other without ever pinning the mirror against them.
			//
			// So: drive one controller through every op kind, then ask both. What
			// the sender believes is owed has to be what a fresh open would find.
			const record = await engine.create(`mirror-${counter}`);
			const opened = await record.reopen();
			const controller = createPersistenceController({
				port: opened.port,
				loaded: opened.loaded,
				log: silent,
			});

			const written = chain(4);
			const ids: number[] = [];
			for (const bytes of written) {
				nextId += 1;
				ids.push(nextId);
				controller.enqueue([
					{ kind: 'append', id: nextId, bytes, authoritySeq: undefined },
				]);
			}
			// The first two land with the authority; the last two collapse into
			// one owed row above every id it replaces.
			controller.enqueue([
				{ kind: 'ack', throughId: ids[1] as number, authoritySeq: 12 },
			]);
			nextId += 1;
			const merged = nextId;
			controller.enqueue([
				{
					kind: 'mergeOwed',
					replaces: ids.slice(2),
					id: merged,
					bytes: new Uint8Array(
						Y.mergeUpdatesV2(written.slice(2) as Uint8Array<ArrayBuffer>[]),
					),
				},
			]);
			await controller.persistence.flush();

			const believed = controller.durableOutbox().map((entry) => entry.id);
			const { loaded } = await record.reopen();
			expect(believed).toEqual(loaded.outbox.map((entry) => entry.id));
			expect(believed).toEqual([merged]);
			expect(controller.durableCursor()).toBe(loaded.cursor);
			expect(loaded.cursor).toBe(12);
		});

		test('a long chain that is mostly owed folds on neither port', async () => {
			// The two ports gate the fold on different quantities and converge
			// only because of an inner re-check. SQL counts the ACKNOWLEDGED rows
			// and stops there; IndexedDB counts the WHOLE chain, walks it, and
			// then re-tests the foldable subset. Nothing drove the state where
			// those two numbers disagree, and ADR-0301 made that state ordinary:
			// a device offline long enough has a long chain that is almost
			// entirely owed.
			const record = await engine.create(`owed-chain-${counter}`);
			const written = chain(70);
			const numbered = written.map((bytes, index) => {
				nextId += 1;
				return {
					kind: 'append' as const,
					id: nextId,
					bytes,
					// A short acknowledged prefix under a long owed suffix: the
					// chain is 70, and only 10 rows may be folded.
					authoritySeq: index < 10 ? 1 : undefined,
				};
			});
			await record.commit(numbered);

			const { loaded } = await record.reopen();
			// Neither port folds, because neither has 64 foldable rows, and the
			// answer must not depend on which one is asked.
			expect(loaded.updates.length).toBe(70);
			expect(loaded.outbox.length).toBe(60);
			expect(readValue(loaded.updates)).toBe('v69');
			expect(loaded.cursor).toBe(1);
		});

		test('a batch is all or nothing', async () => {
			const record = await engine.create(`atomic-${counter}`);
			// One document's two successive updates, so the replayed value is
			// the later one rather than whichever won a last-writer race.
			const [first, second] = chain(2) as [Uint8Array, Uint8Array];
			nextId += 1;
			const one: DurableOp = {
				kind: 'append',
				id: nextId,
				bytes: first,
				authoritySeq: undefined,
			};
			nextId += 1;
			const two: DurableOp = {
				kind: 'append',
				id: nextId,
				bytes: second,
				authoritySeq: undefined,
			};
			await record.commit([
				one,
				two,
				{ kind: 'ack', throughId: one.id, authoritySeq: 4 },
			]);

			// Every op in the batch landed, in order: both appends are stored,
			// the ack retired only what it named, and the cursor is the position
			// it landed at.
			const { loaded } = await record.reopen();
			expect(loaded.outbox.map((entry) => entry.id)).toEqual([two.id]);
			expect(loaded.cursor).toBe(4);
			expect(readValue(loaded.updates)).toBe('v1');
			expect(loaded.lastId).toBe(two.id);
		});
	});
}
