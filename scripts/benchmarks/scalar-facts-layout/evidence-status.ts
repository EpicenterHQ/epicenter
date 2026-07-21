/**
 * Classifier-only evidence status. Fail-closed by construction.
 *
 * Policy (ADR-0161; spec 424-444, 555-562): evidence never selects, ranks,
 * recommends, applies a tie-break, or returns a candidate id. There is therefore
 * no recommendation, winner, or tie-break concept anywhere in this module. It
 * reports two independent things:
 *
 * 1. `validateMethod` gives a measurement-method pilot its only product: whether
 *    every proof gate passed, so the method is sound enough to justify a later
 *    final data-collection run. A pilot validates the METHOD; it is never
 *    decision-eligible and can never make evidence ADR-ready. There is no
 *    `decisionEligible` boolean here on purpose.
 *
 * 2. `evaluateEvidenceReadiness` reports whether any run's evidence is
 *    ADR-`ready` or `provisional`. It is fail-closed: while the absolute
 *    performance SLO policy is unconfigured, evidence is forced to `provisional`
 *    with a stated reason. The install, open, read, write, feed, traversal, and
 *    restart ceilings are unmade ADR/product choices; this module ships only the
 *    unconfigured shape and invents no numeric defaults, so no complete, correct,
 *    classified matrix can become `ready` until those choices exist.
 *
 * Correctness note (spec/audit): a candidate reproducing the analytical, V1-bound
 * oracle witness is the INDEPENDENT correctness proof. Candidates agreeing with
 * one another, or a reopened database agreeing with itself, is cross-candidate or
 * reopen CONSISTENCY, not independent correctness; those are separate gates.
 */

export type GateStatus = {
	name: string;
	passed: boolean;
	detail: string;
};

export type ProofGateInputs = {
	/** INDEPENDENT correctness: every cell reproduced the analytical V1-bound oracle witness. */
	oracleWitnessReproduced: boolean;
	/** CONSISTENCY, not correctness: candidates agree with each other where compared. */
	crossCandidateConsistent: boolean;
	/** The run's source and config identity match the checkpoint. */
	provenanceMatches: boolean;
	/** The declared seed-level familywise estimator produced no structural refusal. */
	estimatorOk: boolean;
	/** Read-metric position and carryover are balanced across the Williams design. */
	balanced: boolean;
	/** Every timed block met the 20 ms floor at the frozen operation count. */
	calibrationMet: boolean;
	/** The untimed warmup batches ran before each timed candidate block. */
	warmupsRun: boolean;
	/** SQLite integrity_check passed and each candidate's reopened self-hash matched. */
	integrityOk: boolean;
	/** At least the required close/open reopen observations per seed and candidate. */
	reopenObservationsSufficient: boolean;
	/** Deterministic byte-equivalent reset proved no candidate inherited another's state. */
	deterministicResetProven: boolean;
	/** The live-page plus WAL/temp headroom preflight passed with the 25% margin. */
	headroomPreflightPassed: boolean;
};

export type MethodValidation = {
	/** True only when every measurement-method proof gate passed. */
	methodValidated: boolean;
	gates: GateStatus[];
	/** Failed-gate reasons, empty exactly when `methodValidated`. */
	proofRefusals: string[];
};

