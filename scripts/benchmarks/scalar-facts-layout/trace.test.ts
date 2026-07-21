/**
 * Focused tests for the deterministic trace and its analytical oracle. These
 * gate the layout work: exact present-logical-state bytes on uneven envelopes,
 * exact live-address counts, dense unique sequences, digest sensitivity, actual
 * V1 canonical bytes, the ADR-0167 logical/protocol split, distinct samples, and
 * analytical-vs-fold agreement.
 */

import { describe, expect, test } from 'bun:test';

import {
	canonicalize,
	sha256Hex,
	utf8ByteLength,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	type Address,
	addressKey,
	canonicalFactRecord,
	type Fact,
	factSetDigest,
	factsForPresentTarget,
	logicalRecord,
	makeTrace,
	presentCountFor,
	type TraceOptions,
} from './trace.js';

const BASE: Omit<TraceOptions, 'targetLogicalStateBytes'> = {
	facts: 6000,
	namespaceCount: 25,
	tableCount: 1000,
	valueRatio: 0.08,
	dataSeed: 7,
	maxEncodedFactBytes: 4096,
};

class SmokeOracle {
	private readonly current = new Map<string, Fact>();

	apply(fact: Fact): void {
		const key = addressKey(fact.address);
		const prior = this.current.get(key);
		if (prior === undefined) {
			this.current.set(key, fact);
			return;
		}
		if (fact.sequence < prior.sequence) return;
		if (fact.sequence === prior.sequence) {
			if (canonicalFactRecord(fact) !== canonicalFactRecord(prior))
				throw new Error('equal sequence, different content');
			return;
		}
		if (
			prior.address.kind === 'row' &&
			prior.presence === 'absent' &&
			fact.presence === 'present'
		)
			return;
		this.current.set(key, fact);
	}

	get(address: Address): Fact | undefined {
		return this.current.get(addressKey(address));
	}
}

const ROW_ADDRESS: Address = {
	kind: 'row',
	namespace: 'so.epicenter.ns00',
	table: 'collection0000',
	rowId: 'a'.repeat(24),
};
const VALUE_ADDRESS: Address = {
	kind: 'value',
	namespace: 'so.epicenter.ns00',
	value: 'settingx',
};

describe('independent fold laws', () => {
	test('a row tombstone cannot be resurrected', () => {
		const oracle = new SmokeOracle();
		oracle.apply({
			address: ROW_ADDRESS,
			sequence: 1,
			presence: 'present',
			fields: { a: 1 },
		});
		oracle.apply({ address: ROW_ADDRESS, sequence: 2, presence: 'absent' });
		oracle.apply({
			address: ROW_ADDRESS,
			sequence: 3,
			presence: 'present',
			fields: { a: 2 },
		});
		expect(oracle.get(ROW_ADDRESS)?.presence).toBe('absent');
	});

	test('a value unset can be resurrected by a later value', () => {
		const oracle = new SmokeOracle();
		oracle.apply({
			address: VALUE_ADDRESS,
			sequence: 1,
			presence: 'present',
			content: 'a',
		});
		oracle.apply({ address: VALUE_ADDRESS, sequence: 2, presence: 'absent' });
		oracle.apply({
			address: VALUE_ADDRESS,
			sequence: 3,
			presence: 'present',
			content: 'b',
		});
		expect(oracle.get(VALUE_ADDRESS)).toEqual({
			address: VALUE_ADDRESS,
			sequence: 3,
			presence: 'present',
			content: 'b',
		});
	});

	test('a stale sequence cannot replace the current value', () => {
		const oracle = new SmokeOracle();
		oracle.apply({
			address: VALUE_ADDRESS,
			sequence: 5,
			presence: 'present',
			content: 'new',
		});
		oracle.apply({
			address: VALUE_ADDRESS,
			sequence: 3,
			presence: 'present',
			content: 'old',
		});
		expect(oracle.get(VALUE_ADDRESS)?.sequence).toBe(5);
	});

	test('equal sequences with different content are rejected', () => {
		const oracle = new SmokeOracle();
		oracle.apply({
			address: VALUE_ADDRESS,
			sequence: 5,
			presence: 'present',
			content: 'first',
		});
		expect(() =>
			oracle.apply({
				address: VALUE_ADDRESS,
				sequence: 5,
				presence: 'present',
				content: 'other',
			}),
		).toThrow('equal sequence, different content');
	});
});

test('the analytical oracle agrees with an independent event fold', () => {
	const trace = makeTrace({
		facts: 900,
		namespaceCount: 5,
		tableCount: 16,
		valueRatio: 0.1,
		dataSeed: 12345,
		maxEncodedFactBytes: 4096,
		targetLogicalStateBytes: 900 * 120 + 777,
	});
	const folded = new SmokeOracle();
	const sequences = new Set<number>();
	let maxSequence = 0;
	for (const fact of trace.events()) {
		folded.apply(fact);
		sequences.add(fact.sequence);
		maxSequence = Math.max(maxSequence, fact.sequence);
	}

	expect(sequences.size).toBe(maxSequence);
	for (let index = 0; index < trace.options.facts; index += 1) {
		const analytical = trace.finalFactAt(index);
		const viaFold = folded.get(analytical.address);
		expect(viaFold).toBeDefined();
		if (viaFold !== undefined) {
			expect(canonicalFactRecord(viaFold)).toBe(
				canonicalFactRecord(analytical),
			);
		}
	}
});

