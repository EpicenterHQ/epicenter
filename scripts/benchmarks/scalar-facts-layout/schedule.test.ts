/**
 * The schedule must be a genuinely balanced Williams design: position-balanced
 * within a seed, complete first-order carryover, self-transition pairs at
 * boundaries, pair-order and position balance across seeds, and deterministic.
 * These are the invariants that answer the position-imbalance objection.
 */

import { describe, expect, test } from 'bun:test';

import {
	balanceDiagnostics,
	buildSeedSchedule,
	type SeedSchedule,
	smallestPowerOfTwoForMinDuration,
	WILLIAMS_SEQUENCES,
} from './schedule.js';

const CANDIDATES = [
	'unified-inline',
	'unified-normalized',
	'split-inline',
	'split-normalized',
];

function schedule(seedIndex: number, cycles = 3): SeedSchedule {
	return buildSeedSchedule({
		seedId: 1000 + seedIndex,
		candidates: CANDIDATES,
		cycles,
		rotation: seedIndex,
	});
}

describe('Williams design shape', () => {
	test('each letter appears once in each position across the four sequences', () => {
		for (let position = 0; position < 4; position += 1) {
			const letters = WILLIAMS_SEQUENCES.map((seq) => seq[position]);
			expect(new Set(letters).size).toBe(4);
		}
	});

	test('every ordered letter pair is adjacent exactly once within sequences', () => {
		const adjacencies = new Map<string, number>();
		for (const seq of WILLIAMS_SEQUENCES) {
			for (let i = 0; i + 1 < seq.length; i += 1) {
				const key = `${seq[i]}->${seq[i + 1]}`;
				adjacencies.set(key, (adjacencies.get(key) ?? 0) + 1);
			}
		}
		// 4 letters -> 12 ordered distinct pairs, each once.
		expect(adjacencies.size).toBe(12);
		for (const count of adjacencies.values()) expect(count).toBe(1);
	});

	test('three cycles of four sequences of four positions is 48 blocks', () => {
		expect(schedule(0).blocks.length).toBe(48);
	});
});

describe('self-transition pair junctions', () => {
	test('within-pair junctions repeat the candidate with no reopen boundary', () => {
		// The second sequence of each pair starts on the first sequence's last letter,
		// so its opening block repeats the predecessor and carries no idle+reopen.
		const blocks = schedule(0).blocks;
		let junctions = 0;
		for (let i = 1; i < blocks.length; i += 1) {
			const block = blocks[i]!;
			if (
				block.positionInSequence === 0 &&
				block.candidate === block.predecessor
			) {
				expect(block.precedingBoundary).toBe('none');
				junctions += 1;
			}
		}
		// One self-transition junction per pair per cycle: 2 pairs * 3 cycles = 6.
		expect(junctions).toBe(6);
	});

	test('reopen boundaries sit between pairs and between cycles, across differing candidates', () => {
		const boundaries = schedule(0).blocks.filter(
			(b) => b.precedingBoundary === 'pair' || b.precedingBoundary === 'cycle',
		);
		for (const block of boundaries) {
			expect(block.candidate).not.toBe(block.predecessor);
		}
		const kinds = new Set(schedule(0).blocks.map((b) => b.precedingBoundary));
		expect(kinds.has('start')).toBe(true);
		expect(kinds.has('cycle')).toBe(true);
		expect(kinds.has('pair')).toBe(true);
		expect(kinds.has('none')).toBe(true);
	});
});

describe('within-seed position balance', () => {
	test('each candidate appears in each position 3 times over three cycles', () => {
		const diag = balanceDiagnostics([schedule(0)], CANDIDATES);
		for (const candidate of CANDIDATES) {
			expect(diag.positionCounts[candidate]).toEqual([3, 3, 3, 3]);
		}
		expect(diag.positionBalanced).toBe(true);
	});
});

describe('across-seed balance', () => {
	test('four seeds give every candidate an identical position profile', () => {
		const schedules = [0, 1, 2, 3].map((k) => schedule(k));
		const diag = balanceDiagnostics(schedules, CANDIDATES);
		// 4 seeds * 3 cycles = 12 appearances per position per candidate.
		for (const candidate of CANDIDATES) {
			expect(diag.positionCounts[candidate]).toEqual([12, 12, 12, 12]);
		}
		expect(diag.positionBalanced).toBe(true);
	});

	test('pair order alternates across seeds', () => {
		// Even rotations lead with the (ABDC,CDBA) pair; odd rotations lead with (BCAD,DACB).
		const even = schedule(0).blocks[0]!;
		const odd = schedule(1).blocks[0]!;
		expect(even.sequence).toEqual(WILLIAMS_SEQUENCES[0]!);
		expect(odd.sequence).toEqual(WILLIAMS_SEQUENCES[1]!);
	});
});

describe('determinism', () => {
	test('same options reproduce the schedule exactly', () => {
		expect(schedule(2)).toEqual(schedule(2));
	});
	test('the letter mapping rotates with the seed', () => {
		expect(schedule(0).letterMapping.A).toBe(CANDIDATES[0]!);
		expect(schedule(1).letterMapping.A).toBe(CANDIDATES[1]!);
	});
});

describe('input guards', () => {
	test('a non-four candidate list throws', () => {
		expect(() =>
			buildSeedSchedule({
				seedId: 1,
				candidates: ['a', 'b', 'c'],
				cycles: 3,
				rotation: 0,
			}),
		).toThrow();
	});
});

describe('calibration block sizing', () => {
	test('picks the smallest power of two meeting the minimum duration for all candidates', () => {
		// The FASTEST candidate governs: 0.1 ms/op needs >= 200 ops for 20 ms -> 256.
		const perOp = [0.0001, 0.0002, 0.0003, 0.00025];
		expect(smallestPowerOfTwoForMinDuration(perOp, 0.02, 1 << 20)).toBe(256);
	});
	test('refuses when the cap cannot reach the floor', () => {
		const perOp = [1e-9, 1e-9, 1e-9, 1e-9];
		// 20 ms needs 2e7 ops; cap of 1024 cannot reach it.
		expect(smallestPowerOfTwoForMinDuration(perOp, 0.02, 1024)).toBeNull();
	});
	test('a zero or negative per-op estimate refuses', () => {
		expect(
			smallestPowerOfTwoForMinDuration([0, 0.0001], 0.02, 1 << 20),
		).toBeNull();
	});
});
