/**
 * Measurement-method validation. Fail-closed by construction.
 *
 * Policy (ADR-0161; spec 424-444, 555-562): evidence never selects, ranks,
 * recommends, applies a tie-break, or returns a candidate id. There is no
 * recommendation, winner, or tie-break concept anywhere in this module.
 * `validateMethod` gives a run its method-validation verdict: whether every
 *    measurement-method proof gate, DERIVED FROM RECORDED OPERATIONS by the
 *    runner, passed. A gate is never a hardcoded boolean; the runner must feed
 *    evidence it actually executed and retained. A pilot validates the METHOD
 *    only; it is never ADR-ready.
 *
 * Final-evidence readiness and absolute SLO policy are deliberately absent. No
 * product policy owns those concepts yet, so this pilot reports only the method
 * facts it can establish and never predicts a future ADR-readiness contract.
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
	/** Every identity-closed seed estimator exactly matches retained raw observations. */
	estimatorsComplete: boolean;
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
	/** Every raw array and nested warmup/tail count exactly matches frozen owners. */
	observationCountsExact: boolean;
	/**
	 * The run's dimensions match the frozen exact-envelope pilot: exactly 1,000,000
	 * final-present addresses, exactly 536,870,912 proxy bytes, four fresh seeds,
	 * three complete Williams cycles, exactly twenty reopens, and exactly 400 tail
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
			name: 'seed-estimators',
			passed: inputs.estimatorsComplete,
			detail:
				'every identity-closed seed estimator exactly matches retained raw observations',
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
			name: 'exact-observation-counts',
			passed: inputs.observationCountsExact,
			detail:
				'every raw array and nested warmup/tail count exactly matches the frozen config, trace, and schedule owners',
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