describe('exact calibration to present logical-state bytes', () => {
	const baseLogicalBytes = makeTrace({ ...BASE, targetLogicalStateBytes: 1 })
		.calibration.baseLogicalBytes;
	for (const targetLogicalStateBytes of [
		baseLogicalBytes + 1,
		baseLogicalBytes + 4099,
		baseLogicalBytes + (BASE.facts - 1),
		baseLogicalBytes + BASE.facts * 300 + 4242,
	]) {
		test(`hits ${targetLogicalStateBytes} present bytes exactly`, () => {
			const trace = makeTrace({ ...BASE, targetLogicalStateBytes });
			expect(trace.calibration.traceAdmissible).toBe(true);
			expect(trace.calibration.achievedLogicalStateBytes).toBe(
				targetLogicalStateBytes,
			);
			expect(trace.measure().presentLogicalStateBytes).toBe(
				targetLogicalStateBytes,
			);
		});
	}

	test('a target below the minimal present frame is not trace-admissible', () => {
		expect(
			makeTrace({ ...BASE, targetLogicalStateBytes: 1 }).calibration
				.traceAdmissible,
		).toBe(false);
	});
});

describe('exact live-address count for the full-profile shape', () => {
	for (const presentTarget of [5000, 5321, 9999]) {
		test(`factsForPresentTarget yields exactly ${presentTarget} present addresses`, () => {
			const facts = factsForPresentTarget(presentTarget, BASE.valueRatio);
			expect(facts).not.toBeNull();
			const trace = makeTrace({
				...BASE,
				facts: facts as number,
				targetLogicalStateBytes: (facts as number) * 200,
			});
			expect(trace.observed().finalPresent).toBe(presentTarget);
			expect(trace.measure().presentCount).toBe(presentTarget);
		});
	}

	test('never returns a false exact count: it is exact or null', () => {
		// The reviewer's counterexamples: whatever these ratios yield, the result is
		// either an exact corpus or an explicit refusal, never a wrong count.
		for (const [presentTarget, valueRatio] of [
			[1_000_000, 0.0427],
			[1_000_000, 0.1169],
			[21, 0.911],
			[1_000_000, 0.08],
		] as const) {
			const facts = factsForPresentTarget(presentTarget, valueRatio);
			if (facts === null) continue; // refusal is honest
			expect(presentCountFor(facts, valueRatio)).toBe(presentTarget);
		}
	});

	test('the intended 0.08 full profile is exactly 1,000,000 live over 1,048,805 facts', () => {
		// Analytical (no corpus build). The CLI/runner asserts this at runtime before
		// candidates; the byte-exact 512 MiB check is a runtime assertion too.
		const facts = factsForPresentTarget(1_000_000, 0.08);
		expect(facts).toBe(1_048_805);
		expect(presentCountFor(facts as number, 0.08)).toBe(1_000_000);
	});
});

describe('two distinct byte measures (ADR-0167)', () => {
	test('present logical state and current protocol facts are separate quantities', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		});
		const m = trace.measure();
		// Current includes terminal absences; present excludes them.
		expect(m.currentCount).toBeGreaterThan(m.presentCount);
		// The protocol record carries address+presence+sequence framing the logical
		// record omits, so per surviving fact it is larger; measures never coincide.
		expect(m.currentProtocolFactBytes).not.toBe(m.presentLogicalStateBytes);
		expect(m.maxProtocolFactBytes).toBeGreaterThan(0);
		expect(m.maxLogicalRecordBytes).toBeGreaterThan(0);
	});

	test('logicalRecord omits sequence and presence and skips absent facts', () => {
		const present: Fact = {
			address: {
				kind: 'value',
				namespace: 'so.epicenter.ns00',
				value: 'settingz',
			},
			sequence: 42,
			presence: 'present',
			content: 7,
		};
		const record = logicalRecord(present);
		expect(record).not.toBeNull();
		expect(record).not.toContain('sequence');
		expect(record).not.toContain('presence');
		expect(
			logicalRecord({
				address: present.address,
				sequence: 43,
				presence: 'absent',
			}),
		).toBeNull();
	});
});

describe('dense unique sequences', () => {
	test('every emitted event has a distinct sequence with no gaps', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		});
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
		expect(max).toBe(total);
	});
});

