/**
 * The schedule must be a genuinely balanced Williams design: position-balanced
 * within a seed, complete first-order carryover, self-transition pairs at
 * boundaries, pair-order and position balance across seeds, and deterministic.
 * These are the invariants that answer the position-imbalance objection.
 */

import { describe, expect, test } from 'bun:test';

import {
	buildCalibrationRound,
	buildSeedSchedule,
	evaluateCalibrationTrials,
	type SeedSchedule,
	WILLIAMS_SEQUENCES,
} from './schedule.js';

const CANDIDATES = [
	'unified-inline',
	'unified-normalized',
	'split-inline',
	'split-normalized',
];
const LETTER_MAPPING = {
	A: CANDIDATES[0] as string,
	B: CANDIDATES[1] as string,
	C: CANDIDATES[2] as string,
	D: CANDIDATES[3] as string,
};

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error(`expected value at index ${index}`);
	return value;
}

function schedule(seedIndex: number, cycles = 3): SeedSchedule {
	return buildSeedSchedule({
		seedId: 1000 + seedIndex,
		candidates: CANDIDATES,
		cycles,
		rotation: seedIndex,
	});
}

function positionCounts(schedules: readonly SeedSchedule[]) {
	const counts = Object.fromEntries(
		CANDIDATES.map((candidate) => [candidate, [0, 0, 0, 0]]),
	);
	for (const seedSchedule of schedules) {
		for (const block of seedSchedule.blocks) {
			const positions = counts[block.candidate];
			if (positions === undefined)
				throw new Error(`unexpected candidate '${block.candidate}'`);
			positions[block.positionInSequence] =
				(positions[block.positionInSequence] ?? 0) + 1;
		}
	}
	return counts;
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
			const block = at(blocks, i);
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
		const counts = positionCounts([schedule(0)]);
		for (const candidate of CANDIDATES) {
			expect(counts[candidate]).toEqual([3, 3, 3, 3]);
		}
	});
});

describe('across-seed balance', () => {
	test('four seeds give every candidate an identical position profile', () => {
		const schedules = [0, 1, 2, 3].map((k) => schedule(k));
		const counts = positionCounts(schedules);
		// 4 seeds * 3 cycles = 12 appearances per position per candidate.
		for (const candidate of CANDIDATES) {
			expect(counts[candidate]).toEqual([12, 12, 12, 12]);
		}
	});

	test('pair order alternates across seeds', () => {
		// Even rotations lead with the (ABDC,CDBA) pair; odd rotations lead with (BCAD,DACB).
		const even = at(schedule(0).blocks, 0);
		const odd = at(schedule(1).blocks, 0);
		expect(even.sequence).toEqual(at(WILLIAMS_SEQUENCES, 0));
		expect(odd.sequence).toEqual(at(WILLIAMS_SEQUENCES, 1));
	});
});

describe('determinism', () => {
	test('same options reproduce the schedule exactly', () => {
		expect(schedule(2)).toEqual(schedule(2));
	});
	test('the letter mapping rotates with the seed', () => {
		expect(schedule(0).letterMapping.A).toBe(at(CANDIDATES, 0));
		expect(schedule(1).letterMapping.A).toBe(at(CANDIDATES, 1));
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

describe('actual calibration trials', () => {
	function trials(elapsedByTrial: readonly (number | readonly number[])[]) {
		return elapsedByTrial.flatMap((elapsed, roundIndex) =>
			buildCalibrationRound(LETTER_MAPPING, roundIndex).map((slot) => ({
				...slot,
				ops: 2 ** roundIndex,
				elapsedMs:
					typeof elapsed === 'number' ? elapsed : at(elapsed, slot.trialIndex),
			})),
		);
	}

	test('selects the first power of two where all sixteen Williams trials reach the floor', () => {
		const result = evaluateCalibrationTrials(
			trials([5, 10, 20]),
			LETTER_MAPPING,
			20,
			16,
		);
		expect(result).toEqual({
			status: 'SELECTED',
			selectedOps: 4,
			terminalRoundIndex: 2,
		});
		const firstRound = trials([5]);
		for (const candidate of CANDIDATES) {
			for (let position = 0; position < 4; position += 1) {
				expect(
					firstRound.filter(
						(trial) =>
							trial.candidate === candidate && trial.position === position,
					),
				).toHaveLength(1);
			}
		}
	});

	test('the seed letter mapping controls calibration candidate identity', () => {
		const rotated = {
			A: LETTER_MAPPING.B,
			B: LETTER_MAPPING.C,
			C: LETTER_MAPPING.D,
			D: LETTER_MAPPING.A,
		};
		const slots = buildCalibrationRound(rotated, 0);
		expect(slots.find((slot) => slot.letter === 'A')?.candidate).toBe(
			rotated.A,
		);
		expect(new Set(slots.map((slot) => slot.trialIndex)).size).toBe(16);
	});

	test('cap exhaustion is incomplete with no selected operation count', () => {
		const terminal = Array.from({ length: 16 }, () => 20);
		terminal[7] = 19.9;
		const result = evaluateCalibrationTrials(
			trials([5, terminal]),
			LETTER_MAPPING,
			20,
			2,
		);
		expect(result.status).toBe('INCOMPLETE');
		expect(result.selectedOps).toBeNull();
		expect(
			evaluateCalibrationTrials(trials([5, terminal]), LETTER_MAPPING, 20, 4)
				.status,
		).toBe('INVALID');
	});

	test('refuses forged candidate order and non-contiguous operation counts', () => {
		const forgedOrder = trials([5, 20]);
		forgedOrder[16] = {
			...at(forgedOrder, 16),
			candidate: at(CANDIDATES, 0),
		};
		expect(
			evaluateCalibrationTrials(forgedOrder, LETTER_MAPPING, 20, 2).status,
		).toBe('INVALID');

		const forgedOps = trials([5, 20]);
		forgedOps[16] = { ...at(forgedOps, 16), ops: 4 };
		expect(
			evaluateCalibrationTrials(forgedOps, LETTER_MAPPING, 20, 4).status,
		).toBe('INVALID');
	});

	test('refuses retained trials after the first complete trial', () => {
		const result = evaluateCalibrationTrials(
			trials([20, 40]),
			LETTER_MAPPING,
			20,
			2,
		);
		expect(result.status).toBe('INVALID');
	});

	test('missing, duplicate, or reordered Williams trials are invalid', () => {
		const complete = trials([20]);
		expect(
			evaluateCalibrationTrials(complete.slice(1), LETTER_MAPPING, 20, 1)
				.status,
		).toBe('INVALID');
		expect(
			evaluateCalibrationTrials(
				[...complete, at(complete, 0)],
				LETTER_MAPPING,
				20,
				1,
			).status,
		).toBe('INVALID');
		const reordered = [...complete];
		[reordered[0], reordered[1]] = [at(reordered, 1), at(reordered, 0)];
		expect(
			evaluateCalibrationTrials(reordered, LETTER_MAPPING, 20, 1).status,
		).toBe('INVALID');
	});
});
