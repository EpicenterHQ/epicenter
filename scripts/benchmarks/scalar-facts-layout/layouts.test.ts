/**
 * Focused tests for the four layout candidates: DDL constraint refusals, the
 * monotonic install outcomes, and, above all, that every candidate independently
 * reconstructs the exact oracle state (count, current-protocol bytes, ordered
 * digest) after consuming the same event stream.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	attackMatrixProofs,
	CANDIDATES,
	createStore,
	ddlStatements,
	layoutsSelfTest,
} from './layouts.js';
import { factSetDigest, makeTrace, type TraceOptions } from './trace.js';

const BASE: TraceOptions = {
	facts: 3000,
	namespaceCount: 12,
	tableCount: 200,
	valueRatio: 0.1,
	dataSeed: 3,
	targetLogicalStateBytes: 3000 * 220,
	maxEncodedFactBytes: 8192,
};

function makeDb(statements: string[]): SqliteDatabase {
	const db = createBunSqliteAdapter(new Database(':memory:'));
	db.run('PRAGMA foreign_keys = ON');
	for (const statement of statements) db.run(statement);
	return db;
}

/** A makeDb that pins the correctness-relevant pragmas, for the attack matrix. */
function makeDbWith(opts: {
	recursiveTriggers: boolean;
	foreignKeys: boolean;
	ignoreCheckConstraints: boolean;
}): (statements: string[]) => SqliteDatabase {
	return (statements) => {
		const db = createBunSqliteAdapter(new Database(':memory:'));
		db.run(
			`PRAGMA recursive_triggers = ${opts.recursiveTriggers ? 'ON' : 'OFF'}`,
		);
		db.run(`PRAGMA foreign_keys = ${opts.foreignKeys ? 'ON' : 'OFF'}`);
		db.run(
			`PRAGMA ignore_check_constraints = ${opts.ignoreCheckConstraints ? 'ON' : 'OFF'}`,
		);
		for (const statement of statements) db.run(statement);
		return db;
	};
}

test('every candidate passes its constraint and transaction proofs', () => {
	expect(layoutsSelfTest(makeDb)).toEqual([]);
});

// The corruption/grammar attack matrix must hold under recursive_triggers and
// ignore_check_constraints OFF and ON for every candidate, and additionally under
// foreign_keys OFF and ON for the normalized candidates (whose orphan-refusal and
// grammar must not depend on FK or CHECK enforcement).
describe('attack matrix holds across the pragma matrix', () => {
	for (const candidate of CANDIDATES) {
		const foreignKeyModes =
			candidate.coordinates === 'normalized' ? [false, true] : [true];
		for (const recursiveTriggers of [false, true]) {
			for (const ignoreCheckConstraints of [false, true]) {
				for (const foreignKeys of foreignKeyModes) {
					const label = `rt=${recursiveTriggers ? 'on' : 'off'} icc=${ignoreCheckConstraints ? 'on' : 'off'} fk=${foreignKeys ? 'on' : 'off'}`;
					test(`${candidate.id} ${label}`, () => {
						expect(
							attackMatrixProofs(
								candidate,
								makeDbWith({
									recursiveTriggers,
									foreignKeys,
									ignoreCheckConstraints,
								}),
							),
						).toEqual([]);
					});
				}
			}
		}
	}
});

describe('candidate reconstructs the exact oracle state', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const trace = makeTrace(BASE);
			const db = makeDb(ddlStatements(candidate));
			const store = createStore(db, candidate);
			db.transaction(() => {
				for (const fact of trace.events()) store.install(fact);
			});

			const expected = trace.measure();
			const actual = factSetDigest(store.scanBySequence());
			expect(actual.count).toBe(expected.currentCount);
			expect(actual.bytes).toBe(expected.currentProtocolFactBytes);
			expect(actual.digestHex).toBe(expected.digestHex);

			// A point read matches the analytical oracle.
			const sample = trace.finalFactAt(BASE.namespaceCount + 1);
			const read = store.get(sample.address);
			expect(read).toEqual(sample);
		});
	}
});

/** Flatten a structured plan to uppercased text for coarse substring checks. */
function planText(plan: { branches: string[][] }): string {
	return plan.branches.flat().join(' | ').toUpperCase();
}