describe('strong ordered digest', () => {
	const trace = makeTrace({
		...BASE,
		targetLogicalStateBytes: BASE.facts * 200,
	});
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
		const w = factSetDigest(facts.slice(1));
		expect(w.count).toBe(base.count - 1);
		expect(w.digestHex).not.toBe(base.digestHex);
	});
	test('a duplicated record changes count and digest', () => {
		const first = facts[0];
		if (first === undefined) throw new Error('missing sample');
		const w = factSetDigest([first, ...facts]);
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
			presence: 'present',
			fields: { body: 'xx', ordinal: 5, phase: 1 },
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
		expect(canonicalFactRecord(fact)).toContain('"presence":"present"');
		const absent = canonicalFactRecord({
			address: fact.address,
			sequence: 10,
			presence: 'absent',
		});
		expect(absent).toContain('"presence":"absent"');
		expect(absent).not.toContain('fields');
	});
});

describe('max fact-size ceiling gate (ADR-0163)', () => {
	// Read the bound under a generous ceiling, then prove exact pass and refusal.
	const bound = makeTrace({
		...BASE,
		targetLogicalStateBytes: BASE.facts * 300,
		maxEncodedFactBytes: 1_000_000,
	}).calibration.maxProtocolFactBytesBound;

	test('a ceiling exactly at the bound is trace-admissible', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 300,
			maxEncodedFactBytes: bound,
		});
		expect(trace.calibration.traceAdmissible).toBe(true);
		expect(trace.calibration.inadmissibleBecause).toBe('none');
	});

	test('a ceiling one byte under the bound refuses', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 300,
			maxEncodedFactBytes: bound - 1,
		});
		expect(trace.calibration.traceAdmissible).toBe(false);
		expect(trace.calibration.inadmissibleBecause).toBe('fact-ceiling');
	});
});

describe('digest framing uses UTF-8 byte length', () => {
	test('a multibyte record is framed by its UTF-8 length', () => {
		const fact: Fact = {
			address: {
				kind: 'value',
				namespace: 'so.epicenter.ns00',
				value: 'settingu',
			},
			sequence: 1,
			presence: 'present',
			content: '€uro\u{1f600}',
		};
		const record = canonicalFactRecord(fact);
		// A multibyte payload makes UTF-16 length differ from UTF-8 length.
		expect(record.length).not.toBe(utf8ByteLength(record));
		// Independent oracle: the kernel's one-shot sha256Hex over the same framed
		// string must equal the trace's streaming digest.
		const framed = `${utf8ByteLength(record)}:${record}\n`;
		expect(factSetDigest([fact]).digestHex).toBe(sha256Hex(framed));
	});
});

describe('terminal rows carry a representative initial payload', () => {
	test('a later-tombstoned row still has a non-empty initial body', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 300,
		});
		const quotient = trace.calibration.quotient;
		expect(quotient).toBeGreaterThan(0);
		// Index 480 (>= valueCount 480, and 480 % 20 == 0) is a tombstoned row.
		const tombstonedAddress = addressKey(trace.finalFactAt(480).address);
		expect(trace.finalFactAt(480).presence).toBe('absent');
		let initialBodyLen = -1;
		for (const fact of trace.events()) {
			if (
				addressKey(fact.address) === tombstonedAddress &&
				fact.presence === 'present' &&
				'fields' in fact
			) {
				initialBodyLen = String(fact.fields.body).length;
				break;
			}
		}
		expect(initialBodyLen).toBe(quotient);
	});
});

describe('lifecycle coverage', () => {
	test('the corpus exercises every aging lifecycle', () => {
		const observed = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		}).observed();
		expect(observed.rewrites).toBeGreaterThan(0);
		expect(observed.rowTombstones).toBeGreaterThan(0);
		expect(observed.valueUnsets).toBeGreaterThan(0);
		expect(observed.valueResurrections).toBeGreaterThan(0);
		expect(observed.initialAbsentThenPresent).toBeGreaterThan(0);
		expect(observed.finalPresent + observed.finalAbsent).toBe(BASE.facts);
		expect(observed.values + observed.rows).toBe(BASE.facts);
	});
});

describe('guaranteed distinct samples', () => {
	test('row and value samples return exactly the requested distinct count', () => {
		const trace = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		});
		const rows = trace.sampleRowAddresses(500).map(addressKey);
		const values = trace.sampleValueAddresses(200).map(addressKey);
		expect(rows.length).toBe(500);
		expect(values.length).toBe(200);
		expect(new Set(rows).size).toBe(500);
		expect(new Set(values).size).toBe(200);
	});
});

describe('determinism', () => {
	test('same seed reproduces the measure; different seed diverges', () => {
		const a = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		}).measure();
		const b = makeTrace({
			...BASE,
			targetLogicalStateBytes: BASE.facts * 200,
		}).measure();
		const c = makeTrace({
			...BASE,
			dataSeed: 8,
			targetLogicalStateBytes: BASE.facts * 200,
		}).measure();
		expect(a).toEqual(b);
		expect(c.digestHex).not.toBe(a.digestHex);
	});
});
