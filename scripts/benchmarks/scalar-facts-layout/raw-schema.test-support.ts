/**
 * Test-only generator of a COMPLETE, closed-valid seed raw payload for the given
 * expectations. It emits blocks directly from the exact expected schedule (so it
 * matches the in-order schedule comparison), boundaries from the block markers,
 * reopens following the balanced rotation, and seed-bound build ids. Tests then
 * mutate one field at a time to prove each escape is refused, without running the
 * multi-minute pilot.
 */

import {
	type CompletenessExpectations,
	RAW_MACRO_METRIC,
	RAW_READ_METRICS,
	RAW_TAIL_METRICS,
	type RawOwner,
} from './raw-schema.js';

export function buildCompleteRaw(
	exp: CompletenessExpectations,
): Record<string, unknown> {
	const owners = exp.owners as RawOwner[];
	const candidates = [...exp.candidates];
	const candidateCount = candidates.length;
	const buildId = (owner: string, candidate: string) =>
		`s${exp.seedIndex}/${owner}/${candidate}`;

	const blocks: unknown[] = [];
	const boundaries: unknown[] = [];
	const reopens: unknown[] = [];
	const tails: unknown[] = [];
	const macros: unknown[] = [];
	const cells: unknown[] = [];

	for (const owner of owners) {
		for (const candidate of candidates) {
			macros.push({
				owner,
				metric: RAW_MACRO_METRIC[owner],
				candidate,
				elapsedMs: 1,
				throughputPerSec: 1,
			});
			cells.push({
				owner,
				candidate,
				buildId: buildId(owner, candidate),
				oracleReproduced: true,
				integrityOk: true,
				candidateTableBytes: 100,
				fileBytes: 200,
			});
		}
		// Balanced reopen rotation: candidate = candidates[(orderPosition + index) mod L].
		for (let index = 0; index < exp.reopenObservations; index += 1) {
			for (let k = 0; k < candidateCount; k += 1) {
				const candidate = candidates[
					(k + (index % candidateCount)) % candidateCount
				] as string;
				reopens.push({
					owner,
					candidate,
					buildId: buildId(owner, candidate),
					index,
					orderPosition: k,
					elapsedMs: 1,
					witnessDigest: 'w',
					witnessMatchesOracle: true,
				});
			}
		}
		for (const metric of RAW_READ_METRICS[owner]) {
			for (const e of exp.schedule) {
				const boundary = e.precedingBoundary;
				blocks.push({
					owner,
					metric,
					candidate: e.candidate,
					buildId: buildId(owner, e.candidate),
					cycle: e.cycle,
					ordinal: e.ordinal,
					position: e.positionInSequence,
					letter: e.letter,
					sequenceLabel: e.sequence.join(''),
					predecessor: e.predecessor,
					boundary,
					ops: 1024,
					warmupMs: [1, 1, 1],
					elapsedMs: 25,
				});
				if (boundary === 'pair' || boundary === 'cycle') {
					boundaries.push({
						owner,
						metric,
						kind: boundary,
						atOrdinal: e.ordinal,
						idleMs: 50,
						reopenMs: 5,
						reopenedCandidates: candidateCount,
						reopenOk: true,
					});
				}
			}
		}
		for (const metric of RAW_TAIL_METRICS[owner]) {
			for (const candidate of candidates) {
				tails.push({
					owner,
					metric,
					candidate,
					transactions: exp.minTailTransactions,
					samplesMs: Array.from({ length: exp.minTailTransactions }, () => 0.1),
					p50Ms: 0.1,
					p95Ms: 0.1,
					p99Ms: 0.1,
					throughputPerSec: 1000,
					resetVerified: true,
					warmupTransactions: 3,
					walDeltaDiagnostic: 0,
					checkpointSignalTruthful: false,
				});
			}
		}
	}

	return {
		letterMapping: { ...exp.letterMapping },
		lifecycle: {
			peakRetained: owners.length * candidateCount,
			liveAtCommit: owners.length * candidateCount,
			retainedThroughCommit: true,
		},
		blocks,
		boundaries,
		reopens,
		tails,
		macros,
		cells,
	};
}