/** The ordered proof gates. Adding a gate here adds it to the conjunction. */
function gatesOf(inputs: ProofGateInputs): GateStatus[] {
	return [
		{
			name: 'oracle-correctness',
			passed: inputs.oracleWitnessReproduced,
			detail:
				'every cell reproduced the analytical V1-bound oracle witness (independent correctness)',
		},
		{
			name: 'cross-candidate-consistency',
			passed: inputs.crossCandidateConsistent,
			detail: 'candidates agree with one another where compared (consistency)',
		},
		{
			name: 'provenance',
			passed: inputs.provenanceMatches,
			detail: 'run source and config identity match the checkpoint',
		},
		{
			name: 'estimator',
			passed: inputs.estimatorOk,
			detail:
				'the seed-level familywise estimator produced no structural refusal',
		},
		{
			name: 'balance',
			passed: inputs.balanced,
			detail: 'read-metric position and carryover are balanced',
		},
		{
			name: 'calibration',
			passed: inputs.calibrationMet && inputs.warmupsRun,
			detail: 'every timed block met the 20 ms floor after untimed warmups',
		},
		{
			name: 'integrity',
			passed: inputs.integrityOk,
			detail:
				'SQLite integrity_check passed and each reopened self-hash matched',
		},
		{
			name: 'reopen',
			passed: inputs.reopenObservationsSufficient,
			detail: 'the required balanced reopen observations were collected',
		},
		{
			name: 'cross-candidate-isolation',
			passed: inputs.deterministicResetProven,
			detail:
				'deterministic reset proved no candidate inherited another cache or checkpoint state',
		},
		{
			name: 'headroom',
			passed: inputs.headroomPreflightPassed,
			detail:
				'the live-page plus WAL/temp headroom preflight passed with a 25% margin',
		},
	];
}

export function validateMethod(inputs: ProofGateInputs): MethodValidation {
	const gates = gatesOf(inputs);
	const failed = gates.filter((gate) => !gate.passed);
	return {
		methodValidated: failed.length === 0,
		gates,
		proofRefusals: failed.map((gate) => `${gate.name}: ${gate.detail}`),
	};
}

/**
 * Absolute performance SLO policy for the future evidence classifier. The
 * numeric install/open/read/write/feed/traversal/restart ceilings are ADR/product
 * choices that are NOT YET MADE, so this pilot ships only the fail-closed
 * `configured: false` shape. A configured policy is modeled structurally, as a
 * map from metric key to ceiling, with NO numeric defaults chosen here; the owner
 * of that choice supplies the numbers.
 */
export type AbsoluteSloPolicy =
	| { configured: false }
	| { configured: true; ceilings: Readonly<Record<string, number>> };

/** The only SLO policy this pilot ships: none. Fail-closed. */
export const UNCONFIGURED_SLO_POLICY: AbsoluteSloPolicy = { configured: false };

export type EvidenceStatus = 'provisional' | 'ready';

export type EvidenceReadiness = {
	/** `ready` is unreachable while the SLO policy is unconfigured or the run is a pilot. */
	status: EvidenceStatus;
	/** Every reason the evidence is provisional; empty exactly when `ready`. */
	reasons: string[];
};

export type EvidenceInputs = {
	/** A pilot can never be ADR-ready, regardless of gates. */
	isPilot: boolean;
	method: MethodValidation;
	sloPolicy: AbsoluteSloPolicy;
	/** Whether every owner-by-candidate-by-seed cell is present. */
	matrixComplete: boolean;
	/** Whether the equivalence classifier resolved every contrast (none inconclusive). */
	classifierResolved: boolean;
};

/**
 * Fail-closed evidence readiness. Evidence is `ready` only when it is not a pilot,
 * the absolute SLO policy is configured, the method validated, the matrix is
 * complete, and the classifier resolved every contrast. Any gap forces
 * `provisional` and records why, so an unconfigured SLO policy alone keeps even a
 * complete, correct, fully classified matrix out of ADR readiness.
 */
export function evaluateEvidenceReadiness(
	inputs: EvidenceInputs,
): EvidenceReadiness {
	const reasons: string[] = [];
	if (inputs.isPilot) {
		reasons.push(
			'a measurement-method pilot validates the method only; it never produces ADR-ready evidence',
		);
	}
	if (!inputs.sloPolicy.configured) {
		reasons.push(
			'the absolute performance SLO policy is unconfigured: install, open, read, write, feed, traversal, and restart ceilings are unmade ADR/product choices, so evidence cannot be classified against absolute limits',
		);
	}
	if (!inputs.method.methodValidated) {
		reasons.push(...inputs.method.proofRefusals);
	}
	if (!inputs.matrixComplete) {
		reasons.push('the owner-by-candidate-by-seed matrix is incomplete');
	}
	if (!inputs.classifierResolved) {
		reasons.push(
			'the equivalence classifier left at least one contrast unresolved',
		);
	}
	return {
		status: reasons.length === 0 ? 'ready' : 'provisional',
		reasons,
	};
}
