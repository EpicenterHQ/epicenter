/**
 * Measurement-method proof status tests.
 *
 * The pilot validates only recorded method gates: every gate is required, failed
 * gates retain their named refusal, and the result exposes no candidate-selection
 * or speculative final-evidence readiness surface.
 */

import { describe, expect, test } from 'bun:test';

import { type ProofGateInputs, validateMethod } from './evidence-status.js';

const ALL_GATES_PASS: ProofGateInputs = {
	oracleWitnessReproduced: true,
	crossCandidateConsistent: true,
	provenanceMatches: true,
	estimatorsComplete: true,
	balanced: true,
	calibrationMet: true,
	warmupsRun: true,
	integrityOk: true,
	reopenObservationsSufficient: true,
	deterministicResetProven: true,
	headroomPreflightPassed: true,
	ownerWorkloadsExecuted: true,
	rawObservationsRetained: true,
	observationCountsExact: true,
	exactEnvelopeConformant: true,
	checkpointBoundariesTruthful: true,
};

const EXPECTED_GATE: Record<keyof ProofGateInputs, string> = {
	oracleWitnessReproduced: 'oracle-correctness',
	crossCandidateConsistent: 'cross-candidate-consistency',
	provenanceMatches: 'provenance',
	estimatorsComplete: 'seed-estimators',
	balanced: 'balance',
	calibrationMet: 'calibration',
	warmupsRun: 'calibration',
	integrityOk: 'integrity',
	reopenObservationsSufficient: 'reopen',
	deterministicResetProven: 'cross-candidate-isolation',
	headroomPreflightPassed: 'headroom',
	ownerWorkloadsExecuted: 'owner-workloads',
	rawObservationsRetained: 'raw-observations',
	observationCountsExact: 'exact-observation-counts',
	exactEnvelopeConformant: 'exact-envelope',
	checkpointBoundariesTruthful: 'checkpoint-truthful',
};

describe('method validation', () => {
	test('all gates passing validates the method without refusals', () => {
		const method = validateMethod(ALL_GATES_PASS);
		expect(method.methodValidated).toBe(true);
		expect(method.proofRefusals).toEqual([]);
	});

	for (const key of Object.keys(ALL_GATES_PASS) as Array<
		keyof ProofGateInputs
	>) {
		test(`${key} = false fails method validation with a named refusal`, () => {
			const method = validateMethod({ ...ALL_GATES_PASS, [key]: false });
			const failedGate = method.gates.find((gate) => !gate.passed);
			if (failedGate === undefined) throw new Error('expected one failed gate');
			expect(method.methodValidated).toBe(false);
			expect(method.gates.filter((gate) => !gate.passed)).toHaveLength(1);
			expect(failedGate.name).toBe(EXPECTED_GATE[key]);
			expect(method.proofRefusals).toEqual([
				`${EXPECTED_GATE[key]}: ${failedGate.detail}`,
			]);
		});
	}

	test('the method result exposes no selection or final-readiness concept', () => {
		const method = validateMethod(ALL_GATES_PASS);
		for (const absent of [
			'recommendation',
			'winner',
			'tieBreak',
			'candidateId',
			'evidenceStatus',
			'readyForAdrReview',
		]) {
			expect(method).not.toHaveProperty(absent);
		}
	});
});
