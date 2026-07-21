/**
 * The declared estimator's invariants and refusals. These are the tests the two
 * reviews' objections demand: the outer unit is the whole seed, the bootstrap
 * cannot reach below it, inference is deterministic and familywise, and every
 * degenerate family refuses rather than emitting a classification.
 */

import { describe, expect, test } from 'bun:test';

import {
	classify,
	computeFamilywise,
	type FamilyInput,
	LATENCY_LOG_MARGIN,
	marginFor,
	type SeedLevelMetric,
	STORAGE_LOG_MARGIN,
} from './statistics.js';

/** A deterministic seed-level matrix generator: estimates[seed][candidate]. */
function matrix(
	seeds: number,
	perCandidate: (seed: number, candidate: number) => number,
	candidates: number,
): number[][] {
	return Array.from({ length: seeds }, (_, s) =>
		Array.from({ length: candidates }, (_, c) => perCandidate(s, c)),
	);
}

const CANDIDATES = ['A', 'B', 'C', 'D'];

function latencyMetric(key: string, seeds: number): SeedLevelMetric {
	// Four candidates with distinct base latencies and mild seed-driven jitter, so
	// every contrast has genuine but bounded spread.
	return {
		key,
		kind: 'latency',
		estimates: matrix(
			seeds,
			(s, c) => {
				const base = [100, 104, 108, 112][c] ?? 100;
				const jitter = 1 + 0.03 * Math.sin(s * 1.7 + c);
				return base * jitter;
			},
			4,
		),
	};
}

function baseInput(seeds: number, metrics: SeedLevelMetric[]): FamilyInput {
	return {
		candidates: CANDIDATES,
		seedIds: Array.from({ length: seeds }, (_, s) => 1000 + s),
		metrics,
		bootstrapDraws: 10_000,
		bootstrapSeed: 0x5ca1ab1e,
	};
}

describe('classify follows the spec equivalence rules exactly', () => {
	const m = 0.1; // an easy round margin
	test('whole interval inside the margins is equivalent', () => {
		expect(classify({ lower: -0.05, upper: 0.05 }, m)).toBe('equivalent');
		expect(classify({ lower: -m, upper: m }, m)).toBe('equivalent');
	});
	test('upper below the negative margin is left-better', () => {
		expect(classify({ lower: -0.4, upper: -0.11 }, m)).toBe('left-better');
	});
	test('lower above the positive margin is right-better', () => {
		expect(classify({ lower: 0.11, upper: 0.4 }, m)).toBe('right-better');
	});
	test('upper within the positive margin but lower below -margin is left-non-regressing', () => {
		expect(classify({ lower: -0.3, upper: 0.05 }, m)).toBe(
			'left-non-regressing',
		);
	});
	test('lower within -margin but upper above +margin is right-non-regressing', () => {
		expect(classify({ lower: -0.05, upper: 0.3 }, m)).toBe(
			'right-non-regressing',
		);
	});
	test('straddling beyond both margins is inconclusive', () => {
		expect(classify({ lower: -0.3, upper: 0.3 }, m)).toBe('inconclusive');
	});
	test('non-finite bounds are inconclusive', () => {
		expect(classify({ lower: -0.1, upper: Number.POSITIVE_INFINITY }, m)).toBe(
			'inconclusive',
		);
	});
	test('the fixed margins are log(1.10) and log(1.05)', () => {
		expect(marginFor('latency')).toBe(LATENCY_LOG_MARGIN);
		expect(marginFor('storage')).toBe(STORAGE_LOG_MARGIN);
		expect(LATENCY_LOG_MARGIN).toBeCloseTo(Math.log(1.1), 12);
		expect(STORAGE_LOG_MARGIN).toBeCloseTo(Math.log(1.05), 12);
	});
});

describe('deterministic replay', () => {
	test('identical inputs and bootstrap seed give byte-identical results', () => {
		const a = computeFamilywise(baseInput(8, [latencyMetric('read', 8)]));
		const b = computeFamilywise(baseInput(8, [latencyMetric('read', 8)]));
		expect(a).toEqual(b);
	});
	test('a different bootstrap seed can change the critical value', () => {
		const input = baseInput(8, [latencyMetric('read', 8)]);
		const a = computeFamilywise(input);
		const b = computeFamilywise({ ...input, bootstrapSeed: 0xdeadbeef });
		expect(a.ok && b.ok).toBe(true);
		// Not required to differ, but must stay finite and positive either way.
		expect(a.criticalValue).toBeGreaterThan(0);
		expect(b.criticalValue).toBeGreaterThan(0);
	});
});

