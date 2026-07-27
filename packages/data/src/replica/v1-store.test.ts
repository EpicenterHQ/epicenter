/**
 * V1 Replica Store Tests
 *
 * Proves the storage half of ADR-0163: confirmed authority facts are kept
 * beneath local work rather than instead of it, visible state is their fold,
 * local writes compact per address, and a learned terminal tombstone dominates
 * optimistic row work without disturbing sealed retry bookkeeping.
 *
 * Key behaviors:
 * - A learned fact installs even when its address has pending local work
 * - Installation is monotonic per address; an equal sequence must be identical
 * - A terminal row tombstone retires unsealed row work and parked diagnostics
 * - A sealed intent is immutable, so a later write becomes separate pending work
 * - Value absence stays reversible while row absence is terminal
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type { Fact, Intent } from '../protocol/v1/index.js';
import { createReplicaV1Schema } from './v1-schema.js';
import {
	applyLocalWrite,
	composeIntents,
	insertIntent,
	installConfirmedFact,
	readConfirmedFact,
	readIntentsAt,
	readParked,
	readVisibleFact,
	readVisibleRowPage,
} from './v1-store.js';

const REPLICA_ID = 'abc123def456ghi789jkl012';
const ROW_ID = 'row123def456ghi789jkl012';

const ROW = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: ROW_ID,
} as const;

const VALUE = {
	kind: 'value',
	namespace: 'so.epicenter.settings',
	valueName: 'theme',
} as const;

function openStore() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	database.transaction(() => createReplicaV1Schema(database, REPLICA_ID));
	return database;
}

const rowPatch = (set: Record<string, unknown>, unset: string[] = []): Intent =>
	({ address: ROW, presence: 'present', set, unset }) as Intent;

const rowDelete: Intent = { address: ROW, presence: 'absent' };

const rowFact = (sequence: number, fields: Record<string, unknown>): Fact =>
	({ address: ROW, sequence, presence: 'present', fields }) as Fact;

const rowTombstone = (sequence: number): Fact => ({
	address: ROW,
	sequence,
	presence: 'absent',
});

describe('confirmed facts live beneath local work', () => {
	/**
	 * The defect this layout exists to remove. The previous store kept one merged
	 * row per address, so it had nowhere to put a learned fact for an address with
	 * local work and skipped the fact entirely, permanently losing authority truth.
	 */
	test('a learned fact installs even when the address has pending work', () => {
		const database = openStore();
		expect(
			applyLocalWrite(database, rowPatch({ title: 'local' }), 1).applied,
		).toBe(true);

		expect(
			installConfirmedFact(database, rowFact(7, { title: 'remote' })),
		).toBe('installed');

		expect(readConfirmedFact(database, ROW)).toMatchObject({
			sequence: 7,
			presence: 'present',
			fields: { title: 'remote' },
		});
	});

	/**
	 * The specific case ADR-0163 calls out: a pending local write must not be able
	 * to hide a remote tombstone. Under the merged layout the tombstone was
	 * skipped and the replica kept showing a row the authority had terminally
	 * deleted.
	 */
	test('a remote tombstone is not skipped by a pending local write', () => {
		const database = openStore();
		applyLocalWrite(database, rowPatch({ title: 'local' }), 1);

		installConfirmedFact(database, rowTombstone(7));

		expect(readConfirmedFact(database, ROW)?.presence).toBe('absent');
		expect(readVisibleFact(database, ROW)?.presence).toBe('absent');
	});

	test('local work still overlays a confirmed present fact', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(3, { title: 'remote', keep: 1 }));
		applyLocalWrite(database, rowPatch({ title: 'local' }), 1);

		expect(readVisibleFact(database, ROW)).toMatchObject({
			presence: 'present',
			fields: { title: 'local', keep: 1 },
		});
		// The confirmed fact underneath is untouched authority truth.
		expect(readConfirmedFact(database, ROW)).toMatchObject({
			sequence: 3,
			fields: { title: 'remote', keep: 1 },
		});
	});
});

