/**
 * Focused tests for the four layout candidates: DDL constraint refusals, the
 * monotonic install outcomes, and, above all, that every candidate independently
 * reconstructs the exact oracle state (count, current-protocol bytes, ordered
 * digest) after consuming the same event stream.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { CANDIDATES, createStore, ddlFor, layoutsSelfTest } from './layouts.js';
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

test('every candidate passes its constraint and transaction proofs', () => {
	expect(layoutsSelfTest()).toEqual([]);
});

describe('candidate reconstructs the exact oracle state', () => {
	for (const candidate of CANDIDATES) {
		test(candidate.id, () => {
			const trace = makeTrace(BASE);
			const db = new Database(':memory:');
			db.exec('PRAGMA foreign_keys = ON;');
			db.exec(ddlFor(candidate));
			const store = createStore(db, candidate);
			db.exec('BEGIN');
			for (const fact of trace.events()) store.install(fact);
			db.exec('COMMIT');

			const expected = trace.measure();
			const actual = factSetDigest(store.scanBySequence());
			expect(actual.count).toBe(expected.currentCount);
			expect(actual.bytes).toBe(expected.currentProtocolFactBytes);
			expect(actual.digestHex).toBe(expected.digestHex);

			// A point read matches the analytical oracle.
			const sample = trace.finalFactAt(BASE.namespaceCount + 1);
			const read = store.get(sample.address);
			expect(read).toEqual(sample);
			db.close();
		});
	}
});

describe('query plans', () => {
	for (const candidate of CANDIDATES) {
		test(`${candidate.id}: feed avoids a temp b-tree and value point plan exists`, () => {
			const db = new Database(':memory:');
			db.exec('PRAGMA foreign_keys = ON;');
			db.exec(ddlFor(candidate));
			const store = createStore(db, candidate);
			const feed = store.queryPlan('feed').toUpperCase();
			expect(feed).not.toContain('TEMP B-TREE');
			expect(feed).not.toContain('USE TEMP');
			// The value point read must have its own plan, never be omitted.
			expect(store.queryPlan('valuePoint').length).toBeGreaterThan(0);
			expect(store.queryPlan('rowPoint').length).toBeGreaterThan(0);
			db.close();
		});
	}
});
