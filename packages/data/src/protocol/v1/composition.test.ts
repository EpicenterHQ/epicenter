/**
 * Scalar V1 Operation Composition Tests
 *
 * Proves the one composition law: compacting two operations into one
 * reproduces sequential application through the authority fold against every
 * base state, with tombstone absorption evaluated first, before any payload or
 * operation-specific logic.
 *
 * Key behaviors:
 * - Randomized operation sequences compacted to one operation equal
 *   sequential fold application from every base state, including bases with
 *   unknown fields, null payloads, scalars, and arrays
 * - Every tombstone pairing absorbs: an older tombstone absorbs every newer
 *   operation, and a newer tombstone absorbs every older one, including
 *   `unset` then `tombstone` (which is tombstone, never unset)
 * - A sequentially parked patch (live non-object base) is reproduced: the
 *   compacted operation parks against the same base, or composition itself
 *   refuses exactly where sequential application parks
 * - A composed patch keeps its set and unset disjoint
 */
import { describe, expect, test } from 'bun:test';

import {
	composeOperations,
	type Fact,
	foldIntent,
	type Intent,
	type JsonValue,
	type Operation,
	type RecordAddress,
} from './index.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'abc123def456ghi789jkl012',
};

const intentOf = (operation: Operation): Intent => ({
	address: ADDRESS,
	...operation,
});

/** The observable per-address outcome, ignoring sequences: state plus payload. */
type Observed =
	| { state: 'missing' }
	| { state: 'live'; payload: JsonValue }
	| { state: 'tombstone' }
	| { state: 'unset' };

const observe = (fact: Fact | undefined): Observed => {
	if (fact === undefined) return { state: 'missing' };
	if (fact.state === 'live') return { state: 'live', payload: fact.payload };
	return { state: fact.state };
};

const factOf = (observed: Observed, sequence: number): Fact | undefined => {
	if (observed.state === 'missing') return undefined;
	if (observed.state === 'live') {
		return {
			address: ADDRESS,
			sequence,
			state: 'live',
			payload: observed.payload,
		};
	}
	return { address: ADDRESS, sequence, state: observed.state };
};

/**
 * Apply operations in order through the authority fold. A refused patch parks:
 * the current fact is unchanged and later operations still apply, exactly as
 * the authority adjudicates a submission. Returns the final observed state and
 * the indexes that parked.
 */
const applySequentially = (
	base: Observed,
	operations: readonly Operation[],
): { final: Observed; parkedAt: number[] } => {
	let current = factOf(base, 1);
	let sequence = 2;
	const parkedAt: number[] = [];
	for (const [index, operation] of operations.entries()) {
		const outcome = foldIntent(current, intentOf(operation), sequence);
		if (outcome.kind === 'refused') {
			parkedAt.push(index);
			continue;
		}
		if (outcome.kind === 'changed') {
			current = outcome.fact;
			sequence += 1;
		}
	}
	return { final: observe(current), parkedAt };
};

/** Left-fold composition; refusal reports the operation index that refused. */
const compact = (
	operations: readonly Operation[],
): { operation: Operation } | { refusedAt: number } => {
	let composed: Operation | undefined;
	for (const [index, operation] of operations.entries()) {
		if (composed === undefined) {
			composed = operation;
			continue;
		}
		const outcome = composeOperations(composed, operation);
		if (outcome.kind === 'refused') return { refusedAt: index };
		composed = outcome.operation;
	}
	if (composed === undefined) throw new Error('empty sequence');
	return { operation: composed };
};

const BASES: Observed[] = [
	{ state: 'missing' },
	{ state: 'live', payload: { title: 'A', unknownField: [1, { deep: null }] } },
	{ state: 'live', payload: {} },
	{ state: 'live', payload: null },
	{ state: 'live', payload: 'scalar' },
	{ state: 'live', payload: [1, 2, 3] },
	{ state: 'tombstone' },
	{ state: 'unset' },
];

const OPERATIONS: Operation[] = [
	{ op: 'patch', set: { a: 1 }, unset: [] },
	{ op: 'replace', value: { x: 1 } },
	{ op: 'tombstone' },
	{ op: 'unset' },
];