describe('installation is monotonic per address', () => {
	test('a higher sequence replaces and a lower sequence is ignored', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(5, { v: 'five' }));

		expect(installConfirmedFact(database, rowFact(4, { v: 'four' }))).toBe(
			'stale',
		);
		expect(readConfirmedFact(database, ROW)).toMatchObject({ sequence: 5 });

		expect(installConfirmedFact(database, rowFact(6, { v: 'six' }))).toBe(
			'installed',
		);
		expect(readConfirmedFact(database, ROW)).toMatchObject({ sequence: 6 });
	});

	test('an equal sequence with identical content is a no-op, not corruption', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(5, { v: 'five' }));
		expect(installConfirmedFact(database, rowFact(5, { v: 'five' }))).toBe(
			'unchanged',
		);
	});

	test('an equal sequence with different content is reported as corruption', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(5, { v: 'five' }));
		expect(installConfirmedFact(database, rowFact(5, { v: 'other' }))).toBe(
			'conflict',
		);
	});

	/**
	 * A delayed submission response can carry an older fact than the facts feed
	 * already installed. Applying it would move the address backwards.
	 */
	test('a delayed older fact cannot replace a newer confirmed tombstone', () => {
		const database = openStore();
		installConfirmedFact(database, rowTombstone(9));

		// Stale, not a conflict: an older fact arriving late is ordinary, and
		// reporting it as corruption would erase a healthy replica.
		expect(installConfirmedFact(database, rowFact(4, { v: 'stale' }))).toBe(
			'stale',
		);
		expect(readConfirmedFact(database, ROW)?.presence).toBe('absent');
	});
});

describe('a terminal row tombstone dominates optimistic work', () => {
	test('it retires unsealed row intents and parked diagnostics', () => {
		const database = openStore();
		applyLocalWrite(database, rowPatch({ title: 'local' }), 1);
		expect(readIntentsAt(database, ROW)).toHaveLength(1);

		installConfirmedFact(database, rowTombstone(7));

		expect(readIntentsAt(database, ROW)).toHaveLength(0);
		expect(readParked(database)).toHaveLength(0);
	});

	/**
	 * The sealed submission must stay byte-identical for exact retry, so the
	 * intent survives; the kernel fold is what stops it resurrecting the row.
	 */
	test('it leaves a sealed intent intact but stops it overlaying', () => {
		const database = openStore();
		insertIntent(database, 1, 'sealed', rowPatch({ title: 'in-flight' }));

		installConfirmedFact(database, rowTombstone(7));

		expect(readIntentsAt(database, ROW)).toHaveLength(1);
		expect(readIntentsAt(database, ROW)[0]?.state).toBe('sealed');
		expect(readVisibleFact(database, ROW)?.presence).toBe('absent');
	});

	test('a local write beneath a confirmed tombstone is refused as superseded', () => {
		const database = openStore();
		installConfirmedFact(database, rowTombstone(7));

		expect(applyLocalWrite(database, rowPatch({ title: 'x' }), 1).applied).toBe(
			false,
		);
		expect(readIntentsAt(database, ROW)).toHaveLength(0);
	});
});

describe('value absence stays reversible', () => {
	const valueSet = (content: unknown): Intent =>
		({ address: VALUE, presence: 'present', content }) as Intent;
	const valueUnset: Intent = { address: VALUE, presence: 'absent' };

	test('a confirmed value unset can be set again locally', () => {
		const database = openStore();
		installConfirmedFact(database, {
			address: VALUE,
			sequence: 4,
			presence: 'absent',
		});

		expect(applyLocalWrite(database, valueSet('dark'), 1).applied).toBe(true);
		expect(readVisibleFact(database, VALUE)).toMatchObject({
			presence: 'present',
			content: 'dark',
		});
	});

	test('a local unset overlays a confirmed value', () => {
		const database = openStore();
		installConfirmedFact(database, {
			address: VALUE,
			sequence: 4,
			presence: 'present',
			content: 'light',
		});
		applyLocalWrite(database, valueUnset, 1);

		expect(readVisibleFact(database, VALUE)?.presence).toBe('absent');
		expect(readConfirmedFact(database, VALUE)).toMatchObject({
			presence: 'present',
			content: 'light',
		});
	});
});

