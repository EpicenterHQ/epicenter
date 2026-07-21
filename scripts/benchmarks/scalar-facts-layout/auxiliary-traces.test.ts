/**
 * The auxiliary owner traces must be deterministic, bound to the V1 kernel where
 * a wire shape exists, and address-bearing so the coordinate-layout decision
 * reaches every owner table. A different seed must change the hashes.
 */

import { describe, expect, test } from 'bun:test';
import {
	allAuxiliaryBound,
	DEFAULT_AUXILIARY_OPTIONS,
	makeAuxiliaryTraces,
} from './auxiliary-traces.js';
import { makeTrace, type TraceOptions } from './trace.js';
import { pilotLimits } from './v1-binding.js';

const BASE: Omit<TraceOptions, 'targetLogicalStateBytes'> = {
	facts: 6000,
	namespaceCount: 25,
	tableCount: 1000,
	valueRatio: 0.08,
	dataSeed: 7,
	maxEncodedFactBytes: 4096,
};

function trace(seed = 7) {
	return makeTrace({
		...BASE,
		dataSeed: seed,
		targetLogicalStateBytes: BASE.facts * 200,
	});
}

describe('all auxiliary states bind to the V1 kernel', () => {
	const aux = makeAuxiliaryTraces(trace(), pilotLimits());

	test('pending intents admit under parseIntent', () => {
		expect(aux.pending.v1Bound).toBe(true);
		expect(aux.pending.count).toBe(DEFAULT_AUXILIARY_OPTIONS.pendingCount);
	});
	test('the sealed submission admits under parseSubmissionRequest', () => {
		expect(aux.sealed.v1Bound).toBe(true);
		expect(aux.sealed.count).toBe(1);
	});
	test('parked entries match the V1 ParkedIntent shape', () => {
		expect(aux.parked.v1Bound).toBe(true);
		expect(aux.parked.entries.every((p) => p.code === 'fact-too-large')).toBe(
			true,
		);
		expect(
			aux.parked.entries.every((p) => p.measuredBytes > p.limitBytes),
		).toBe(true);
	});
	test('document liveness and retry ledger are present and address-bearing', () => {
		expect(aux.document.count).toBeGreaterThan(0);
		expect(aux.document.entries.every((d) => d.address.kind === 'row')).toBe(
			true,
		);
		expect(aux.retry.count).toBe(DEFAULT_AUXILIARY_OPTIONS.replicaCount);
	});
	test('the convenience predicate agrees', () => {
		expect(allAuxiliaryBound(aux)).toBe(true);
	});
});

describe('every auxiliary state is address-bearing', () => {
	test('pending intents carry structured addresses of both kinds', () => {
		const aux = makeAuxiliaryTraces(trace(), pilotLimits());
		const kinds = new Set(aux.pending.entries.map((i) => i.address.kind));
		expect(kinds.has('row')).toBe(true);
		expect(kinds.has('value')).toBe(true);
	});
});

describe('determinism and seed sensitivity', () => {
	test('same seed reproduces every digest', () => {
		const a = makeAuxiliaryTraces(trace(7), pilotLimits());
		const b = makeAuxiliaryTraces(trace(7), pilotLimits());
		expect(a.pending.digestHex).toBe(b.pending.digestHex);
		expect(a.sealed.digestHex).toBe(b.sealed.digestHex);
		expect(a.parked.digestHex).toBe(b.parked.digestHex);
		expect(a.document.digestHex).toBe(b.document.digestHex);
		expect(a.retry.digestHex).toBe(b.retry.digestHex);
	});

	test('a different seed changes the digests', () => {
		const a = makeAuxiliaryTraces(trace(7), pilotLimits());
		const b = makeAuxiliaryTraces(trace(8), pilotLimits());
		expect(a.pending.digestHex).not.toBe(b.pending.digestHex);
		expect(a.document.digestHex).not.toBe(b.document.digestHex);
	});
});
