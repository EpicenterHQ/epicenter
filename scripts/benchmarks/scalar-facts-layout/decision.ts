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
import type { Owner, RunResult } from './runner.js';

export type EvidenceStatus =
	| 'invalid'
	| 'incomplete'
	| 'provisional'
	| 'ready-for-ADR-review';

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

export type ClassifyOptions = {
	profile: 'smoke' | 'full';
	expectedOwners: readonly Owner[];
	expectedCandidateIds: readonly string[];
	/** Five for full evidence. */
	requiredRepetitions: number;
};

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

		if (result.outcome === 'failed')
			fail(`failed cell ${key}: ${result.reason}`);
		if (result.integrityCheck !== 'ok')
			fail(`integrity_check ${result.integrityCheck} in ${key}`);
		if (!result.planProof.ok) fail(`query plan proof failed in ${key}`);
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

		// Storage: every byte/count field a finite non-negative integer.
		for (const [field, value] of Object.entries(result.storage)) {
			if (!isFiniteNonNegInt(value))
				fail(`non-finite storage ${field} in ${key}`);
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