describe('query plans', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: every feed branch is an ordered sequence index, points/traverse indexed`, () => {
			const db = makeDb(ddlStatements(candidate));
			const store = createStore(db, candidate);
			const feed = store.queryPlan('feed');
			// EVERY feed branch, on its own, must be an ordered sequence-index range.
			expect(feed.branches.length).toBeGreaterThan(0);
			for (const branchRows of feed.branches) {
				const branch = branchRows.join(' | ').toUpperCase();
				expect(branch).not.toContain('TEMP B-TREE');
				expect(branch).not.toContain('SCAN');
				expect(branch).toContain('USING INDEX');
				expect(branch).toContain('SEQUENCE>');
			}
			// Points and traverse have their own indexed plans, never a full scan.
			for (const op of ['valuePoint', 'rowPoint', 'traverse'] as const) {
				const plan = store.queryPlan(op);
				expect(plan.branches.flat().length).toBeGreaterThan(0);
				expect(planText(plan)).not.toContain('TEMP B-TREE');
				expect(planText(plan)).not.toContain('SCAN');
				expect(planText(plan)).toContain('SEARCH');
			}
		});
	}
});

/** Build one candidate's store, fully aged, returning it with the trace. */
function built(candidate: (typeof CANDIDATES)[number]) {
	const trace = makeTrace(BASE);
	const db = makeDb(ddlStatements(candidate));
	const store = createStore(db, candidate);
	db.transaction(() => {
		for (const fact of trace.events()) store.install(fact);
	});
	return { trace, db, store };
}

describe('feed order and limit', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: pages are ascending, limited, and resume correctly`, () => {
			const { store } = built(candidate);
			const page = store.feedPage(0, 50);
			expect(page.length).toBe(50);
			for (let i = 1; i < page.length; i += 1) {
				expect((page[i]?.sequence ?? 0) > (page[i - 1]?.sequence ?? 0)).toBe(
					true,
				);
			}
			// Resume after the page's last sequence yields strictly-later facts.
			const after = page[page.length - 1]?.sequence ?? 0;
			const next = store.feedPage(after, 50);
			expect((next[0]?.sequence ?? 0) > after).toBe(true);
			// The full feed equals the ordered scan.
			const full = store.feedPage(0, 10_000_000).map((f) => f.sequence);
			const scan = [...store.scanBySequence()].map((f) => f.sequence);
			expect(full).toEqual(scan);
		});
	}
});

describe('traverse predicate and order (verified against raw SQL)', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: returns exactly the table's rows, ordered by row id`, () => {
			const { trace, db, store } = built(candidate);
			// Pick a (namespace, table) that actually has rows.
			const sample = trace.sampleRowAddresses(1)[0];
			if (sample?.kind !== 'row') throw new Error('no row sample');
			const facts = store.traverse(sample.namespace, sample.table);
			expect(facts.length).toBeGreaterThan(0);
			for (const f of facts) {
				expect(f.address.kind).toBe('row');
				expect(f.address.namespace).toBe(sample.namespace);
				if (f.address.kind === 'row')
					expect(f.address.table).toBe(sample.table);
			}
			const rowIds = facts.map((f) =>
				f.address.kind === 'row' ? f.address.rowId : '',
			);
			expect(rowIds).toEqual([...rowIds].sort());
			// Cross-check the row-id set against a raw table scan.
			const table = candidate.relation === 'split' ? 'row_facts' : 'facts';
			const rawCount = db.all<{ n: number }>(
				candidate.coordinates === 'normalized'
					? `SELECT count(*) AS n FROM ${table} t JOIN coordinates c ON c.coordinate_id=t.coordinate_id WHERE c.kind='row' AND c.namespace=? AND c.local_key=?`
					: candidate.relation === 'split'
						? `SELECT count(*) AS n FROM row_facts WHERE namespace=? AND local_key=?`
						: `SELECT count(*) AS n FROM facts WHERE kind='row' AND namespace=? AND local_key=?`,
				[sample.namespace, sample.table],
			)[0]?.n;
			if (rawCount === undefined) throw new Error('raw count returned no row');
			expect(facts.length).toBe(rawCount);
		});
	}
});

