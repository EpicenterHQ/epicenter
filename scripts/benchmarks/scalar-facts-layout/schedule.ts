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
 * timed blocks, then persists already-reduced seed-level estimators for later
 * human review or a separately decided evidence consumer.
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

export type CalibrationTrial = {
	candidate: string;
	roundIndex: number;
	trialIndex: number;
	sequenceOrder: number;
	sequenceIndex: number;
	position: number;
	letter: Letter;
	ops: number;
	elapsedMs: number;
};

export type CalibrationDecision =
	| { status: 'SELECTED'; selectedOps: number; terminalRoundIndex: number }
	| {
			status: 'INCOMPLETE';
			selectedOps: null;
			code: 'DURATION_FLOOR_NOT_REACHED';
			reason: string;
	  }
	| {
			status: 'INVALID';
			selectedOps: null;
			code: 'INVALID_CALIBRATION';
			reason: string;
	  };

export const CALIBRATION_TRIALS_PER_ROUND =
	WILLIAMS_SEQUENCES.length * LETTERS.length;

export type CalibrationSlot = Omit<
	CalibrationTrial,
	'ops' | 'elapsedMs' | 'roundIndex'
> & { roundIndex: number };

/** The single owner of the exact sixteen-position Williams calibration round. */
export function buildCalibrationRound(
	letterMapping: Readonly<Record<Letter, string>>,
	roundIndex: number,
): CalibrationSlot[] {
	if (!Number.isSafeInteger(roundIndex) || roundIndex < 0) {
		throw new Error('calibration round index must be a nonnegative integer');
	}
	const candidates = LETTERS.map((letter) => letterMapping[letter]);
	if (
		candidates.some(
			(candidate) => typeof candidate !== 'string' || candidate.length === 0,
		) ||
		new Set(candidates).size !== LETTERS.length
	) {
		throw new Error(
			'calibration letter mapping must be a four-candidate bijection',
		);
	}
	const slots: CalibrationSlot[] = [];
	for (let sequenceOrder = 0; sequenceOrder < 4; sequenceOrder += 1) {
		const sequenceIndex = (sequenceOrder + roundIndex) % 4;
		const sequence = WILLIAMS_SEQUENCES[sequenceIndex] as readonly Letter[];
		for (let position = 0; position < 4; position += 1) {
			const letter = sequence[position] as Letter;
			slots.push({
				roundIndex,
				trialIndex: sequenceOrder * 4 + position,
				sequenceOrder,
				sequenceIndex,
				position,
				letter,
				candidate: letterMapping[letter],
			});
		}
	}
	return slots;
}

function invalidCalibration(reason: string): CalibrationDecision {
	return {
		status: 'INVALID',
		selectedOps: null,
		code: 'INVALID_CALIBRATION',
		reason,
	};
}

function incompleteCalibration(reason: string): CalibrationDecision {
	return {
		status: 'INCOMPLETE',
		selectedOps: null,
		code: 'DURATION_FLOOR_NOT_REACHED',
		reason,
	};
}

/**
 * Validate retained ACTUAL calibration trials and freeze their common operation
 * count. Every round must contain the exact sixteen-slot Williams design in its
 * declared rotated order, operation counts must be the contiguous powers of two
 * starting at one, and only the terminal round may meet the duration floor for
 * all sixteen trials. This function never projects duration from
 * seconds-per-operation.
 */
export function evaluateCalibrationTrials(
	trials: readonly CalibrationTrial[],
	letterMapping: Readonly<Record<Letter, string>>,
	minBlockMs: number,
	maxBlockOps: number,
): CalibrationDecision {
	const candidates = LETTERS.map((letter) => letterMapping[letter]);
	if (candidates.length === 0) {
		return invalidCalibration('calibration has no candidates');
	}
	if (
		!Number.isFinite(minBlockMs) ||
		minBlockMs <= 0 ||
		!Number.isSafeInteger(maxBlockOps) ||
		maxBlockOps < 1
	) {
		return invalidCalibration('calibration limits are invalid');
	}
	if (new Set(candidates).size !== candidates.length) {
		return invalidCalibration('calibration candidates are not unique');
	}
	if (candidates.length !== LETTERS.length) {
		return invalidCalibration(
			'the Williams calibration requires exactly four candidates',
		);
	}
	if (
		trials.length === 0 ||
		trials.length % CALIBRATION_TRIALS_PER_ROUND !== 0
	) {
		return invalidCalibration(
			'calibration does not contain complete Williams rounds',
		);
	}

	const roundCount = trials.length / CALIBRATION_TRIALS_PER_ROUND;
	let terminalRoundIndex: number | null = null;
	for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
		const expectedOps = 2 ** roundIndex;
		if (!Number.isSafeInteger(expectedOps) || expectedOps > maxBlockOps) {
			return invalidCalibration('calibration exceeds the frozen operation cap');
		}
		const group = trials.slice(
			roundIndex * CALIBRATION_TRIALS_PER_ROUND,
			(roundIndex + 1) * CALIBRATION_TRIALS_PER_ROUND,
		);
		let expectedSlots: CalibrationSlot[];
		try {
			expectedSlots = buildCalibrationRound(letterMapping, roundIndex);
		} catch (error) {
			return invalidCalibration((error as Error).message);
		}
		for (const expected of expectedSlots) {
			const observation = group[expected.trialIndex];
			if (
				observation === undefined ||
				observation.roundIndex !== expected.roundIndex ||
				observation.trialIndex !== expected.trialIndex ||
				observation.sequenceOrder !== expected.sequenceOrder ||
				observation.sequenceIndex !== expected.sequenceIndex ||
				observation.position !== expected.position ||
				observation.letter !== expected.letter ||
				observation.candidate !== expected.candidate ||
				observation.ops !== expectedOps ||
				!Number.isFinite(observation.elapsedMs) ||
				observation.elapsedMs < 0
			) {
				return invalidCalibration(
					`calibration round ${roundIndex} does not match the frozen Williams design`,
				);
			}
		}
		const allMet = group.every(
			(observation) => observation.elapsedMs >= minBlockMs,
		);
		if (allMet) {
			terminalRoundIndex = roundIndex;
			if (roundIndex !== roundCount - 1) {
				return invalidCalibration(
					'calibration retained trials after the first complete trial',
				);
			}
		} else if (roundIndex === roundCount - 1) {
			if (expectedOps * 2 <= maxBlockOps) {
				return invalidCalibration(
					'calibration stopped before exhausting the frozen operation cap',
				);
			}
			return incompleteCalibration(
				'calibration never measured every Williams trial at the duration floor',
			);
		}
	}

	if (terminalRoundIndex === null) {
		return invalidCalibration('calibration has no complete terminal trial');
	}
	return {
		status: 'SELECTED',
		selectedOps: 2 ** terminalRoundIndex,
		terminalRoundIndex,
	};
}
