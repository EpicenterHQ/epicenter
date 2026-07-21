/**
 * Focused tests for the deterministic trace and its analytical oracle. These
 * gate the layout work: exact target bytes on uneven envelopes, dense unique
 * sequences, digest sensitivity, actual V1 canonical bytes, distinct samples,
 * and analytical-vs-fold agreement.
 */
import { describe, expect, test } from 'bun:test';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	addressKey,
	canonicalFactRecord,
	type Fact,
	factSetDigest,
	makeTrace,
	type TraceOptions,
	traceSelfTest,
} from './trace.js';

const BASE: Omit<TraceOptions, 'targetFinalBytes'> = {
	facts: 6000,
	namespaceCount: 25,
	tableCount: 1000,
	valueRatio: 0.08,
	dataSeed: 7,
};

test('the fold and analytical self-tests pass', () => {
	expect(traceSelfTest()).toEqual([]);
});

describe('exact calibration to final canonical bytes', () => {
	// Several deliberately uneven targets so the quotient/remainder split is
	// exercised, not just clean multiples.
	// Derive targets from the minimal frame so they are always feasible, with
	// uneven deltas so the quotient/remainder split is exercised.
	const baseBytes = makeTrace({ ...BASE, targetFinalBytes: 1 }).calibration
		.baseBytes;
	for (const targetFinalBytes of [
		baseBytes + 1,
		baseBytes + 4099,
		baseBytes + (BASE.facts - 1),
		baseBytes + BASE.facts * 300 + 4242,
	]) {
		test(`hits ${targetFinalBytes} bytes exactly`, () => {
			const trace = makeTrace({ ...BASE, targetFinalBytes });
			expect(trace.calibration.qualifying).toBe(true);
			expect(trace.calibration.achievedFinalBytes).toBe(targetFinalBytes);
			// And the streamed witness agrees to the byte.
			expect(trace.oracleWitness().canonicalBytes).toBe(targetFinalBytes);
		});
	}

	test('a target below the minimal frame is marked non-qualifying', () => {
		const trace = makeTrace({ ...BASE, targetFinalBytes: 1 });
		expect(trace.calibration.qualifying).toBe(false);
	});
});

describe('dense unique sequences', () => {
	test('every emitted event has a distinct sequence with no gaps', () => {
		const trace = makeTrace({ ...BASE, targetFinalBytes: BASE.facts * 200 });
		const seen = new Set<number>();
		let max = 0;
		let total = 0;
		for (const fact of trace.events()) {
			expect(seen.has(fact.sequence)).toBe(false);
			seen.add(fact.sequence);
			max = Math.max(max, fact.sequence);
			total += 1;
		}
		expect(seen.size).toBe(total);
		expect(max).toBe(total); // dense: sequences are exactly 1..total
	});
});

describe('strong ordered digest', () => {
	const trace = makeTrace({ ...BASE, targetFinalBytes: BASE.facts * 200 });
	const facts: Fact[] = [];
	for (let index = 0; index < 200; index += 1)
		facts.push(trace.finalFactAt(index));
	const base = factSetDigest(facts);

	test('a single changed record changes the digest', () => {
		const changed = facts.slice();
		const f = changed[3];
		if (f === undefined) throw new Error('missing sample');
		changed[3] = { ...f, sequence: f.sequence + 1_000_000 };
		expect(factSetDigest(changed).digestHex).not.toBe(base.digestHex);
	});
	test('a missing record changes count and digest', () => {
		const missing = facts.slice(1);
		const w = factSetDigest(missing);
		expect(w.count).toBe(base.count - 1);
		expect(w.digestHex).not.toBe(base.digestHex);
	});
	test('a duplicated record changes count and digest', () => {
		const first = facts[0];
		if (first === undefined) throw new Error('missing sample');
		const dup = [first, ...facts];
		const w = factSetDigest(dup);
		expect(w.count).toBe(base.count + 1);
		expect(w.digestHex).not.toBe(base.digestHex);
	});
});

describe('actual V1 canonical bytes', () => {
	test('a fact record is the kernel canonicalize of the real Fact shape', () => {
		const fact: Fact = {
			address: {
				kind: 'row',
				namespace: 'so.epicenter.ns00',
				table: 'collection0001',
				rowId: '00000000000000000000000z',
			},
			sequence: 9,
			present: true,
			payload: { body: 'xx', ordinal: 5, phase: 1 },
		};
		const expected = canonicalize({
			address: {
				kind: 'row',
				namespace: 'so.epicenter.ns00',
				rowId: '00000000000000000000000z',
				table: 'collection0001',
			},
			fields: { body: 'xx', ordinal: 5, phase: 1 },
			presence: 'present',
			sequence: 9,
		});
		expect(canonicalFactRecord(fact)).toBe(expected);
		// The presence axis and structured address must be in the bytes.
		expect(canonicalFactRecord(fact)).toContain('"presence":"present"');
		const absent = canonicalFactRecord({
			address: fact.address,
			sequence: 10,
			present: false,
		});
		expect(absent).toContain('"presence":"absent"');
		expect(absent).not.toContain('fields');
	});
});

describe('lifecycle coverage', () => {
	test('the corpus exercises every aging lifecycle', () => {
		const observed = makeTrace({
			...BASE,
			targetFinalBytes: BASE.facts * 200,
		}).observed();
		expect(observed.rewrites).toBeGreaterThan(0);
		expect(observed.rowTombstones).toBeGreaterThan(0);
		expect(observed.valueUnsets).toBeGreaterThan(0);
		expect(observed.valueResurrections).toBeGreaterThan(0);
		expect(observed.initialAbsentThenPresent).toBeGreaterThan(0);
		expect(observed.namespaces).toBeLessThanOrEqual(BASE.namespaceCount);
		expect(observed.values + observed.rows).toBe(BASE.facts);
	});
});

describe('guaranteed distinct samples', () => {
	test('row and value samples return exactly the requested distinct count', () => {
		const trace = makeTrace({ ...BASE, targetFinalBytes: BASE.facts * 200 });
		const rows = trace.sampleRowAddresses(500).map(addressKey);
		const values = trace.sampleValueAddresses(200).map(addressKey);
		expect(rows.length).toBe(500);
		expect(values.length).toBe(200);
		expect(new Set(rows).size).toBe(500);
		expect(new Set(values).size).toBe(200);
	});
});

describe('determinism', () => {
	test('same seed reproduces the witness; different seed diverges', () => {
		const a = makeTrace({
			...BASE,
			targetFinalBytes: BASE.facts * 200,
		}).oracleWitness();
		const b = makeTrace({
			...BASE,
			targetFinalBytes: BASE.facts * 200,
		}).oracleWitness();
		const c = makeTrace({
			...BASE,
			dataSeed: 8,
			targetFinalBytes: BASE.facts * 200,
		}).oracleWitness();
		expect(a).toEqual(b);
		expect(c.digestHex).not.toBe(a.digestHex);
	});
});
