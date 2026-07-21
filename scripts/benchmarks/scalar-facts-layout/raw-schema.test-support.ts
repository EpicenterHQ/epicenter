/**
 * Test-only generator of a COMPLETE, closed-valid seed raw payload for the given
 * expectations. It emits blocks directly from the exact expected schedule (so it
 * matches the in-order schedule comparison), boundaries from the block markers,
 * reopens following the balanced rotation, and seed-bound build ids. Tests then
 * mutate one field at a time to prove each escape is refused, without running the
 * multi-minute pilot.
 */

import {
	buildProbePlan,
	buildProbeSource,
	PROBE_PHASES,
	type ProbePhase,
} from './probe-plan.js';
import {
	buildIdFor,
	type CompletenessExpectations,
	RAW_MACRO_METRIC,
	RAW_READ_METRICS,
	RAW_TAIL_METRICS,
	type RawOwner,
} from './raw-schema.js';
import { buildCalibrationRound } from './schedule.js';

export function buildCompleteRaw(
	exp: CompletenessExpectations,
): Record<string, unknown> {
	const owners = exp.owners as RawOwner[];
	const candidates = [...exp.candidates];
	const candidateCount = candidates.length;
	const buildId = (owner: string, candidate: string) =>
		buildIdFor(exp.configIdentity, exp.seedId, owner, candidate);
	const calibrationId = (owner: string, metric: string) =>
		`${exp.configIdentity}/${exp.seedId}/${owner}/${metric}/calibration`;

	const calibrations: unknown[] = [];
	const probes: unknown[] = [];
	const blocks: unknown[] = [];
	const boundaries: unknown[] = [];
	const reopens: unknown[] = [];
	const tails: unknown[] = [];
	const macros: unknown[] = [];
	const cells: unknown[] = [];
	let temporalOrdinal = 0;
	const probeSource = buildProbeSource(exp.traceOptions);

	for (const owner of owners) {
		for (const candidate of candidates) {
			macros.push({
				owner,
				metric: RAW_MACRO_METRIC[owner],
				candidate,
				units: 1,
				elapsedMs: 1,
				throughputPerSec: 1000,
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
			const probePlans = {} as Record<
				ProbePhase,
				ReturnType<typeof buildProbePlan>['plan']
			>;
			for (const phase of PROBE_PHASES) {
				const plan = buildProbePlan(probeSource, {
					configIdentity: exp.configIdentity,
					seedId: exp.seedId,
					owner,
					metric,
					phase,
				}).plan;
				probePlans[phase] = plan;
				probes.push(plan);
			}
			for (let roundIndex = 0; roundIndex < 2; roundIndex += 1) {
				for (const slot of buildCalibrationRound(
					exp.letterMapping as Record<'A' | 'B' | 'C' | 'D', string>,
					roundIndex,
				)) {
					const candidate = slot.candidate;
					calibrations.push({
						configIdentity: exp.configIdentity,
						seedId: exp.seedId,
						owner,
						metric,
						candidate,
						buildId: buildId(owner, candidate),
						roundIndex: slot.roundIndex,
						trialIndex: slot.trialIndex,
						sequenceOrder: slot.sequenceOrder,
						sequenceIndex: slot.sequenceIndex,
						position: slot.position,
						letter: slot.letter,
						ops: 2 ** roundIndex,
						elapsedMs: roundIndex === 0 ? 1 : exp.minBlockMs,
						minBlockMs: exp.minBlockMs,
						probeId: probePlans.calibration.probeId,
						probeDigest: probePlans.calibration.itemsDigest,
						calibrationId: calibrationId(owner, metric),
						temporalOrdinal,
					});
					temporalOrdinal += 1;
				}
			}
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
					ops: 2,
					calibrationId: calibrationId(owner, metric),
					warmupProbeId: probePlans.warmup.probeId,
					warmupProbeDigest: probePlans.warmup.itemsDigest,
					timedProbeId: probePlans.timed.probeId,
					timedProbeDigest: probePlans.timed.itemsDigest,
					temporalOrdinal,
					warmupMs: [1, 1, 1],
					elapsedMs: 25,
				});
				temporalOrdinal += 1;
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
					transactions: exp.tailTransactions,
					samplesMs: Array.from({ length: exp.tailTransactions }, () => 0.1),
					p50Ms: 0.1,
					p95Ms: 0.1,
					p99Ms: 0.1,
					throughputPerSec: 10_000,
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
		probes,
		calibrations,
		blocks,
		boundaries,
		reopens,
		tails,
		macros,
		cells,
	};
}
