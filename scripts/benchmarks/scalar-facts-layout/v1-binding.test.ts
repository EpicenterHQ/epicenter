/**
 * The trace must be bound to the private V1 kernel: every representative fact is
 * admitted by `parseFact`, the trace byte oracle equals `encodedFactBytes`, and
 * all fact shapes are exercised. A tightened ceiling must make the binding refuse
 * rather than silently pass, proving the gate is real.
 */

import { describe, expect, test } from 'bun:test';

import { encodedFactBytes } from '../../../packages/data/src/protocol/v1/facts.js';
import {
	canonicalFactRecord,
	makeTrace,
	type TraceOptions,
	utf8Len,
} from './trace.js';
import { pilotLimits, verifyTraceV1Binding } from './v1-binding.js';

const BASE: Omit<TraceOptions, 'targetLogicalStateBytes'> = {
	facts: 6000,
	namespaceCount: 25,
	tableCount: 1000,
	valueRatio: 0.08,
	dataSeed: 7,
	maxEncodedFactBytes: 4096,
};

function trace(overrides: Partial<TraceOptions> = {}) {
	return makeTrace({
		...BASE,
		targetLogicalStateBytes: BASE.facts * 200,
		...overrides,
	});
}

describe('pilotLimits', () => {
	test('produces self-consistent ValidatedLimits', () => {
		// If validateLimits rejected, pilotLimits would have thrown.
		expect(() => pilotLimits()).not.toThrow();
	});
});

describe('the trace is bound to the V1 kernel', () => {
	test('every representative fact admits and byte-agrees', () => {
		const report = verifyTraceV1Binding(trace(), pilotLimits());
		expect(report.failures).toEqual([]);
		expect(report.bound).toBe(true);
		expect(report.checkedFacts).toBeGreaterThan(0);
	});

	test('all four fact shapes are exercised and admitted, even with a small sample', () => {
		// A deliberately tiny stride sample: the binding must still parse-check the
		// first occurrence of each shape, so all four are admitted, not only present.
		const report = verifyTraceV1Binding(trace(), pilotLimits(), {
			sampleSize: 8,
		});
		expect(report.bound).toBe(true);
		expect(report.shapes.rowPresent).toBeGreaterThan(0);
		expect(report.shapes.rowAbsent).toBeGreaterThan(0);
		expect(report.shapes.valuePresent).toBeGreaterThan(0);
		expect(report.shapes.valueAbsent).toBeGreaterThan(0);
	});

	test('a corpus missing an absent shape fails the binding (non-vacuous)', () => {
		// A tiny corpus with no tombstones or unsets lacks the absent shapes, so the
		// all-four requirement must refuse rather than pass on present shapes alone.
		const tiny = makeTrace({
			...BASE,
			facts: 20,
			valueRatio: 0.1,
			targetLogicalStateBytes: 20 * 80,
		});
		expect(tiny.observed().finalAbsent).toBe(0);
		const report = verifyTraceV1Binding(tiny, pilotLimits());
		expect(report.bound).toBe(false);
		expect(report.failures.join(' ')).toContain('never exercised');
	});

	test('the byte oracle equals encodedFactBytes fact-by-fact', () => {
		const t = trace();
		for (let index = 0; index < 200; index += 1) {
			const fact = t.finalFactAt(index);
			expect(utf8Len(canonicalFactRecord(fact))).toBe(encodedFactBytes(fact));
		}
	});
});

describe('the binding is a real gate, not vacuous', () => {
	test('a ceiling below the largest fact makes the binding refuse', () => {
		// Read the true maximum protocol-fact bytes, then set the ceiling one under.
		const t = trace({ targetLogicalStateBytes: BASE.facts * 300 });
		const maxBytes = t.calibration.maxProtocolFactBytesBound;
		const report = verifyTraceV1Binding(
			t,
			// Response ceilings are derived from this fact ceiling, so the refusal is
			// attributable to the fact ceiling, not to limits validation.
			pilotLimits({ maxEncodedFactBytes: maxBytes - 1 }),
		);
		expect(report.bound).toBe(false);
		expect(report.failures.length).toBeGreaterThan(0);
	});

	test('determinism: same trace and options give the same report', () => {
		const a = verifyTraceV1Binding(trace(), pilotLimits());
		const b = verifyTraceV1Binding(trace(), pilotLimits());
		expect(a).toEqual(b);
	});
});