describe('the outer unit is the whole seed', () => {
	test('a duplicated metric does not inflate the critical value', () => {
		// If the bootstrap resampled each member with independent seed picks, the
		// duplicate would sometimes exceed the original and raise the max-t quantile.
		// Sharing one whole-seed resample per draw keeps identical members tied.
		const single = computeFamilywise(baseInput(8, [latencyMetric('read', 8)]));
		const duplicated = computeFamilywise(
			baseInput(8, [latencyMetric('read', 8), latencyMetric('read2', 8)]),
		);
		expect(single.ok && duplicated.ok).toBe(true);
		expect(duplicated.criticalValue).toBeCloseTo(single.criticalValue, 12);
	});
});

describe('familywise simultaneity', () => {
	test('adding an independent metric weakly widens the critical value', () => {
		const one = computeFamilywise(baseInput(10, [latencyMetric('read', 10)]));
		const storage: SeedLevelMetric = {
			key: 'liveBytes',
			kind: 'storage',
			estimates: matrix(
				10,
				(s, c) => [630, 780, 640, 785][c]! * (1 + 0.002 * Math.cos(s + c)),
				4,
			),
		};
		const two = computeFamilywise(
			baseInput(10, [latencyMetric('read', 10), storage]),
		);
		expect(one.ok && two.ok).toBe(true);
		// A quantile of a max over a superset of members is weakly larger.
		expect(two.criticalValue).toBeGreaterThanOrEqual(one.criticalValue - 1e-9);
	});

	test('every contrast shares one critical value (simultaneous, not pointwise)', () => {
		const result = computeFamilywise(
			baseInput(10, [latencyMetric('read', 10)]),
		);
		expect(result.ok).toBe(true);
		for (const c of result.contrasts) {
			expect(c.halfWidth).toBeCloseTo(
				result.criticalValue * c.standardError,
				12,
			);
		}
	});

	test('six candidate pairs per metric', () => {
		const result = computeFamilywise(baseInput(8, [latencyMetric('read', 8)]));
		expect(result.contrasts.length).toBe(6);
	});
});

describe('structural refusals: no classification off a degenerate family', () => {
	test('fewer than two seeds refuses', () => {
		const result = computeFamilywise(baseInput(1, [latencyMetric('read', 1)]));
		expect(result.ok).toBe(false);
		expect(result.contrasts).toEqual([]);
		expect(result.refusals.join(' ')).toContain('two whole seeds');
	});

	test('a non-positive seed-level estimate refuses (log undefined)', () => {
		const bad: SeedLevelMetric = {
			key: 'read',
			kind: 'latency',
			estimates: matrix(4, (_s, c) => (c === 0 ? 0 : 100 + c), 4),
		};
		const result = computeFamilywise(baseInput(4, [bad]));
		expect(result.ok).toBe(false);
		expect(result.refusals.join(' ')).toContain('non-positive');
	});

	test('zero seed-level spread refuses (degenerate studentization)', () => {
		const flat: SeedLevelMetric = {
			key: 'read',
			kind: 'latency',
			// Every seed identical, so at least one contrast has zero spread.
			estimates: matrix(6, (_s, c) => 100 + c, 4),
		};
		const result = computeFamilywise(baseInput(6, [flat]));
		expect(result.ok).toBe(false);
		expect(result.refusals.join(' ')).toContain('degenerate');
	});

	test('a candidate-count mismatch refuses', () => {
		const input = baseInput(4, [latencyMetric('read', 4)]);
		// Corrupt one seed row to the wrong candidate count.
		(input.metrics[0]!.estimates[0] as number[]).pop();
		const result = computeFamilywise(input);
		expect(result.ok).toBe(false);
	});
});

describe('feasibility projection', () => {
	test('reports whether the max half-width meets margin/2 and projects seeds', () => {
		const result = computeFamilywise(baseInput(6, [latencyMetric('read', 6)]));
		expect(result.ok).toBe(true);
		const latency = result.feasibility.find((f) => f.kind === 'latency');
		expect(latency).toBeDefined();
		expect(latency!.targetHalfWidth).toBeCloseTo(LATENCY_LOG_MARGIN / 2, 12);
		if (!latency!.withinTarget) {
			expect(latency!.projectedSeeds).toBeGreaterThan(6);
		} else {
			expect(latency!.projectedSeeds).toBeNull();
		}
	});
});