describe('point reads for both kinds', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: row and value point reads match the oracle; missing is undefined`, () => {
			const { trace, store } = built(candidate);
			// finalFactAt(index 0) is a value; a known row index is > valueCount.
			const valueFact = trace.finalFactAt(0);
			const rowFact = trace.finalFactAt(Math.floor(BASE.facts / 2));
			expect(store.get(valueFact.address)).toEqual(valueFact);
			expect(store.get(rowFact.address)).toEqual(rowFact);
			const missing = store.get({
				kind: 'row',
				namespace: 'so.epicenter.absent',
				table: 'collection9999',
				rowId: 'zzzzzzzzzzzzzzzzzzzzzzzz',
			});
			expect(missing).toBeUndefined();
		});
	}
});

describe('point and traverse plans are indexed SEARCH, never a full SCAN', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const db = makeDb(ddlStatements(candidate));
			const store = createStore(db, candidate);
			for (const op of ['rowPoint', 'valuePoint', 'traverse'] as const) {
				const plan = planText(store.queryPlan(op));
				expect(plan).toContain('SEARCH'); // uses an index / primary key
				expect(plan).not.toContain('SCAN'); // never a full-table scan
			}
			// Normalized reads must go through the coordinates index and the fact PK.
			if (candidate.coordinates === 'normalized') {
				expect(planText(store.queryPlan('rowPoint'))).toContain('COORDINATES');
			}
		});
	}
});

/** A spy that records call order and transaction depth over a real adapter. */
function spyDb(inner: SqliteDatabase): { db: SqliteDatabase; log: string[] } {
	const log: string[] = [];
	let depth = 0;
	const db: SqliteDatabase = {
		run(sql, parameters) {
			log.push(`run@${depth}`);
			return inner.run(sql, parameters);
		},
		all(sql, parameters) {
			log.push(`all@${depth}`);
			return inner.all(sql, parameters);
		},
		transaction(fn) {
			depth += 1;
			log.push(`begin@${depth}`);
			try {
				return inner.transaction(fn);
			} finally {
				log.push(`end@${depth}`);
				depth -= 1;
			}
		},
	};
	return { db, log };
}

describe('install is one atomic read-compare-write transaction', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: the select and the write happen inside one transaction`, () => {
			const inner = makeDb(ddlStatements(candidate));
			const { db, log } = spyDb(inner);
			const store = createStore(db, candidate);
			store.install({
				address: {
					kind: 'value',
					namespace: 'so.epicenter.ns00',
					value: 'settinga',
				},
				sequence: 5,
				presence: 'present',
				content: 1,
			});
			log.length = 0;
			// A higher-sequence install reads then writes.
			store.install({
				address: {
					kind: 'value',
					namespace: 'so.epicenter.ns00',
					value: 'settinga',
				},
				sequence: 9,
				presence: 'present',
				content: 2,
			});
			const begin = log.indexOf('begin@1');
			const end = log.indexOf('end@1');
			const select = log.indexOf('all@1');
			const write = log.lastIndexOf('run@1');
			expect(begin).toBeGreaterThanOrEqual(0);
			// Read and write are both inside the single transaction, read before write.
			expect(select).toBeGreaterThan(begin);
			expect(write).toBeGreaterThan(select);
			expect(write).toBeLessThan(end);
		});
	}
});

