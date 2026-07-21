/**
 * Evidence status. These tests prove the policy: no recommendation
 * or tie-break exists, every proof gate is required for method validation, a pilot
 * is never ADR-ready, a `configured` flag alone never implies readiness (an empty
 * ceiling set is invalid), readiness demands observed within-ceiling per-cell SLO
 * results for every required metric, and the four states are fail-closed.
 */

import { describe, expect, test } from 'bun:test';

import {
	type AbsoluteSloPolicy,
	type EvidenceCell,
	evaluateEvidenceReadiness,
	type ProofGateInputs,
	REQUIRED_SLO_METRICS,
	type SloObservation,
	UNCONFIGURED_SLO_POLICY,
	validateMethod,
	validateSloPolicy,
} from './evidence-status.js';

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

const FULL_CEILINGS = Object.fromEntries(
	REQUIRED_SLO_METRICS.map((m) => [m, 1000]),
) as Record<(typeof REQUIRED_SLO_METRICS)[number], number>;

const CONFIGURED: AbsoluteSloPolicy = {
	configured: true,
	ceilings: FULL_CEILINGS,
};
const CELL: EvidenceCell = {
	owner: 'replica',
	candidate: 'unified-inline',
	seedId: 1,
};

function observationsWithin(cell: EvidenceCell): SloObservation[] {
	return REQUIRED_SLO_METRICS.map((metric) => ({
		owner: cell.owner,
		candidate: cell.candidate,
		seedId: cell.seedId,
		metric,
		observedValue: 10,
		ceiling: 1000,
		withinCeiling: true,
	}));
}

describe('the contract exposes no selection concept', () => {
	test('no recommendation, winner, or tie-break field is produced', () => {
		const method = validateMethod(ALL_GATES_PASS);
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			execution: { status: 'COMPLETE', method },
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			sloObservations: null,
			expectedCells: [],
			matrixComplete: true,
		});
		const keys = [...Object.keys(method), ...Object.keys(readiness)];
		for (const banned of [
			'recommendation',
			'winner',
			'tieBreak',
			'candidateId',
		]) {
			expect(keys).not.toContain(banned);
		}
	});
});

describe('method validation requires every gate', () => {
	test('all gates passing validates the method', () => {
		expect(validateMethod(ALL_GATES_PASS).methodValidated).toBe(true);
	});
	for (const key of Object.keys(ALL_GATES_PASS) as Array<
		keyof ProofGateInputs
	>) {
		test(`${key} = false fails method validation`, () => {
			const method = validateMethod({ ...ALL_GATES_PASS, [key]: false });
			expect(method.methodValidated).toBe(false);
			expect(method.proofRefusals.length).toBeGreaterThan(0);
		});
	}
});

describe('SLO policy validation', () => {
	test('an empty ceiling set is invalid (audit repro)', () => {
		const result = validateSloPolicy({
			configured: true,
			ceilings: {} as never,
		});
		expect(result.valid).toBe(false);
	});
	test('a partial ceiling set is invalid', () => {
		const partial = {
			configured: true,
			ceilings: { read: 1 } as never,
		} as AbsoluteSloPolicy;
		expect(validateSloPolicy(partial).valid).toBe(false);
	});
	test('a non-positive or non-finite ceiling is invalid', () => {
		const bad = {
			configured: true,
			ceilings: { ...FULL_CEILINGS, read: 0 },
		} as AbsoluteSloPolicy;
		expect(validateSloPolicy(bad).valid).toBe(false);
	});
	test('a full positive ceiling set is valid', () => {
		expect(validateSloPolicy(CONFIGURED).valid).toBe(true);
	});
	test('the unconfigured policy is invalid (fail-closed)', () => {
		expect(validateSloPolicy(UNCONFIGURED_SLO_POLICY).valid).toBe(false);
	});
});

describe('audit repro: configured-but-empty ceilings is invalid, not ready', () => {
	test('empty ceilings yields status invalid', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: { configured: true, ceilings: {} as never },
			sloObservations: [],
			expectedCells: [],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('invalid');
	});
});

describe('a pilot is never ADR-ready', () => {
	test('a pilot with every gate passing is at most provisional', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			sloObservations: null,
			expectedCells: [],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('pilot');
	});
	test('calibration without selected operations is incomplete, not provisional', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			execution: {
				status: 'INCOMPLETE',
				reasons: [
					'CALIBRATION_OPS_UNSELECTED: selectedOps is null for replica/confirmedTraversal',
				],
			},
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			sloObservations: null,
			expectedCells: [],
			matrixComplete: false,
		});
		expect(readiness.status).toBe('incomplete');
		expect(readiness.reasons.join(' ')).toContain('CALIBRATION_OPS_UNSELECTED');
	});
});

describe('fail-closed: a configured flag alone never implies readiness', () => {
	test('valid ceilings but no observations is incomplete', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: CONFIGURED,
			sloObservations: null,
			expectedCells: [CELL],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('incomplete');
	});

	test('valid ceilings but a missing per-cell metric observation is incomplete', () => {
		const partial = observationsWithin(CELL).slice(1); // drop one required metric
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: CONFIGURED,
			sloObservations: partial,
			expectedCells: [CELL],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('incomplete');
		expect(readiness.reasons.join(' ')).toContain('missing SLO observation');
	});

	test('an observed SLO breach is provisional, not ready', () => {
		const breached = observationsWithin(CELL).map((o, i) =>
			i === 0 ? { ...o, observedValue: 2000, withinCeiling: false } : o,
		);
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: CONFIGURED,
			sloObservations: breached,
			expectedCells: [CELL],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('SLO breach');
	});

	test('only a full within-ceiling observation set reaches ready-for-adr-review', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: CONFIGURED,
			sloObservations: observationsWithin(CELL),
			expectedCells: [CELL],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('ready-for-adr-review');
		expect(readiness.reasons).toEqual([]);
	});
});

describe('incompleteness and method gaps downgrade the state', () => {
	test('an incomplete matrix is incomplete', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: { status: 'COMPLETE', method: validateMethod(ALL_GATES_PASS) },
			sloPolicy: CONFIGURED,
			sloObservations: observationsWithin(CELL),
			expectedCells: [CELL],
			matrixComplete: false,
		});
		expect(readiness.status).toBe('incomplete');
	});
	test('a failed proof gate is provisional and lists the refusal', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			execution: {
				status: 'COMPLETE',
				method: validateMethod({ ...ALL_GATES_PASS, integrityOk: false }),
			},
			sloPolicy: CONFIGURED,
			sloObservations: observationsWithin(CELL),
			expectedCells: [CELL],
			matrixComplete: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('integrity');
	});
});