describe('local writes compact to one intent per address', () => {
	test('two patches become one', () => {
		const database = openStore();
		applyLocalWrite(database, rowPatch({ a: 1 }), 1);
		applyLocalWrite(database, rowPatch({ b: 2 }), 2);

		const intents = readIntentsAt(database, ROW);
		expect(intents).toHaveLength(1);
		expect(readVisibleFact(database, ROW)).toMatchObject({
			fields: { a: 1, b: 2 },
		});
	});

	/**
	 * A sealed intent is immutable for exact retry, so newer work has to sit
	 * beside it rather than merge into it.
	 */
	test('a write beside a sealed intent creates separate pending work', () => {
		const database = openStore();
		insertIntent(database, 1, 'sealed', rowPatch({ a: 1 }));
		applyLocalWrite(database, rowPatch({ b: 2 }), 2);

		const intents = readIntentsAt(database, ROW);
		expect(intents.map((stored) => stored.state)).toEqual([
			'sealed',
			'pending',
		]);
		// Both fold, oldest first, so visible state reflects the sealed work too.
		expect(readVisibleFact(database, ROW)).toMatchObject({
			fields: { a: 1, b: 2 },
		});
	});
});

describe('composeIntents preserves the effect of applying both', () => {
	test('a later set wins and a later unset removes an earlier set', () => {
		const composed = composeIntents(
			rowPatch({ a: 1, b: 2, c: 3 }),
			rowPatch({ b: 20 }, ['a']),
		);
		expect(composed).toMatchObject({
			presence: 'present',
			set: { b: 20, c: 3 },
			unset: ['a'],
		});
	});

	test('a later set revives an earlier unset and stays disjoint', () => {
		const composed = composeIntents(rowPatch({}, ['a']), rowPatch({ a: 9 }));
		expect(composed).toMatchObject({ set: { a: 9 }, unset: [] });
	});

	test('a delete discards earlier local work', () => {
		expect(composeIntents(rowPatch({ a: 1 }), rowDelete)).toEqual(rowDelete);
	});

	test('a patch after a local delete is superseded, never a resurrection', () => {
		expect(composeIntents(rowDelete, rowPatch({ a: 1 }))).toEqual(rowDelete);
	});
});

describe('a table scan shows visible state, not just confirmed facts', () => {
	const otherRow = { ...ROW, rowId: 'row999def456ghi789jkl012' } as const;
	const scan = (database: ReturnType<typeof openStore>) =>
		readVisibleRowPage(database, ROW.namespace, ROW.tableName, 100, undefined);

	/**
	 * Local-first means a row the user just created is in the table immediately.
	 * Scanning the fact relation alone would hide it until the authority settled
	 * it, so a freshly created row would briefly vanish from its own list.
	 */
	test('a locally created row appears before it settles', () => {
		const database = openStore();
		applyLocalWrite(database, rowPatch({ title: 'fresh' }), 1);

		expect(scan(database).rows).toEqual([
			{ rowId: ROW.rowId, fields: { title: 'fresh' } },
		]);
	});

	test('a locally deleted row disappears before it settles', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(3, { title: 'remote' }));
		expect(scan(database).rows).toHaveLength(1);

		applyLocalWrite(database, rowDelete, 1);

		expect(scan(database).rows).toHaveLength(0);
	});

	test('a local patch overlays the confirmed row in the scan', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(3, { title: 'remote', keep: 1 }));
		applyLocalWrite(database, rowPatch({ title: 'local' }), 1);

		expect(scan(database).rows).toEqual([
			{ rowId: ROW.rowId, fields: { title: 'local', keep: 1 } },
		]);
	});

	test('a confirmed tombstone keeps the row out of the scan', () => {
		const database = openStore();
		installConfirmedFact(database, rowTombstone(4));

		expect(scan(database).rows).toHaveLength(0);
	});

	/**
	 * Skipped candidates must not consume page capacity, or a run of locally
	 * deleted rows would end a page early and strand the rest behind a cursor
	 * that never advances past them.
	 */
	test('rows that fold to absent do not shorten the page', () => {
		const database = openStore();
		installConfirmedFact(database, rowFact(1, { title: 'gone' }));
		installConfirmedFact(database, {
			address: otherRow,
			sequence: 2,
			presence: 'present',
			fields: { title: 'kept' },
		} as Fact);
		applyLocalWrite(database, rowDelete, 1);

		const page = readVisibleRowPage(
			database,
			ROW.namespace,
			ROW.tableName,
			1,
			undefined,
		);
		expect(page.rows).toEqual([
			{ rowId: otherRow.rowId, fields: { title: 'kept' } },
		]);
		expect(page.hasNext).toBe(false);
	});
});
