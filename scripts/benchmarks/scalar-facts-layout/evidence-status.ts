/**
 * Classifier-only evidence status. Fail-closed by construction.
 *
 * Policy (ADR-0161; spec 424-444, 555-562): evidence never selects, ranks,
 * recommends, applies a tie-break, or returns a candidate id. There is no
 * recommendation, winner, or tie-break concept anywhere in this module. It
 * reports two independent things:
 *
 * 1. `validateMethod` gives a run its method-validation verdict: whether every
 *    measurement-method proof gate, DERIVED FROM RECORDED OPERATIONS by the
 *    runner, passed. A gate is never a hardcoded boolean; the runner must feed
 *    evidence it actually executed and retained. A pilot validates the METHOD
 *    only; it is never ADR-ready.
 *
 * 2. `evaluateEvidenceReadiness` reports one of four states: `invalid`,
 *    `incomplete`, `provisional`, or `ready-for-adr-review`. It is fail-closed on
 *    the absolute performance SLO policy: readiness requires a configured policy
 *    with a positive finite ceiling for EVERY required metric AND an observed
 *    per-cell measurement within that ceiling for every cell and metric. A
 *    `configured: true` flag alone never implies readiness (an empty or malformed
 *    ceiling set is `invalid`), and a pilot is always at most `provisional`.
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
	/** The run's source and config identity match the persisted checkpoint. */
	provenanceMatches: boolean;
	/** The declared seed-level familywise estimator produced no structural refusal. */
	estimatorOk: boolean;
	/** Read-metric position and carryover are balanced across the executed Williams design. */
	balanced: boolean;
	/** Every RECORDED timed block met the 20 ms floor at the frozen operation count. */
	calibrationMet: boolean;
	/** Untimed warmup batches ran immediately before each recorded timed block. */
	warmupsRun: boolean;
	/** SQLite integrity_check passed and each candidate's recorded reopened self-hash matched. */
	integrityOk: boolean;
	/** At least the required balanced close/open reopen observations were recorded per cell. */
	reopenObservationsSufficient: boolean;
	/** A recorded byte-equivalent reset proved no candidate inherited another's state. */
	deterministicResetProven: boolean;
	/** The headroom preflight passed BEFORE retaining the envelope databases, with a 25% margin. */
	headroomPreflightPassed: boolean;
	/** Every declared owner-specific metric and mutating-tail experiment was executed and recorded. */
	ownerWorkloadsExecuted: boolean;
	/** Raw per-block, reopen, and checkpoint identities and observations were retained. */
	rawObservationsRetained: boolean;
	/**
	 * The run's dimensions match the frozen exact-envelope pilot: exactly 1,000,000
	 * final-present addresses, exactly 536,870,912 proxy bytes, four fresh seeds,
	 * three complete Williams cycles, at least twenty reopens, and at least 400 tail
	 * transactions. A bounded smoke fails this and can never be method-validated.
	 */
	exactEnvelopeConformant: boolean;
	/**
	 * The checkpoint-boundary observation is a truthful, non-perturbing signal
	 * grounded in SQLite behavior. If no such signal is available the runner records
	 * the limitation and fails this gate rather than fabricating boundaries.
	 */
	checkpointBoundariesTruthful: boolean;
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
			detail: 'run source and config identity match the persisted checkpoint',
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
			detail:
				'read-metric position and carryover are balanced in the executed design',
		},
		{
			name: 'calibration',
			passed: inputs.calibrationMet && inputs.warmupsRun,
			detail:
				'every recorded timed block met the 20 ms floor after an immediate untimed warmup',
		},
		{
			name: 'integrity',
			passed: inputs.integrityOk,
			detail:
				'SQLite integrity_check passed and each recorded reopened self-hash matched',
		},
		{
			name: 'reopen',
			passed: inputs.reopenObservationsSufficient,
			detail: 'the required balanced reopen observations were recorded',
		},
		{
			name: 'cross-candidate-isolation',
			passed: inputs.deterministicResetProven,
			detail:
				'a recorded deterministic reset proved no candidate inherited another cache or checkpoint state',
		},
		{
			name: 'headroom',
			passed: inputs.headroomPreflightPassed,
			detail:
				'the headroom preflight passed before retaining the envelope databases',
		},
		{
			name: 'owner-workloads',
			passed: inputs.ownerWorkloadsExecuted,
			detail:
				'every declared owner-specific metric and mutating-tail experiment was executed',
		},
		{
			name: 'raw-observations',
			passed: inputs.rawObservationsRetained,
			detail:
				'raw per-block, reopen, and checkpoint observations were retained',
		},
		{
			name: 'exact-envelope',
			passed: inputs.exactEnvelopeConformant,
			detail:
				'the run matches the frozen exact-envelope pilot (1,000,000 present addresses, 512 MiB proxy, four seeds, three cycles); a smoke can never pass this',
		},
		{
			name: 'checkpoint-truthful',
			passed: inputs.checkpointBoundariesTruthful,
			detail:
				'the checkpoint-boundary signal is truthful and non-perturbing, grounded in SQLite behavior',
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
 * The closed set of absolute performance metrics an ADR-ready classifier must
 * bound. The numeric ceilings are unmade ADR/product choices; this module ships
 * no numbers and only validates a supplied policy's shape.
 */
export const REQUIRED_SLO_METRICS = [
	'install',
	'open',
	'read',
	'write',
	'feed',
	'traversal',
	'restart',
] as const;
export type SloMetric = (typeof REQUIRED_SLO_METRICS)[number];

export type AbsoluteSloPolicy =
	| { configured: false }
	| { configured: true; ceilings: Readonly<Record<SloMetric, number>> };

/** The only SLO policy this pilot ships: none. Fail-closed. */
export const UNCONFIGURED_SLO_POLICY: AbsoluteSloPolicy = { configured: false };

export type SloPolicyValidation =
	| { valid: true }
	| { valid: false; reasons: string[] };

/**
 * A configured policy is valid only when every required metric has a positive
 * finite ceiling and no unknown metric appears. An empty or partial ceiling set
 * is invalid, so `configured: true` never implies readiness by itself.
 */
export function validateSloPolicy(
	policy: AbsoluteSloPolicy,
): SloPolicyValidation {
	if (!policy.configured) {
		return {
			valid: false,
			reasons: [
				'the absolute performance SLO policy is unconfigured: install, open, read, write, feed, traversal, and restart ceilings are unmade ADR/product choices',
			],
		};
	}
	const reasons: string[] = [];
	for (const metric of REQUIRED_SLO_METRICS) {
		const ceiling = policy.ceilings[metric];
		if (
			typeof ceiling !== 'number' ||
			!Number.isFinite(ceiling) ||
			ceiling <= 0
		) {
			reasons.push(
				`SLO ceiling for '${metric}' is missing or not a positive finite number`,
			);
		}
	}
	for (const key of Object.keys(policy.ceilings)) {
		if (!(REQUIRED_SLO_METRICS as readonly string[]).includes(key)) {
			reasons.push(`unknown SLO metric '${key}'`);
		}
	}
	return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}

/** One observed per-cell SLO comparison against a configured ceiling. */
export type SloObservation = {
	owner: string;
	candidate: string;
	seedId: number;
	metric: SloMetric;
	observedValue: number;
	ceiling: number;
	withinCeiling: boolean;
};

/** A cell that must carry an SLO observation for every required metric. */
export type EvidenceCell = { owner: string; candidate: string; seedId: number };

export type EvidenceStatus =
	| 'invalid'
	| 'incomplete'
	| 'provisional'
	| 'ready-for-adr-review';

export type EvidenceReadiness = {
	status: EvidenceStatus;
	/** Every reason for the state; empty exactly when `ready-for-adr-review`. */
	reasons: string[];
};

export type EvidenceInputs = {
	/** A pilot can never be ADR-ready, regardless of gates. */
	isPilot: boolean;
	method: MethodValidation;
	sloPolicy: AbsoluteSloPolicy;
	/** Observed per-cell SLO results; null when SLOs were not evaluated (e.g. a pilot). */
	sloObservations: SloObservation[] | null;
	/** Cells that must each carry an observation for every required metric. */
	expectedCells: EvidenceCell[];
	/** Whether every owner-by-candidate-by-seed cell is present. */
	matrixComplete: boolean;
	/** Whether the equivalence classifier resolved every contrast (none inconclusive). */
	classifierResolved: boolean;
};

function cellKey(cell: EvidenceCell): string {
	return `${cell.owner}/${cell.candidate}/${cell.seedId}`;
}

/**
 * Fail-closed evidence status. Precedence: `invalid` over `incomplete` over
 * `provisional` over `ready-for-adr-review`. Readiness requires a valid
 * configured SLO policy, an observed within-ceiling measurement for every
 * required metric in every expected cell, a validated method, a complete matrix,
 * a resolved classifier, and a non-pilot run. Any gap downgrades the state and
 * records why.
 */
export function evaluateEvidenceReadiness(
	inputs: EvidenceInputs,
): EvidenceReadiness {
	const invalidReasons: string[] = [];
	const incompleteReasons: string[] = [];
	const provisionalReasons: string[] = [];

	const policy = validateSloPolicy(inputs.sloPolicy);
	if (inputs.sloPolicy.configured) {
		// A configured-but-malformed policy is a structural error, not mere absence.
		if (!policy.valid) invalidReasons.push(...policy.reasons);
	} else {
		// An unconfigured policy is not invalid; it just prevents ADR readiness.
		provisionalReasons.push(
			'the absolute performance SLO policy is unconfigured: install, open, read, write, feed, traversal, and restart ceilings are unmade ADR/product choices',
		);
	}
	if (inputs.sloObservations !== null && !inputs.sloPolicy.configured) {
		invalidReasons.push(
			'SLO observations were supplied without a configured SLO policy',
		);
	}

	if (inputs.isPilot) {
		provisionalReasons.push(
			'a measurement-method pilot validates the method only; it never produces ADR-ready evidence',
		);
	}
	if (!inputs.method.methodValidated) {
		provisionalReasons.push(...inputs.method.proofRefusals);
	}
	if (!inputs.matrixComplete) {
		incompleteReasons.push(
			'the owner-by-candidate-by-seed matrix is incomplete',
		);
	}
	if (!inputs.classifierResolved) {
		incompleteReasons.push(
			'the equivalence classifier left at least one contrast unresolved',
		);
	}

	// SLO observation completeness and within-ceiling, only meaningful under a
	// valid configured policy.
	if (inputs.sloPolicy.configured && policy.valid) {
		if (inputs.sloObservations === null) {
			incompleteReasons.push('no SLO observations were recorded');
		} else {
			const seen = new Set(
				inputs.sloObservations.map(
					(o) => `${o.owner}/${o.candidate}/${o.seedId}/${o.metric}`,
				),
			);
			for (const cell of inputs.expectedCells) {
				for (const metric of REQUIRED_SLO_METRICS) {
					if (!seen.has(`${cellKey(cell)}/${metric}`)) {
						incompleteReasons.push(
							`missing SLO observation for ${cellKey(cell)} metric '${metric}'`,
						);
					}
				}
			}
			for (const observation of inputs.sloObservations) {
				if (!observation.withinCeiling) {
					provisionalReasons.push(
						`SLO breach at ${observation.owner}/${observation.candidate}/${observation.seedId} metric '${observation.metric}': ${observation.observedValue} exceeds ${observation.ceiling}`,
					);
				}
			}
		}
	}

	if (invalidReasons.length > 0) {
		return { status: 'invalid', reasons: dedupe(invalidReasons) };
	}
	if (incompleteReasons.length > 0) {
		return { status: 'incomplete', reasons: dedupe(incompleteReasons) };
	}
	if (provisionalReasons.length > 0) {
		return { status: 'provisional', reasons: dedupe(provisionalReasons) };
	}
	return { status: 'ready-for-adr-review', reasons: [] };
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}