describe('every tombstone pairing absorbs first', () => {
	for (const other of OPERATIONS) {
		test(`tombstone then ${other.op} composes to tombstone`, () => {
			expect(composeOperations({ op: 'tombstone' }, other)).toEqual({
				kind: 'composed',
				operation: { op: 'tombstone' },
			});
		});
		test(`${other.op} then tombstone composes to tombstone`, () => {
			expect(composeOperations(other, { op: 'tombstone' })).toEqual({
				kind: 'composed',
				operation: { op: 'tombstone' },
			});
		});
	}

	test('unset then tombstone is tombstone, never unset', () => {
		// The one ordering a literal newer-wins table gets wrong: absorption is
		// evaluated before the newer operation's own rule.
		expect(composeOperations({ op: 'unset' }, { op: 'tombstone' })).toEqual({
			kind: 'composed',
			operation: { op: 'tombstone' },
		});
	});
});

describe('targeted composition cells', () => {
	test('unset then replace is legal resurrection', () => {
		expect(
			composeOperations({ op: 'unset' }, { op: 'replace', value: 'again' }),
		).toEqual({
			kind: 'composed',
			operation: { op: 'replace', value: 'again' },
		});
	});

	test('unset then patch compacts to a replace over the empty base', () => {
		// A compacted patch would fold over an arbitrary live base at the
		// authority; the unset established an empty base, so the compacted form
		// must carry it whole.
		expect(
			composeOperations(
				{ op: 'unset' },
				{ op: 'patch', set: { a: 1 }, unset: ['gone'] },
			),
		).toEqual({
			kind: 'composed',
			operation: { op: 'replace', value: { a: 1 } },
		});
	});

	test('replace then patch folds into the replacement value', () => {
		expect(
			composeOperations(
				{ op: 'replace', value: { keep: true, drop: 1 } },
				{ op: 'patch', set: { added: null }, unset: ['drop'] },
			),
		).toEqual({
			kind: 'composed',
			operation: { op: 'replace', value: { keep: true, added: null } },
		});
	});

	test('patch after a non-object replace refuses as patch-base-not-object', () => {
		for (const value of ['scalar', 0, false, null, [1]] as JsonValue[]) {
			expect(
				composeOperations(
					{ op: 'replace', value },
					{ op: 'patch', set: { a: 1 }, unset: [] },
				),
			).toEqual({ kind: 'refused', code: 'patch-base-not-object' });
		}
	});

	test('patch then patch merges with newer set and unset overriding', () => {
		expect(
			composeOperations(
				{ op: 'patch', set: { a: 1, b: 2, c: 3 }, unset: ['x', 'y'] },
				{ op: 'patch', set: { b: 9, x: 0 }, unset: ['a'] },
			),
		).toEqual({
			kind: 'composed',
			operation: {
				op: 'patch',
				set: { c: 3, b: 9, x: 0 },
				unset: ['y', 'a'],
			},
		});
	});

	test('patch then unset discards the patch', () => {
		expect(
			composeOperations(
				{ op: 'patch', set: { a: 1 }, unset: [] },
				{ op: 'unset' },
			),
		).toEqual({ kind: 'composed', operation: { op: 'unset' } });
	});
});

describe('composed patches stay disjoint', () => {
	test('a composed patch never sets and unsets the same key', () => {
		const outcome = composeOperations(
			{ op: 'patch', set: { a: 1, b: 1 }, unset: ['c', 'd'] },
			{ op: 'patch', set: { c: 2 }, unset: ['a'] },
		);
		if (outcome.kind !== 'composed' || outcome.operation.op !== 'patch') {
			throw new Error('expected a composed patch');
		}
		const setKeys = Object.keys(outcome.operation.set);
		for (const key of outcome.operation.unset) {
			expect(setKeys).not.toContain(key);
		}
		expect(new Set(outcome.operation.unset).size).toBe(
			outcome.operation.unset.length,
		);
	});
});

