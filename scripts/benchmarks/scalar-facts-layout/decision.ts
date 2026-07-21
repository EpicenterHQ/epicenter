/**
 * Evidence-status classifier.
 *
 * This benchmark records reproducible, correctness-first evidence for the scalar
 * layout candidates so an ADR can choose the physical layout. It NEVER names,
 * ranks, or tie-breaks a winner, and never claims Bun-only evidence qualifies a
 * layout. The ADR owns the choice. Even complete future evidence stops at
 * `ready-for-ADR-review`; there is no automated selector here by design (the
 * asymmetric win: the whole Pareto/materiality/tie-break machinery is deleted).
 *
 * The classifier fails closed. It returns `invalid` on any duplicate cell, a
 * `failed` outcome, a plan-semantics or constraint proof failure, a malformed or
 * changed witness, a non-ok integrity check, a non-finite storage field, an
 * empty/negative/non-finite timing sample, an unexpected or out-of-range cell, a
 * seed that is inconsistent within a repetition or not distinct across
 * repetitions, or a globally required metric missing; `incomplete` when the
 * expected owner x candidate x repetition matrix (at least the required
 * repetitions) is not fully populated and passing; and `provisional` when it is,
 * because unsupported real workflows and qualifying runtimes still remain. This
 * Bun instrument can never emit `ready-for-ADR-review`: that status is reserved
 * for a future harness that closes those gaps. The per-cell `outcome`
 * (passed|failed|unsupported|not-admitted) is distinct from this run-level status.
 */
import { CANDIDATES } from './layouts.js';
import { evaluatePlanProof } from './plan-proof.js';
import type { Owner, RunResult } from './runner.js';

export type EvidenceStatus =
	| 'invalid'
	| 'incomplete'
	| 'provisional'
	| 'ready-for-ADR-review';

/** This instrument freezes two owners and four candidates; config must draw from these. */
const FROZEN_OWNERS: readonly string[] = ['replica', 'authority'];
const FROZEN_CANDIDATES: readonly string[] = CANDIDATES.map((c) => c.id);

/** Required timing metrics per owner; a globally missing one fails closed. */
const REQUIRED_METRICS: Record<Owner, readonly string[]> = {
	replica: [
		'acquisition',
		'rowPointRead',
		'valuePointRead',
		'traverse',
		'warmReopen',
	],
	authority: [
		'acquisition',
		'feedFresh',
		'feedResume',
		'foldPointRead',
		'warmReopen',
	],
};

/** Real V1 workflows this confirmed-facts-only Bun instrument does not measure. */
export const UNSUPPORTED_WORKFLOWS = [
	'authority submission settlement',
	'authority exact-retry',
	'authority parked-result handling',
	'replica pending-intent overlay read',
	'replica tombstone-driven document cleanup',
];

/** Runtimes this Bun instrument cannot qualify. */
export const UNSUPPORTED_PLATFORMS = [
	'OPFS persistence (granted and denied)',
	'storage quota admission and refusal recovery',
	'WebKit / iOS Safari and Android Chrome',
	'Worker storage locks and backgrounding',
	'Durable Object SQLite',
];

export type CellEvidence = {
	owner: Owner;
	candidateId: string;
	repetition: number;
	dataSeed: number;
	outcome: string;
	correct: boolean;
	/** Median of raw samples per timing metric, plus the two page measures. Unranked. */
	metrics: Record<string, number>;
};

export type EvidenceReport = {
	status: EvidenceStatus;
	/** Instrument-level fact: this Bun harness never produces a qualifying run. */
	qualifyingRuntime: false;
	reasons: string[];
	expectedCells: number;
	passedCells: number;
	repetitions: number;
	requiredRepetitions: number;
	unsupportedWorkflows: string[];
	unsupportedPlatforms: string[];
	/** Machine-readable raw evidence; NEVER a ranking or a chosen candidate. */
	cells: CellEvidence[];
};

/**
 * The declared oracle for one repetition, computed from that repetition's seed by
 * the same independent trace the cells measured against. Every cell of that
 * repetition must match it exactly, which automatically binds paired cells to one
 * agreed current state (count, protocol bytes, digest) and one seed.
 *
 * Lifecycle cardinalities are deliberately NOT here: the classifier does not
 * recompute them against a frozen trace, so it would be dishonest to claim it
 * validates them exactly. They are retained only as descriptive trace metadata in
 * the artifact, never bound by this classifier.
 */
