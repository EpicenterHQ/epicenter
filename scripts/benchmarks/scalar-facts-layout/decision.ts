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
 * The classifier fails closed. It returns `invalid` on any duplicate or failed
 * cell, an empty query plan, a seed that is inconsistent within a repetition or
 * not distinct across repetitions, or a globally required metric missing;
 * `incomplete` when the expected owner x candidate x repetition matrix (five
 * repetitions) is not fully populated and correct; and `provisional` when it is,
 * because unsupported real workflows and qualifying runtimes still remain. This
 * Bun instrument can never emit `ready-for-ADR-review`: that status is reserved
 * for a future harness that closes those gaps.
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
	correct: boolean;
	/** Median of raw samples per timing metric, plus the two page measures. Unranked. */
	metrics: Record<string, number>;
};

export type EvidenceReport = {
	status: EvidenceStatus;
	provisional: true;
	reasons: string[];
	expectedCells: number;
	presentCorrectCells: number;
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

	// Index cells; reject duplicates, failed cells, empty plans, missing required metrics.
	const byKey = new Map<string, RunResult>();
	for (const result of results) {
		const key = `${result.owner}|${result.candidateId}|${result.repetition}`;
		if (byKey.has(key)) fail(`duplicate cell ${key}`);
		byKey.set(key, result);
		if (!result.correct) fail(`failed cell ${key}: ${result.reason}`);
		if (
			!result.plans.feed ||
			!result.plans.rowPoint ||
			!result.plans.valuePoint ||
			!result.plans.traverse
		) {
			fail(`empty query plan in ${key}`);
		}
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
	const requiredReps = options.requiredRepetitions;
	const expectedCells =
		options.expectedOwners.length *
		options.expectedCandidateIds.length *
		requiredReps;
	let presentCorrect = 0;
	const missing: string[] = [];
	for (const owner of options.expectedOwners) {
		for (const candidateId of options.expectedCandidateIds) {
			for (let rep = 0; rep < requiredReps; rep += 1) {
				const result = byKey.get(`${owner}|${candidateId}|${rep}`);
				if (result?.correct) presentCorrect += 1;
				else if (!result) missing.push(`${owner}|${candidateId}|${rep}`);
			}
		}
	}
	const repetitions = seedByRep.size;

	const cells: CellEvidence[] = results.map((result) => ({
		owner: result.owner,
		candidateId: result.candidateId,
		repetition: result.repetition,
		dataSeed: result.dataSeed,
		correct: result.correct,
		metrics: cellMetrics(result),
	}));

	let status: EvidenceStatus;
	if (invalid) {
		status = 'invalid';
	} else if (
		repetitions < requiredReps ||
		missing.length > 0 ||
		presentCorrect < expectedCells
	) {
		status = 'incomplete';
		if (repetitions < requiredReps)
			reasons.push(`fewer than ${requiredReps} repetitions (${repetitions})`);
		if (missing.length > 0) reasons.push(`${missing.length} missing cell(s)`);
	} else {
		// Complete, correct, five reps, paired-and-distinct seeds. Unsupported real
		// workflows and qualifying runtimes remain, so it stops at provisional. This
		// instrument never emits ready-for-ADR-review by design.
		status = 'provisional';
		reasons.push(
			'complete correct matrix; unsupported real workflows and qualifying runtimes remain, so evidence stops at provisional (the ADR owns the layout choice)',
		);
	}

	return {
		status,
		provisional: true,
		reasons,
		expectedCells,
		presentCorrectCells: presentCorrect,
		repetitions,
		requiredRepetitions: requiredReps,
		unsupportedWorkflows: [...UNSUPPORTED_WORKFLOWS],
		unsupportedPlatforms: [...UNSUPPORTED_PLATFORMS],
		cells,
	};
}
