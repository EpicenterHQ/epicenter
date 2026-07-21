/**
 * Direct hostile-SQL invariant tests for every candidate layout, reproducing the
 * audit's data-corruption findings and proving they are now refused:
 *
 * - lower sequence must not overwrite higher (monotonic install);
 * - a terminal row tombstone must not be resurrected by a later present;
 * - a value unset is non-terminal and may be replaced;
 * - unified normalized must not hold multiple physical rows for one value address;
 * - split normalized must reject a fact referencing the wrong coordinate kind;
 * - coordinates are immutable, so no UPDATE/DELETE/REPLACE can reinterpret a fact.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import {
	CANDIDATES,
	type Candidate,
	configureNewDatabase,
	createLayoutStore,
	ddlFor,
} from './layouts.js';
import type { Fact, RowAddress, ValueAddress } from './trace.js';

const open: Database[] = [];
afterEach(() => {
	for (const db of open.splice(0)) db.close();
});

function fresh(candidate: Candidate) {
	const db = new Database(':memory:');
	open.push(db);
	configureNewDatabase(db);
	db.exec(ddlFor(candidate));
	return { db, store: createLayoutStore(db, candidate) };
}

const rowAddr = (rowId: string): RowAddress => ({
	kind: 'row',
	namespace: 'so.epicenter.ns00',
	table: 'collection0001',
	rowId,
});
const valueAddr = (value: string): ValueAddress => ({
	kind: 'value',
	namespace: 'so.epicenter.ns00',
	value,
});
const ID_A = 'a'.repeat(24);

function rowPresent(rowId: string, sequence: number): Fact {
	return {
		address: rowAddr(rowId),
		sequence,
		presence: 'present',
		fields: { ok: 1 },
	};
}
function rowAbsent(rowId: string, sequence: number): Fact {
	return { address: rowAddr(rowId), sequence, presence: 'absent' };
}

describe('monotonic install: a lower sequence never overwrites a higher one', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			store.installFacts([rowPresent(ID_A, 10)]);
			store.installFacts([rowPresent(ID_A, 5)]);
			expect(store.pointRead(rowAddr(ID_A))?.sequence).toBe(10);
		});
	}
});

describe('row tombstone dominance: a later present never resurrects a deleted row', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			store.installFacts([rowAbsent(ID_A, 2)]);
			store.installFacts([rowPresent(ID_A, 3)]);
			expect(store.pointRead(rowAddr(ID_A))?.present).toBe(0);
		});
	}
});

describe('value absence is non-terminal: a later present replaces it', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const { store } = fresh(candidate);
			const v = valueAddr('settingx');
			store.installFacts([{ address: v, sequence: 2, presence: 'absent' }]);
			store.installFacts([
				{ address: v, sequence: 3, presence: 'present', content: 'back' },
			]);
			expect(store.pointRead(v)?.present).toBe(1);
		});
	}
});

describe('coordinates are immutable (normalized candidates)', () => {
	const normalized = CANDIDATES.filter((c) => c.coordinates === 'normalized');
	for (const candidate of normalized) {
		test(`${candidate.id}: UPDATE/DELETE/REPLACE of a referenced coordinate is refused`, () => {
			const { db, store } = fresh(candidate);
			store.installFacts([rowPresent(ID_A, 1)]);
			const id = (
				db
					.prepare(
						"SELECT coordinate_id AS id FROM coordinates WHERE kind='row' AND namespace='so.epicenter.ns00' AND local_key='collection0001'",
					)
					.get() as { id: number }
			).id;
			expect(() =>
				db.run('UPDATE coordinates SET kind=? WHERE coordinate_id=?', [
					'value',
					id,
				]),
			).toThrow();
			expect(() =>
				db.run('DELETE FROM coordinates WHERE coordinate_id=?', [id]),
			).toThrow();
			expect(() =>
				db.run(
					'INSERT OR REPLACE INTO coordinates (coordinate_id,kind,namespace,local_key) VALUES (?,?,?,?)',
					[id, 'value', 'so.epicenter.ns00', 'settingz'],
				),
			).toThrow();
			// The fact still reads as a present row: nothing was reinterpreted.
			expect(store.pointRead(rowAddr(ID_A))?.present).toBe(1);
		});
	}
});

describe('unified normalized: one value address holds at most one physical row', () => {
	test('a value fact with a non-empty row_id is refused', () => {
		const candidate = CANDIDATES.find(
			(c) => c.relation === 'unified' && c.coordinates === 'normalized',
		)!;
		const { db, store } = fresh(candidate);
		store.installFacts([
			{
				address: valueAddr('settingx'),
				sequence: 1,
				presence: 'present',
				content: 1,
			},
		]);
		const id = (
			db
				.prepare(
					"SELECT coordinate_id AS id FROM coordinates WHERE kind='value' AND local_key='settingx'",
				)
				.get() as { id: number }
		).id;
		expect(() =>
			db.run(
				'INSERT INTO facts (coordinate_id,row_id,present,payload,sequence) VALUES (?,?,?,?,?)',
				[id, ID_A, 1, 'null', 999],
			),
		).toThrow();
		const count = (
			db
				.prepare('SELECT COUNT(*) AS n FROM facts WHERE coordinate_id=?')
				.get(id) as {
				n: number;
			}
		).n;
		expect(count).toBe(1);
	});
});

describe('candidate storage counts all btrees including autoindexes', () => {
	for (const candidate of CANDIDATES.filter(
		(c) => c.coordinates === 'normalized',
	)) {
		test(`${candidate.id}: candidateTableBytes includes sqlite_autoindex_* btrees`, () => {
			const { db, store } = fresh(candidate);
			// Enough rows to allocate index pages, including the UNIQUE autoindexes.
			const facts: Fact[] = [];
			for (let i = 0; i < 200; i += 1) {
				facts.push(rowPresent(i.toString(36).padStart(24, '0'), i + 1));
			}
			store.installFacts(facts);
			// The table-only accounting the audit flagged as undercounting.
			const tableOnly = (
				db
					.prepare(
						"SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat WHERE name IN ('facts','row_facts','value_facts','coordinates','pending_intents','parked_work','row_documents','retry_ledger')",
					)
					.get() as { b: number }
			).b;
			// The autoindex btrees that table-only accounting omits.
			const autoindexBytes = (
				db
					.prepare(
						"SELECT COALESCE(SUM(pgsize),0) AS b FROM dbstat WHERE name LIKE 'sqlite_autoindex_%'",
					)
					.get() as { b: number }
			).b;
			expect(autoindexBytes).toBeGreaterThan(0);
			// candidateTableBytes must include those autoindexes, so it exceeds the
			// table-only sum by at least the autoindex bytes.
			expect(store.candidateTableBytes()).toBeGreaterThanOrEqual(
				tableOnly + autoindexBytes,
			);
		});
	}
});

describe('split normalized: a fact table rejects the wrong coordinate kind', () => {
	test('row_facts referencing a value coordinate is refused', () => {
		const candidate = CANDIDATES.find(
			(c) => c.relation === 'split' && c.coordinates === 'normalized',
		)!;
		const { db, store } = fresh(candidate);
		store.installFacts([
			{
				address: valueAddr('settingx'),
				sequence: 1,
				presence: 'present',
				content: 1,
			},
		]);
		const valueCoord = (
			db
				.prepare(
					"SELECT coordinate_id AS id FROM coordinates WHERE kind='value' AND local_key='settingx'",
				)
				.get() as { id: number }
		).id;
		expect(() =>
			db.run(
				'INSERT INTO row_facts (coordinate_id,row_id,present,payload,sequence) VALUES (?,?,?,?,?)',
				[valueCoord, ID_A, 1, '{}', 999],
			),
		).toThrow();
	});
});