export type RepetitionOracle = {
	repetition: number;
	dataSeed: number;
	count: number;
	currentProtocolFactBytes: number;
	digestHex: string;
	presentCount: number;
	presentLogicalStateBytes: number;
	totalFacts: number;
	finalAbsent: number;
};

export type ClassifyOptions = {
	/** The only runtime/profile identity this run may carry; any other cell is invalid. */
	expectedRuntime: string;
	expectedProfile: string;
	/** The declared per-repetition oracle; every cell binds to its repetition's entry. */
	expectedRepetitionOracles: RepetitionOracle[];
	expectedOwners: readonly Owner[];
	expectedCandidateIds: readonly string[];
	/** The pre-pilot repetition count this run declares (local, not qualification). */
	requiredRepetitions: number;
};

/** The outcomes this Bun classifier accepts; unsupported/not-admitted are rejected here. */
const ACCEPTED_OUTCOMES = new Set(['passed', 'failed']);

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
		: (sorted[mid] ?? 0);
}

const isFiniteNonNegInt = (n: unknown): boolean =>
	typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isLowerHex64 = (s: unknown): boolean =>
	typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
/** A timing sample array must be nonempty and every sample finite and non-negative. */
const validSamples = (samples: number[]): boolean =>
	samples.length > 0 && samples.every((s) => Number.isFinite(s) && s >= 0);

function cellMetrics(result: RunResult): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, samples] of Object.entries(result.metrics))
		out[key] = median(samples);
	out.allocatedPageBytes = result.storage.allocatedPageBytes;
	out.nonFreelistPageBytes = result.storage.nonFreelistPageBytes;
	return out;
}

