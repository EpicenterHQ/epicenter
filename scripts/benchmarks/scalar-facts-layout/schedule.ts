/**
 * Balanced read-metric scheduling for one seed.
 *
 * The provisional run left candidate position unbalanced, so an apparent latency
 * ranking could be a position or carryover artifact. This module fixes the order
 * before any timing. Inside every seed it runs three complete cycles of the four
 * Williams sequences `A B D C`, `B C A D`, `C D B A`, `D A C B`, whose 4x4 design
 * is first-order complete: each letter appears once in each position across the
 * four sequences, and every ordered letter pair is adjacent exactly once. Letters
 * map to candidates through a seed-specific rotation, so across seeds each
 * candidate visits each position equally.
 *
 * Sequences run in end-to-start self-transition pairs (`A B D C` then `C D B A`;
 * `B C A D` then `D A C B`), the pair order alternates across seeds, and a fixed
 * idle plus connection-reopen boundary sits between pairs and between cycles. The
 * boundary is recorded, never claimed to clear the OS cache or thermal history;
 * each block records its predecessor candidate and the boundary that preceded it,
 * so position and carryover stay auditable diagnostics rather than hidden
 * assumptions.
 *
 * Everything here is a pure function of the seed and the candidate list: no wall
 * clock, no SQLite, no timing. The runner consumes the schedule to order its
 * timed blocks; the statistics module never sees this structure because it
 * receives one already-reduced seed-level estimator per candidate.
 */

export type Letter = 'A' | 'B' | 'C' | 'D';

const LETTERS: readonly Letter[] = ['A', 'B', 'C', 'D'];

/** The four Williams sequences, in canonical order. */
export const WILLIAMS_SEQUENCES: readonly (readonly Letter[])[] = [
	['A', 'B', 'D', 'C'],
	['B', 'C', 'A', 'D'],
	['C', 'D', 'B', 'A'],
	['D', 'A', 'C', 'B'],
];

/**
 * End-to-start self-transition pairs, by index into `WILLIAMS_SEQUENCES`:
 * `A B D C` (ends C) then `C D B A` (starts C), and `B C A D` (ends D) then
 * `D A C B` (starts D).
 */
export const SELF_TRANSITION_PAIRS: readonly (readonly [number, number])[] = [
	[0, 2],
	[1, 3],
];

export type BoundaryKind = 'start' | 'none' | 'pair' | 'cycle';

export type ScheduledBlock = {
	/** Cycle index in `[0, cycles)`. */
	cycle: number;
	/** 0-based order of this block across the seed's whole schedule. */
	ordinal: number;
	/** The Williams sequence letters this block belongs to. */
	sequence: readonly Letter[];
	/** Position of this block within its sequence, `[0, 4)`. */
	positionInSequence: number;
	letter: Letter;
	candidate: string;
	/** The immediately preceding block's candidate, or null at the seed start. */
	predecessor: string | null;
	/** The boundary that precedes this block (idle + connection reopen for pair/cycle). */
	precedingBoundary: BoundaryKind;
};

export type SeedSchedule = {
	seedId: number;
	cycles: number;
	/** Seed-specific letter-to-candidate rotation, for the audit trail. */
	letterMapping: Record<Letter, string>;
	blocks: ScheduledBlock[];
};

export type ScheduleOptions = {
	seedId: number;
	/** Exactly four candidate ids, in the caller's canonical order. */
	candidates: readonly string[];
	/** Complete Williams cycles per seed (spec: three). */
	cycles: number;
	/** Rotation offset for this seed's letter mapping; the runner passes the seed index. */
	rotation: number;
};

/**
 * Build one seed's balanced read schedule. The letter-to-candidate rotation and
 * the pair order both depend on `rotation` so position and pair balance emerge
 * across seeds.
 */
