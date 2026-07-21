/**
 * Seed-level estimator reduction for the measurement-method pilot.
 *
 * Each persisted scalar keeps its config identity, outer seed, owner, candidate,
 * metric, metric family, and reduction statistic. Reads, reopens, macros, tails,
 * and storage are never pooled together. Persisted estimators are accepted only
 * when they exactly equal a fresh reduction of the retained raw observations.
 */

export const ESTIMATOR_FAMILIES = [
	'balanced-read-block',
	'balanced-reopen-series',
	'macro-total',
	'transaction-tail',
	'live-storage',
] as const;
export type EstimatorFamily = (typeof ESTIMATOR_FAMILIES)[number];

export const ESTIMATOR_STATISTICS = [
	'medianElapsedMs',
	'totalElapsedMs',
	'throughputPerSec',
	'p50Ms',
	'p95Ms',
	'p99Ms',
	'candidateTableBytes',
] as const;
export type EstimatorStatistic = (typeof ESTIMATOR_STATISTICS)[number];

export type SeedEstimator = {
	configIdentity: string;
	seedId: number;
	owner: string;
	candidate: string;
	metric: string;
	family: EstimatorFamily;
	statistic: EstimatorStatistic;
	value: number;
};

type EstimatorIdentityFields = {
	owner: string;
	candidate: string;
	metric: string;
	family: EstimatorFamily;
	statistic: EstimatorStatistic;
};

export type EstimatorRaw = {
	blocks: Array<{
		owner: string;
		candidate: string;
		metric: string;
		elapsedMs: number;
	}>;
	reopens: Array<{
		owner: string;
		candidate: string;
		elapsedMs: number;
	}>;
	tails: Array<{
		owner: string;
		candidate: string;
		metric: string;
		samplesMs: number[];
	}>;
	macros: Array<{
		owner: string;
		candidate: string;
		metric: string;
		units: number;
		elapsedMs: number;
	}>;
	cells: Array<{
		owner: string;
		candidate: string;
		candidateTableBytes: number;
	}>;
};

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
		: (sorted[mid] as number);
}

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

function identityOf(
	configIdentity: string,
	seedId: number,
	fields: EstimatorIdentityFields,
	value: number,
): SeedEstimator {
	return { configIdentity, seedId, ...fields, value };
}

/** Reduce every metric independently to its one seed-level scalar(s). */
export function buildSeedEstimators(
	raw: EstimatorRaw,
	configIdentity: string,
	seedId: number,
): SeedEstimator[] {
	const estimators: SeedEstimator[] = [];
	const readGroups = new Map<string, (typeof raw.blocks)[number][]>();
	for (const block of raw.blocks) {
		const key = `${block.owner}\u0000${block.candidate}\u0000${block.metric}`;
		const group = readGroups.get(key) ?? [];
		group.push(block);
		readGroups.set(key, group);
	}
	for (const group of readGroups.values()) {
		const first = group[0] as (typeof raw.blocks)[number];
		estimators.push(
			identityOf(
				configIdentity,
				seedId,
				{
					owner: first.owner,
					candidate: first.candidate,
					metric: first.metric,
					family: 'balanced-read-block',
					statistic: 'medianElapsedMs',
				},
				median(group.map((block) => block.elapsedMs)),
			),
		);
	}

	const reopenGroups = new Map<string, (typeof raw.reopens)[number][]>();
	for (const reopen of raw.reopens) {
		const key = `${reopen.owner}\u0000${reopen.candidate}`;
		const group = reopenGroups.get(key) ?? [];
		group.push(reopen);
		reopenGroups.set(key, group);
	}
	for (const group of reopenGroups.values()) {
		const first = group[0] as (typeof raw.reopens)[number];
		estimators.push(
			identityOf(
				configIdentity,
				seedId,
				{
					owner: first.owner,
					candidate: first.candidate,
					metric: 'warmReopen',
					family: 'balanced-reopen-series',
					statistic: 'medianElapsedMs',
				},
				median(group.map((reopen) => reopen.elapsedMs)),
			),
		);
	}

	for (const macro of raw.macros) {
		estimators.push(
			identityOf(
				configIdentity,
				seedId,
				{
					owner: macro.owner,
					candidate: macro.candidate,
					metric: macro.metric,
					family: 'macro-total',
					statistic: 'totalElapsedMs',
				},
				macro.elapsedMs,
			),
			identityOf(
				configIdentity,
				seedId,
				{
					owner: macro.owner,
					candidate: macro.candidate,
					metric: macro.metric,
					family: 'macro-total',
					statistic: 'throughputPerSec',
				},
				macro.elapsedMs > 0 ? (macro.units / macro.elapsedMs) * 1000 : 0,
			),
		);
	}

	for (const tail of raw.tails) {
		const totalMs = tail.samplesMs.reduce((sum, sample) => sum + sample, 0);
		const base = {
			owner: tail.owner,
			candidate: tail.candidate,
			metric: tail.metric,
			family: 'transaction-tail' as const,
		};
		for (const [statistic, value] of [
			['p50Ms', percentile(tail.samplesMs, 0.5)],
			['p95Ms', percentile(tail.samplesMs, 0.95)],
			['p99Ms', percentile(tail.samplesMs, 0.99)],
			[
				'throughputPerSec',
				totalMs > 0 ? (tail.samplesMs.length / totalMs) * 1000 : 0,
			],
		] as const) {
			estimators.push(
				identityOf(configIdentity, seedId, { ...base, statistic }, value),
			);
		}
	}

	for (const cell of raw.cells) {
		estimators.push(
			identityOf(
				configIdentity,
				seedId,
				{
					owner: cell.owner,
					candidate: cell.candidate,
					metric: 'candidateTableBytes',
					family: 'live-storage',
					statistic: 'candidateTableBytes',
				},
				cell.candidateTableBytes,
			),
		);
	}

	return estimators.sort((left, right) =>
		[left.owner, left.candidate, left.family, left.metric, left.statistic]
			.join('\u0000')
			.localeCompare(
				[
					right.owner,
					right.candidate,
					right.family,
					right.metric,
					right.statistic,
				].join('\u0000'),
			),
	);
}

/** Persisted estimators must be byte-for-byte equal to a fresh raw reduction. */
export function estimatorsMatchRaw(
	estimators: unknown,
	raw: EstimatorRaw,
	configIdentity: string,
	seedId: number,
): estimators is SeedEstimator[] {
	if (!Array.isArray(estimators)) return false;
	return (
		JSON.stringify(estimators) ===
		JSON.stringify(buildSeedEstimators(raw, configIdentity, seedId))
	);
}
