/**
 * Classifier-only evidence status. These tests prove the policy: no recommendation
 * or tie-break exists, a pilot only validates the method and is never ADR-ready,
 * every failed proof gate blocks method validation, and no complete/correct/
 * classified matrix can become `ready` while the absolute SLO policy is
 * unconfigured (fail-closed).
 */

import { describe, expect, test } from 'bun:test';

import {
	type AbsoluteSloPolicy,
	evaluateEvidenceReadiness,
	type ProofGateInputs,
	UNCONFIGURED_SLO_POLICY,
	validateMethod,
} from './evidence-status.js';

const ALL_GATES_PASS: ProofGateInputs = {
	oracleWitnessReproduced: true,
	crossCandidateConsistent: true,
	provenanceMatches: true,
	estimatorOk: true,
	balanced: true,
	calibrationMet: true,
	warmupsRun: true,
	integrityOk: true,
	reopenObservationsSufficient: true,
	deterministicResetProven: true,
	headroomPreflightPassed: true,
};

describe('the contract exposes no selection concept', () => {
	test('no recommendation, winner, or tie-break field is produced', () => {
		const method = validateMethod(ALL_GATES_PASS);
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			method,
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			matrixComplete: true,
			classifierResolved: true,
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

describe('method validation', () => {
	test('all gates passing validates the method', () => {
		const method = validateMethod(ALL_GATES_PASS);
		expect(method.methodValidated).toBe(true);
		expect(method.proofRefusals).toEqual([]);
	});

	const gateKeys: Array<keyof ProofGateInputs> = [
		'oracleWitnessReproduced',
		'crossCandidateConsistent',
		'provenanceMatches',
		'estimatorOk',
		'balanced',
		'calibrationMet',
		'warmupsRun',
		'integrityOk',
		'reopenObservationsSufficient',
		'deterministicResetProven',
		'headroomPreflightPassed',
	];
	for (const key of gateKeys) {
		test(`${key} = false fails method validation`, () => {
			const method = validateMethod({ ...ALL_GATES_PASS, [key]: false });
			expect(method.methodValidated).toBe(false);
			expect(method.proofRefusals.length).toBeGreaterThan(0);
		});
	}
});

describe('a pilot is never ADR-ready', () => {
	test('a pilot with every gate passing is still provisional', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: true,
			method: validateMethod(ALL_GATES_PASS),
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			matrixComplete: true,
			classifierResolved: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('pilot');
	});
});

describe('fail-closed on absolute SLO policy', () => {
	test('a complete, correct, classified non-pilot matrix is STILL provisional while SLOs are unconfigured', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			method: validateMethod(ALL_GATES_PASS),
			sloPolicy: UNCONFIGURED_SLO_POLICY,
			matrixComplete: true,
			classifierResolved: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('SLO policy is unconfigured');
	});

	test('ready is reachable only once an SLO policy is configured (numbers supplied by the caller, not this module)', () => {
		// The test supplies ceilings; the module ships none. This proves the gate is
		// real without the pilot inventing product SLO numbers.
		const configured: AbsoluteSloPolicy = {
			configured: true,
			ceilings: {
				install: 1,
				open: 1,
				read: 1,
				write: 1,
				feed: 1,
				traversal: 1,
				restart: 1,
			},
		};
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			method: validateMethod(ALL_GATES_PASS),
			sloPolicy: configured,
			matrixComplete: true,
			classifierResolved: true,
		});
		expect(readiness.status).toBe('ready');
		expect(readiness.reasons).toEqual([]);
	});

	test('the shipped policy is unconfigured (fail-closed)', () => {
		expect(UNCONFIGURED_SLO_POLICY.configured).toBe(false);
	});
});

describe('other readiness gaps also force provisional', () => {
	const configured: AbsoluteSloPolicy = {
		configured: true,
		ceilings: { read: 1 },
	};
	test('an incomplete matrix is provisional', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			method: validateMethod(ALL_GATES_PASS),
			sloPolicy: configured,
			matrixComplete: false,
			classifierResolved: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('incomplete');
	});
	test('an unresolved classifier is provisional', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			method: validateMethod(ALL_GATES_PASS),
			sloPolicy: configured,
			matrixComplete: true,
			classifierResolved: false,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('unresolved');
	});
	test('a failed proof gate is provisional and lists the refusal', () => {
		const readiness = evaluateEvidenceReadiness({
			isPilot: false,
			method: validateMethod({ ...ALL_GATES_PASS, integrityOk: false }),
			sloPolicy: configured,
			matrixComplete: true,
			classifierResolved: true,
		});
		expect(readiness.status).toBe('provisional');
		expect(readiness.reasons.join(' ')).toContain('integrity');
	});
});