describe('pairwise composition equals sequential application', () => {
	// The full 4x4 operation table over every base state: composing any two
	// operations reproduces applying them in sequence, or refuses exactly where
	// sequential application parks the newer patch.
	for (const older of OPERATIONS) {
		for (const newer of OPERATIONS) {
			test(`${older.op} then ${newer.op} over every base`, () => {
				for (const base of BASES) {
					const sequential = applySequentially(base, [older, newer]);
					const compacted = compact([older, newer]);
					if ('refusedAt' in compacted) {
						// Composition refuses only a patch over an established non-object
						// replacement. Sequential application parks that same patch from
						// every base, except a stored tombstone, which absorbs everything
						// before the patch base is ever probed.
						if (base.state === 'tombstone') {
							expect(sequential.parkedAt).toEqual([]);
							expect(sequential.final).toEqual({ state: 'tombstone' });
						} else {
							expect(sequential.parkedAt).toContain(compacted.refusedAt);
						}
						continue;
					}
					const once = applySequentially(base, [compacted.operation]);
					expect(once.final).toEqual(sequential.final);
				}
			});
		}
	}
});

describe('randomized sequences equal sequential application', () => {
	// Deterministic PRNG so a failure reproduces byte-for-byte.
	const prng = (seed: number) => {
		let state = seed >>> 0;
		return () => {
			state = (state * 1664525 + 1013904223) >>> 0;
			return state / 2 ** 32;
		};
	};

	const FIELD_KEYS = ['a', 'b', 'c', 'unknownField'];
	const randomValue = (next: () => number): JsonValue => {
		const pick = next();
		if (pick < 0.2) return null;
		if (pick < 0.4) return Math.floor(next() * 10);
		if (pick < 0.6) return `s${Math.floor(next() * 10)}`;
		if (pick < 0.8) return [Math.floor(next() * 10)];
		return { nested: Math.floor(next() * 10) };
	};
	const randomPatch = (next: () => number): Operation => {
		const set: Record<string, JsonValue> = {};
		const unset: string[] = [];
		for (const key of FIELD_KEYS) {
			const roll = Math.floor(next() * 3);
			if (roll === 1) set[key] = randomValue(next);
			if (roll === 2) unset.push(key);
		}
		return { op: 'patch', set, unset };
	};
	const randomOperation = (next: () => number): Operation => {
		const roll = Math.floor(next() * 5);
		if (roll <= 1) return randomPatch(next);
		if (roll === 2) return { op: 'replace', value: randomValue(next) };
		if (roll === 3) return { op: 'tombstone' };
		return { op: 'unset' };
	};

	test('2,000 random sequences across every base state', () => {
		const next = prng(0x51a7e);
		let comparisons = 0;
		let refusalCorrespondences = 0;
		for (let round = 0; round < 2000; round += 1) {
			const length = 1 + Math.floor(next() * 8);
			const operations = Array.from({ length }, () => randomOperation(next));
			const compacted = compact(operations);
			for (const base of BASES) {
				const sequential = applySequentially(base, operations);
				if ('refusedAt' in compacted) {
					// Composition refused exactly where sequential application parks:
					// the refusing operation is a patch over an established non-object
					// replacement, which parks against every base except a stored
					// tombstone, which absorbs everything first.
					if (base.state === 'tombstone') {
						expect(sequential.parkedAt).toEqual([]);
						expect(sequential.final).toEqual({ state: 'tombstone' });
					} else {
						expect(sequential.parkedAt).toContain(compacted.refusedAt);
					}
					refusalCorrespondences += 1;
					continue;
				}
				const once = applySequentially(base, [compacted.operation]);
				expect(once.final).toEqual(sequential.final);
				if (compacted.operation.op === 'patch') {
					const setKeys = new Set(Object.keys(compacted.operation.set));
					for (const key of compacted.operation.unset) {
						expect(setKeys.has(key)).toBe(false);
					}
				}
				comparisons += 1;
			}
		}
		expect(comparisons).toBeGreaterThan(10000);
		expect(refusalCorrespondences).toBeGreaterThan(100);
	});
});