describe('installPage is exactly one transaction with in-transaction progress', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: one transaction, no nesting, progress inside`, () => {
			const inner = makeDb(ddlStatements(candidate));
			const { db, log } = spyDb(inner);
			const store = createStore(db, candidate);
			const page = [1, 2, 3].map((n) => ({
				address: {
					kind: 'value' as const,
					namespace: 'so.epicenter.ns00',
					value: `setting${n}`,
				},
				sequence: n,
				presence: 'present' as const,
				content: n,
			}));
			const result = store.installPage(page, () => log.push('progress@1'));
			expect(result.status).toBe('committed');
			if (result.status === 'committed')
				expect(result.outcomes).toEqual([
					'installed',
					'installed',
					'installed',
				]);
			// Exactly one transaction, and never a nested one.
			expect(log.filter((l) => l === 'begin@1').length).toBe(1);
			expect(log.filter((l) => l === 'end@1').length).toBe(1);
			expect(log.some((l) => l === 'begin@2')).toBe(false);
			// Progress is written inside the single transaction, before it ends.
			const progress = log.indexOf('progress@1');
			expect(progress).toBeGreaterThan(log.indexOf('begin@1'));
			expect(progress).toBeLessThan(log.indexOf('end@1'));
			// All three facts reconstruct.
			expect([...store.scanBySequence()].length).toBe(3);
		});
	}
});

describe('a corrupt page rolls back entirely and advances no progress', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: full rollback, no progress, witness unchanged, one transaction`, () => {
			const inner = makeDb(ddlStatements(candidate));
			const { db, log } = spyDb(inner);
			const store = createStore(db, candidate);
			// The reproduced probe page: new value A@1; same address+sequence but
			// divergent content (corruption); new value B@2.
			const a = {
				kind: 'value' as const,
				namespace: 'so.epicenter.ns00',
				value: 'settinga',
			};
			const b = {
				kind: 'value' as const,
				namespace: 'so.epicenter.ns00',
				value: 'settingb',
			};
			const page = [
				{ address: a, sequence: 1, presence: 'present' as const, content: 1 },
				{ address: a, sequence: 1, presence: 'present' as const, content: 999 },
				{ address: b, sequence: 2, presence: 'present' as const, content: 2 },
			];
			let progressCalled = false;
			const before = [...store.scanBySequence()].length;
			const result = store.installPage(page, () => {
				progressCalled = true;
			});
			// The page reports corruption at the middle fact and rolls the whole page back.
			expect(result.status).toBe('corruption');
			if (result.status === 'corruption') expect(result.index).toBe(1);
			// Progress was never written.
			expect(progressCalled).toBe(false);
			// Nothing was committed: A and B are both absent, witness unchanged.
			expect([...store.scanBySequence()].length).toBe(before);
			expect(store.get(a)).toBeUndefined();
			expect(store.get(b)).toBeUndefined();
			// Exactly one transaction, rolled back, never nested.
			expect(log.filter((l) => l === 'begin@1').length).toBe(1);
			expect(log.some((l) => l === 'begin@2')).toBe(false);
			// Integrity intact after the rollback.
			expect(
				db.all<{ integrity_check: string }>('PRAGMA integrity_check')[0]
					?.integrity_check,
			).toBe('ok');
		});
	}
});

describe('one-fact install preserves its outcome contract', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: installed, ignored (stale/equal), corruption`, () => {
			const store = createStore(makeDb(ddlStatements(candidate)), candidate);
			const v = {
				kind: 'value' as const,
				namespace: 'so.epicenter.ns00',
				value: 'settingz',
			};
			expect(
				store.install({
					address: v,
					sequence: 5,
					presence: 'present',
					content: 1,
				}),
			).toBe('installed');
			// Stale sequence is ignored.
			expect(
				store.install({
					address: v,
					sequence: 4,
					presence: 'present',
					content: 2,
				}),
			).toBe('ignored');
			// Equal sequence, identical content is ignored (a no-op).
			expect(
				store.install({
					address: v,
					sequence: 5,
					presence: 'present',
					content: 1,
				}),
			).toBe('ignored');
			// Equal sequence, divergent content is corruption; state unchanged.
			expect(
				store.install({
					address: v,
					sequence: 5,
					presence: 'present',
					content: 999,
				}),
			).toBe('corruption');
			const read = store.get(v);
			expect(
				read?.presence === 'present' && 'content' in read && read.content,
			).toBe(1);
		});
	}
});

describe('scan crosses page boundaries (corpus > 4096)', () => {
	const LARGE: TraceOptions = {
		...BASE,
		facts: 9000,
		targetLogicalStateBytes: 9000 * 220,
	};
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: paged scan and feed cover a multi-page corpus`, () => {
			const trace = makeTrace(LARGE);
			const db = makeDb(ddlStatements(candidate));
			const store = createStore(db, candidate);
			db.transaction(() => {
				for (const fact of trace.events()) store.install(fact);
			});
			const expected = trace.measure();
			expect(expected.currentCount).toBeGreaterThan(4096); // forces >1 page
			// The paged scanBySequence reconstructs the exact oracle across pages.
			const actual = factSetDigest(store.scanBySequence());
			expect(actual.count).toBe(expected.currentCount);
			expect(actual.digestHex).toBe(expected.digestHex);
			// feedPage cursor advances across at least two 4096 pages.
			const first = store.feedPage(0, 4096);
			expect(first.length).toBe(4096);
			const after = first[first.length - 1]?.sequence ?? 0;
			const second = store.feedPage(after, 4096);
			expect(second.length).toBeGreaterThan(0);
			expect((second[0]?.sequence ?? 0) > after).toBe(true);
		});
	}
});