export function buildSeedSchedule(options: ScheduleOptions): SeedSchedule {
	if (options.candidates.length !== 4) {
		throw new Error('the Williams design requires exactly four candidates');
	}
	if (options.cycles < 1) throw new Error('at least one cycle is required');

	// Rotate candidates onto A,B,C,D so each candidate visits each letter position
	// across four consecutive seeds.
	const rot = ((options.rotation % 4) + 4) % 4;
	const letterMapping = {} as Record<Letter, string>;
	LETTERS.forEach((letter, index) => {
		letterMapping[letter] = options.candidates[(index + rot) % 4] as string;
	});

	// Alternate which self-transition pair leads, balancing pair order across seeds.
	const pairOrder =
		rot % 2 === 0
			? [SELF_TRANSITION_PAIRS[0], SELF_TRANSITION_PAIRS[1]]
			: [SELF_TRANSITION_PAIRS[1], SELF_TRANSITION_PAIRS[0]];

	const blocks: ScheduledBlock[] = [];
	let ordinal = 0;
	let previousCandidate: string | null = null;
	for (let cycle = 0; cycle < options.cycles; cycle += 1) {
		pairOrder.forEach((pair, pairIndex) => {
			(pair as readonly [number, number]).forEach(
				(sequenceIndex, seqInPair) => {
					const sequence = WILLIAMS_SEQUENCES[
						sequenceIndex
					] as readonly Letter[];
					sequence.forEach((letter, positionInSequence) => {
						// Idle + connection-reopen boundaries sit between pairs and between
						// cycles. The junction inside a pair is the self-transition (the two
						// sequences share their end/start letter) and runs consecutively with
						// no reopen.
						let precedingBoundary: BoundaryKind;
						if (ordinal === 0) precedingBoundary = 'start';
						else if (positionInSequence > 0) precedingBoundary = 'none';
						else if (seqInPair === 1) precedingBoundary = 'none';
						else if (pairIndex === 0) precedingBoundary = 'cycle';
						else precedingBoundary = 'pair';
						const candidate = letterMapping[letter];
						blocks.push({
							cycle,
							ordinal,
							sequence,
							positionInSequence,
							letter,
							candidate,
							// A boundary reopens the connection; the predecessor is still recorded
							// so carryover across the boundary is a modeled diagnostic, not erased.
							predecessor: previousCandidate,
							precedingBoundary,
						});
						previousCandidate = candidate;
						ordinal += 1;
					});
				},
			);
		});
	}

	return {
		seedId: options.seedId,
		cycles: options.cycles,
		letterMapping,
		blocks,
	};
}

export type BalanceDiagnostics = {
	/** `positionCounts[candidate][position]` over all supplied seed schedules. */
	positionCounts: Record<string, number[]>;
	/** `carryover[predecessor][candidate]` over adjacent blocks (boundaries included). */
	carryover: Record<string, Record<string, number>>;
	/** Total timed blocks per candidate. */
	totalPerCandidate: Record<string, number>;
	/** True when every candidate has the same total and an identical position profile. */
	positionBalanced: boolean;
};

/**
 * Aggregate position and carryover balance across seed schedules. Kept as a
 * diagnostic, never an automatic refusal statistic (spec 530-536): the runner
 * reports these so a reviewer can see the design was balanced, not so the pilot
 * silently drops evidence.
 */
export function balanceDiagnostics(
	schedules: readonly SeedSchedule[],
	candidates: readonly string[],
): BalanceDiagnostics {
	const positionCounts: Record<string, number[]> = {};
	const carryover: Record<string, Record<string, number>> = {};
	const totalPerCandidate: Record<string, number> = {};
	for (const candidate of candidates) {
		positionCounts[candidate] = [0, 0, 0, 0];
		totalPerCandidate[candidate] = 0;
		carryover[candidate] = {};
		for (const other of candidates) {
			(carryover[candidate] as Record<string, number>)[other] = 0;
		}
	}
	for (const schedule of schedules) {
		for (const block of schedule.blocks) {
			const counts = positionCounts[block.candidate];
			if (counts !== undefined) {
				counts[block.positionInSequence] =
					(counts[block.positionInSequence] ?? 0) + 1;
			}
			totalPerCandidate[block.candidate] =
				(totalPerCandidate[block.candidate] ?? 0) + 1;
			if (block.predecessor !== null) {
				const row = carryover[block.predecessor];
				if (row !== undefined && block.candidate in row) {
					row[block.candidate] = (row[block.candidate] ?? 0) + 1;
				}
			}
		}
	}
	const totals = candidates.map((c) => totalPerCandidate[c] ?? 0);
	const firstTotal = totals[0] ?? 0;
	const equalTotals = totals.every((t) => t === firstTotal);
	const firstProfile = JSON.stringify(positionCounts[candidates[0] as string]);
	const equalProfiles = candidates.every(
		(c) => JSON.stringify(positionCounts[c]) === firstProfile,
	);
	return {
		positionCounts,
		carryover,
		totalPerCandidate,
		positionBalanced: equalTotals && equalProfiles,
	};
}

/**
 * The smallest power-of-two operation count for which every candidate's block is
 * projected to run at least `minSeconds`, capped at `maxCount`. Given each
 * candidate's measured seconds-per-operation from a calibration probe, this is
 * the pure sizing decision behind "choose the smallest power-of-two operation
 * count for which every candidate takes at least 20 ms, then freeze the common
 * count." Returns null when even `maxCount` cannot reach the floor for some
 * candidate, so the runner refuses instead of timing sub-threshold blocks.
 */
export function smallestPowerOfTwoForMinDuration(
	perOperationSeconds: readonly number[],
	minSeconds: number,
	maxCount: number,
): number | null {
	if (perOperationSeconds.length === 0) return null;
	const slowestFloor = Math.max(...perOperationSeconds);
	if (!Number.isFinite(slowestFloor) || slowestFloor <= 0) return null;
	let count = 1;
	while (count <= maxCount) {
		if (perOperationSeconds.every((s) => s * count >= minSeconds)) return count;
		count *= 2;
	}
	return null;
}