export function classifyEvidence(
	results: RunResult[],
	options: ClassifyOptions,
): EvidenceReport {
	const reasons: string[] = [];
	let invalid = false;
	const fail = (message: string): void => {
		reasons.push(message);
		invalid = true;
	};

	// Fail closed on the CONFIGURATION itself, before classifying any cell. A
	// degenerate config (0/negative/fractional reps, empty/duplicate/unknown
	// owners or candidates, empty identity) must never yield a provisional 0/0 or
	// a double-counted matrix.
	if (
		!Number.isSafeInteger(options.requiredRepetitions) ||
		options.requiredRepetitions < 1
	) {
		fail(`requiredRepetitions must be an integer >= 1`);
	}
	if (options.expectedRuntime.length === 0) fail('empty expectedRuntime');
	if (options.expectedProfile.length === 0) fail('empty expectedProfile');
	const distinctNonEmpty = (
		label: string,
		values: readonly string[],
		known: readonly string[],
	): void => {
		if (values.length === 0) fail(`empty expected ${label}`);
		if (new Set(values).size !== values.length)
			fail(`duplicate expected ${label}`);
		for (const v of values)
			if (!known.includes(v)) fail(`unknown expected ${label}: ${v}`);
	};
	distinctNonEmpty('owners', options.expectedOwners, FROZEN_OWNERS);
	distinctNonEmpty(
		'candidates',
		options.expectedCandidateIds,
		FROZEN_CANDIDATES,
	);

	// If the repetition count is not a usable positive safe integer, return invalid
	// NOW: the matrix loops below iterate `requiredRepetitions`, so an unusable
	// value must never reach them (a 2^53 count would loop forever).
	if (
		!Number.isSafeInteger(options.requiredRepetitions) ||
		options.requiredRepetitions < 1
	) {
		return {
			status: 'invalid',
			qualifyingRuntime: false,
			reasons,
			expectedCells: 0,
			passedCells: 0,
			repetitions: 0,
			requiredRepetitions: 0,
			unsupportedWorkflows: [...UNSUPPORTED_WORKFLOWS],
			unsupportedPlatforms: [...UNSUPPORTED_PLATFORMS],
			cells: [],
		};
	}

	// The declared oracles must be an EXACT closed set: exactly one per repetition
	// 0..requiredReps-1, no extras, all fields finite non-negative integers,
	// internally consistent, with distinct seeds. Anything else fails closed.
	const requiredRepsForOracles = options.requiredRepetitions;
	const oracleByRep = new Map<number, RepetitionOracle>();
	if (options.expectedRepetitionOracles.length !== requiredRepsForOracles)
		fail(
			`declared ${options.expectedRepetitionOracles.length} oracles, need exactly ${requiredRepsForOracles}`,
		);
	const oracleSeeds = new Set<number>();
	for (const oracle of options.expectedRepetitionOracles) {
		if (oracleByRep.has(oracle.repetition))
			fail(`duplicate oracle for repetition ${oracle.repetition}`);
		oracleByRep.set(oracle.repetition, oracle);
		if (
			!Number.isInteger(oracle.repetition) ||
			oracle.repetition < 0 ||
			oracle.repetition >= requiredRepsForOracles
		) {
			fail(`oracle repetition ${oracle.repetition} out of range`);
		}
		for (const [field, value] of [
			['dataSeed', oracle.dataSeed],
			['count', oracle.count],
			['currentProtocolFactBytes', oracle.currentProtocolFactBytes],
			['presentCount', oracle.presentCount],
			['presentLogicalStateBytes', oracle.presentLogicalStateBytes],
			['totalFacts', oracle.totalFacts],
			['finalAbsent', oracle.finalAbsent],
		] as const) {
			if (!isFiniteNonNegInt(value))
				fail(`oracle rep ${oracle.repetition}: ${field} not a finite integer`);
		}
		if (!isLowerHex64(oracle.digestHex))
			fail(`oracle rep ${oracle.repetition}: malformed digest`);
		if (oracle.count !== oracle.totalFacts)
			fail(`oracle rep ${oracle.repetition}: count != totalFacts`);
		if (oracle.presentCount + oracle.finalAbsent !== oracle.totalFacts)
			fail(
				`oracle rep ${oracle.repetition}: present + finalAbsent != totalFacts`,
			);
		if (oracle.presentCount > oracle.count)
			fail(`oracle rep ${oracle.repetition}: presentCount > count`);
		if (oracleSeeds.has(oracle.dataSeed))
			fail(`oracle seed ${oracle.dataSeed} is not distinct`);
		oracleSeeds.add(oracle.dataSeed);
	}
	// Every required repetition must have exactly one oracle (no gaps).
	for (let rep = 0; rep < requiredRepsForOracles; rep += 1) {
		if (!oracleByRep.has(rep)) fail(`missing oracle for repetition ${rep}`);
	}

	// Index cells; fail closed on any duplicate, failed outcome, out-of-range or
	// unexpected cell, degenerate timing/storage/witness field, plan-semantics
	// failure, or constraint-proof failure. A retained cell that fails any proof
	// invalidates the run.
	const requiredReps = options.requiredRepetitions;
	const byKey = new Map<string, RunResult>();
	for (const result of results) {
		const key = `${result.owner}|${result.candidateId}|${result.repetition}`;
		if (byKey.has(key)) fail(`duplicate cell ${key}`);
		byKey.set(key, result);

		// Fail closed on any cell outside the declared matrix. Guards the
		// REQUIRED_METRICS[owner] lookup below from an unknown owner.
		const ownerKnown = options.expectedOwners.includes(result.owner);
		if (!ownerKnown) fail(`unexpected owner in ${key}`);
		if (!options.expectedCandidateIds.includes(result.candidateId))
			fail(`unexpected candidate in ${key}`);
		if (
			!Number.isInteger(result.repetition) ||
			result.repetition < 0 ||
			result.repetition >= requiredReps
		) {
			fail(`repetition out of range in ${key}`);
		}

		// Runtime/profile identity: this run admits exactly one.
		if (result.runtime !== options.expectedRuntime)
			fail(`unexpected runtime ${result.runtime} in ${key}`);
		if (result.profile !== options.expectedProfile)
			fail(`unexpected profile ${result.profile} in ${key}`);

		// Outcome must be an accepted enum value and coherent with the cell. A forged
		// `passed` cell is caught here: it must be correct, reason ok, and every proof
		// recomputed-true below. Unknown/unsupported/not-admitted are invalid.
		if (!ACCEPTED_OUTCOMES.has(result.outcome))
			fail(`unaccepted outcome ${result.outcome} in ${key}`);
		if (result.outcome === 'failed')
			fail(`failed cell ${key}: ${result.reason}`);
		if (
			result.outcome === 'passed' &&
			(!result.correct || result.reason !== 'ok')
		)
			fail(`incoherent passed cell ${key} (correct=${result.correct})`);

		if (result.integrityCheck !== 'ok')
			fail(`integrity_check ${result.integrityCheck} in ${key}`);

		// Plan proof RECOMPUTED from the raw plans against the CANDIDATE's contract;
		// never trust the retained boolean, and require it to match the recomputation.
		const recomputedPlan = evaluatePlanProof(result.candidateId, result.plans);
		if (!recomputedPlan.ok) fail(`query plan proof failed in ${key}`);
		if (
			recomputedPlan.ok !== result.planProof.ok ||
			recomputedPlan.feedOrderedIndex !== result.planProof.feedOrderedIndex ||
			recomputedPlan.pointIndexed !== result.planProof.pointIndexed ||
			recomputedPlan.traverseIndexed !== result.planProof.traverseIndexed
		) {
			fail(`plan proof inconsistent with raw plans in ${key}`);
		}

		// Constraint proof: internally consistent (ok iff no failures) and passing.
		if (
			result.constraintProof.ok !==
			(result.constraintProof.failures.length === 0)
		)
			fail(`constraint proof ok/failures mismatch in ${key}`);
		if (!result.constraintProof.ok)
			fail(
				`constraint proof failed in ${key}: ${result.constraintProof.failures[0] ?? ''}`,
			);

		// Witness: before == after, and both are finite non-negative integers with a
		// well-formed lowercase 64-hex digest.
		for (const [label, w] of [
			['before', result.witness.before],
			['after', result.witness.after],
		] as const) {
			if (
				!isFiniteNonNegInt(w.count) ||
				!isFiniteNonNegInt(w.bytes) ||
				!isLowerHex64(w.digestHex)
			) {
				fail(`malformed witness (${label}) in ${key}`);
			}
		}
		if (
			result.witness.before.digestHex !== result.witness.after.digestHex ||
			result.witness.before.count !== result.witness.after.count ||
			result.witness.before.bytes !== result.witness.after.bytes
		) {
			fail(`witness changed across reopen in ${key}`);
		}

		// Storage: EXACTLY the required fields, each a finite non-negative integer,
		// with the physical relationships that must always hold and agreement with
		// the witness. Every field is checked by name (never merely iterated), so
		// deleting a field is caught, and any extra field is rejected.
		const s = result.storage;
		const requiredStorageFields = [
			'presentLogicalStateBytes',
			'currentProtocolFactBytes',
			'allocatedPageBytes',
			'nonFreelistPageBytes',
			'maxProtocolFactBytes',
			'presentCount',
			'currentCount',
		] as const;
		const storageKeys = Object.keys(s ?? {});
		if (storageKeys.length !== requiredStorageFields.length)
			fail(
				`storage has ${storageKeys.length} fields, need exactly 7 in ${key}`,
			);
		for (const field of requiredStorageFields) {
			if (!isFiniteNonNegInt(s?.[field]))
				fail(`storage.${field} missing or non-finite in ${key}`);
		}
		if (s.nonFreelistPageBytes > s.allocatedPageBytes)
			fail(`non-freelist exceeds allocated pages in ${key}`);
		if (s.presentCount > s.currentCount)
			fail(`present exceeds current count in ${key}`);
		if (s.maxProtocolFactBytes > s.currentProtocolFactBytes)
			fail(`max fact exceeds total protocol bytes in ${key}`);
		if (result.witness.before.count !== s.currentCount)
			fail(`witness count disagrees with storage currentCount in ${key}`);
		if (result.witness.before.bytes !== s.currentProtocolFactBytes)
			fail(`witness bytes disagree with storage protocol bytes in ${key}`);

		// Bind the cell to its repetition's declared oracle: dataSeed, both
		// witnesses, and the four storage quantities must equal it EXACTLY. This
		// binds paired cells to one agreed current state (a forged count, a wrong
		// digest, wrong bytes, mixed digests within a repetition, or a wrong seed
		// all fail here), not just self-equality.
		const oracle = oracleByRep.get(result.repetition);
		if (!oracle) {
			fail(`no declared oracle for repetition ${result.repetition} in ${key}`);
		} else {
			if (result.dataSeed !== oracle.dataSeed)
				fail(`dataSeed != oracle in ${key}`);
			for (const [label, w] of [
				['before', result.witness.before],
				['after', result.witness.after],
			] as const) {
				if (
					w.count !== oracle.count ||
					w.bytes !== oracle.currentProtocolFactBytes ||
					w.digestHex !== oracle.digestHex
				) {
					fail(`witness (${label}) != oracle in ${key}`);
				}
			}
			if (s.currentCount !== oracle.count)
				fail(`storage currentCount != oracle in ${key}`);
			if (s.currentProtocolFactBytes !== oracle.currentProtocolFactBytes)
				fail(`storage currentProtocolFactBytes != oracle in ${key}`);
			if (s.presentCount !== oracle.presentCount)
				fail(`storage presentCount != oracle in ${key}`);
			if (s.presentLogicalStateBytes !== oracle.presentLogicalStateBytes)
				fail(`storage presentLogicalStateBytes != oracle in ${key}`);
		}

		// Every timing metric array (not merely the required ones) must be nonempty
		// with finite non-negative samples.
		for (const [metric, samples] of Object.entries(result.metrics)) {
			if (!validSamples(samples))
				fail(`empty, negative, or non-finite samples for ${metric} in ${key}`);
		}
		if (!ownerKnown) continue;
		for (const metric of REQUIRED_METRICS[result.owner]) {
			if (!(metric in result.metrics))
				fail(`missing required metric ${metric} in ${key}`);
		}
	}

	// Seed discipline: one seed per repetition (paired), distinct across repetitions.
	const seedByRep = new Map<number, number>();
	for (const result of results) {
		const prior = seedByRep.get(result.repetition);
		if (prior === undefined) seedByRep.set(result.repetition, result.dataSeed);
		else if (prior !== result.dataSeed) {
			fail(`inconsistent seed within repetition ${result.repetition}`);
		}
	}
	const seeds = [...seedByRep.values()];
	if (new Set(seeds).size !== seeds.length)
		fail('repetitions do not use distinct seeds');

	// Expected matrix over the explicit owners/candidates/repetitions.
	const expectedCells =
		options.expectedOwners.length *
		options.expectedCandidateIds.length *
		requiredReps;
	let passed = 0;
	const missing: string[] = [];
	for (const owner of options.expectedOwners) {
		for (const candidateId of options.expectedCandidateIds) {
			for (let rep = 0; rep < requiredReps; rep += 1) {
				const result = byKey.get(`${owner}|${candidateId}|${rep}`);
				if (!result) missing.push(`${owner}|${candidateId}|${rep}`);
				else if (result.outcome === 'passed') passed += 1;
			}
		}
	}
	const repetitions = seedByRep.size;

	const cells: CellEvidence[] = results.map((result) => ({
		owner: result.owner,
		candidateId: result.candidateId,
		repetition: result.repetition,
		dataSeed: result.dataSeed,
		outcome: result.outcome,
		correct: result.correct,
		metrics: cellMetrics(result),
	}));

	let status: EvidenceStatus;
	if (invalid) {
		status = 'invalid';
	} else if (
		repetitions < requiredReps ||
		missing.length > 0 ||
		passed < expectedCells
	) {
		status = 'incomplete';
		if (repetitions < requiredReps)
			reasons.push(`fewer than ${requiredReps} repetitions (${repetitions})`);
		if (missing.length > 0) reasons.push(`${missing.length} missing cell(s)`);
	} else {
		// Complete, all cells passed, at least the required repetitions, paired and
		// distinct seeds. Unsupported real workflows and qualifying runtimes remain,
		// so it stops at provisional; this instrument never emits ready-for-ADR-review.
		status = 'provisional';
		reasons.push(
			'complete passing matrix; unsupported real workflows and qualifying runtimes remain, so evidence stops at provisional (the ADR owns the layout choice)',
		);
	}

	return {
		status,
		qualifyingRuntime: false,
		reasons,
		expectedCells,
		passedCells: passed,
		repetitions,
		requiredRepetitions: requiredReps,
		unsupportedWorkflows: [...UNSUPPORTED_WORKFLOWS],
		unsupportedPlatforms: [...UNSUPPORTED_PLATFORMS],
		cells,
	};
}
