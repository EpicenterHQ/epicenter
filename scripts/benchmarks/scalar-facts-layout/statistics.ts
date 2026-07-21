/**
 * Deterministic seed-level familywise inference for the layout pilot.
 *
 * This module is the "declared estimator." The prior provisional run's latency
 * comparison was degenerate: p95 values were maxima of only sixteen within-run
 * samples, warm reopen had a single observation, candidate position was
 * unbalanced, and micro-calls were timed one at a time. Two independent reviews
 * refused that latency result. The fix is not more outer repetitions over a
 * biased within-run estimator; it is to reduce each metric to ONE seed-level
 * estimator per candidate and to make the whole outer seed the only resampling
 * unit.
 *
 * The input type enforces that. `SeedLevelMetric.estimates` is indexed
 * `[seedIndex][candidateIndex]` and holds one already-reduced scalar per
 * candidate per seed. There is no block, reopen, or transaction axis to reach,
 * so this module structurally cannot bootstrap below the seed. The runner reduces
 * a complete balanced Williams design, a balanced reopen series, throughput
 * totals, and a transaction-tail summary to those scalars before calling here.
 *
 * Inference is a deterministic studentized paired bootstrap over whole seeds
 * (ADR/spec: 10,000 draws), producing 95% familywise simultaneous max-t
 * intervals across the whole owner metric-and-storage contrast family, then
 * classifying each contrast against fixed log-ratio equivalence margins. Same
 * inputs and bootstrap seed yield byte-identical intervals, draws, and
 * classifications.
 */

/** Lower is better for both; the margins and directions differ only in size. */
export type MetricKind = 'latency' | 'storage';

/** Fixed log-ratio equivalence margins (spec): 1.10 latency, 1.05 storage. */
export const LATENCY_LOG_MARGIN = Math.log(1.1);
export const STORAGE_LOG_MARGIN = Math.log(1.05);

export function marginFor(kind: MetricKind): number {
	return kind === 'latency' ? LATENCY_LOG_MARGIN : STORAGE_LOG_MARGIN;
}

export type SeedLevelMetric = {
	/** Stable metric key, e.g. `confirmedPointRead` or `liveStorageBytes`. */
	key: string;
	kind: MetricKind;
	/**
	 * One seed-level scalar per candidate: `estimates[seedIndex][candidateIndex]`.
	 * Already reduced (median read-block time, total throughput, live bytes, ...);
	 * this module never sees a block, reopen, or transaction.
	 */
	estimates: number[][];
};

/**
 * The minimum fresh, unique seeds a pilot may reduce. With four seeds an
 * all-one-seed bootstrap resample (the only way every shared-pick member goes
 * degenerate) is `(1/4)^3 ~= 1.6%` of draws, well under the 5% the 95th
 * percentile excludes, so the conservative zero-SE policy below cannot collapse
 * the critical value. Two seeds make half the resamples degenerate and produce a
 * false `criticalValue = 0`; the spec's final run declares its own larger count.
 */
export const MIN_PILOT_SEEDS = 4;

export type FamilyInput = {
	/** Candidate ids, length C >= 2, indexing the inner estimate arrays. */
	candidates: string[];
	/** Outer-unit seed ids, length N; the only resampling unit. Must be unique. */
	seedIds: number[];
	/** Metrics, each `estimates` an N-by-C matrix aligned to seedIds/candidates. */
	metrics: SeedLevelMetric[];
	/** Deterministic bootstrap draw count (spec: 10,000). */
	bootstrapDraws: number;
	/** Deterministic bootstrap PRNG seed. */
	bootstrapSeed: number;
	/** Declared minimum seed count; defaults to `MIN_PILOT_SEEDS`. */
	minSeeds?: number;
};

export type Classification =
	| 'equivalent'
	| 'left-better'
	| 'right-better'
	| 'left-non-regressing'
	| 'right-non-regressing'
	| 'inconclusive';

export type Contrast = {
	metricKey: string;
	kind: MetricKind;
	/** `log(left / right)`; both candidate ids named so direction is unambiguous. */
	left: string;
	right: string;
	seeds: number;
	/** Mean paired seed-level log ratio, the contrast point estimate. */
	pointLogRatio: number;
	/** Standard error of the paired log ratio over whole seeds. */
	standardError: number;
	/** Familywise simultaneous max-t interval on `log(left/right)`. */
	interval: { lower: number; upper: number };
	/** Simultaneous half-width `criticalValue * standardError`. */
	halfWidth: number;
	classification: Classification;
};

export type FeasibilityByKind = {
	kind: MetricKind;
	/** Largest simultaneous half-width across this kind's contrasts. */
	maxHalfWidth: number;
	/** Target half-width `margin / 2` (spec 550-557). */
	targetHalfWidth: number;
	/** True when every contrast of this kind is at or under the target. */
	withinTarget: boolean;
	/**
	 * Seeds this kind would need to reach the target, projecting the standard error
	 * as `1/sqrt(n)` at the observed critical value. `null` when already within
	 * target or not projectable.
	 */
	projectedSeeds: number | null;
};

export type FamilywiseResult = {
	/** False when any structural refusal fired; `contrasts` is then empty. */
	ok: boolean;
	/** Human-readable structural refusal reasons, empty when `ok`. */
	refusals: string[];
	bootstrapDraws: number;
	/** The 0.95 quantile of the bootstrap max-|t| distribution. */
	criticalValue: number;
	contrasts: Contrast[];
	feasibility: FeasibilityByKind[];
};

/** A deterministic 32-bit PRNG (mulberry32); uniform draws depend only on `seed`. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

function mean(values: number[]): number {
	let sum = 0;
	for (const v of values) sum += v;
	return sum / values.length;
}

/** Sample standard error of the mean (ddof = 1). Zero when n < 2 or no spread. */
function standardErrorOfMean(values: number[]): number {
	const n = values.length;
	if (n < 2) return 0;
	const m = mean(values);
	let ss = 0;
	for (const v of values) ss += (v - m) * (v - m);
	return Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
}

/** Nearest-rank upper quantile of a copy-sorted array. */
function upperQuantile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return Number.POSITIVE_INFINITY;
	const rank = Math.ceil(fraction * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index] ?? Number.POSITIVE_INFINITY;
}

/** All unordered candidate pairs `(i, j)` with `i < j`, as index pairs. */
function candidatePairs(count: number): Array<[number, number]> {
	const pairs: Array<[number, number]> = [];
	for (let i = 0; i < count; i += 1) {
		for (let j = i + 1; j < count; j += 1) pairs.push([i, j]);
	}
	return pairs;
}

type Member = {
	metric: SeedLevelMetric;
	leftIndex: number;
	rightIndex: number;
	/** Paired seed-level log ratios `log(left/right)`, one per seed. */
	diffs: number[];
	point: number;
	se: number;
};

/**
 * Classify a simultaneous interval on `log(left/right)` against a symmetric
 * margin, following the spec exactly: equivalence needs the whole interval inside
 * `[-margin, +margin]`; a direction is non-regressing only when its upper bound is
 * within the positive margin and materially better only when its upper bound is
 * below the negative margin; anything that straddles beyond both margins is
 * inconclusive.
 */
export function classify(
	interval: { lower: number; upper: number },
	margin: number,
): Classification {
	const { lower, upper } = interval;
	if (!Number.isFinite(lower) || !Number.isFinite(upper)) return 'inconclusive';
	if (upper <= margin) {
		if (upper < -margin) return 'left-better';
		if (lower >= -margin) return 'equivalent';
		return 'left-non-regressing';
	}
	// upper > margin
	if (lower > margin) return 'right-better';
	if (lower >= -margin) return 'right-non-regressing';
	return 'inconclusive';
}

/**
 * Structural refusals that make inference impossible or dishonest. Any one of
 * these returns `ok: false` with no contrasts, so a caller can never read a
 * classification off a degenerate family.
 */
function structuralRefusals(input: FamilyInput): string[] {
	const refusals: string[] = [];
	const n = input.seedIds.length;
	const c = input.candidates.length;
	const minSeeds = input.minSeeds ?? MIN_PILOT_SEEDS;
	if (c < 2) refusals.push('fewer than two candidates');
	if (n < minSeeds) {
		refusals.push(
			`fewer than ${minSeeds} whole seeds; the paired bootstrap collapses to false certainty below the declared minimum`,
		);
	}
	if (new Set(input.seedIds).size !== n) {
		refusals.push(
			'duplicate seed ids; the outer units must be fresh and unique',
		);
	}
	if (input.bootstrapDraws < 1)
		refusals.push('non-positive bootstrap draw count');
	for (const metric of input.metrics) {
		if (metric.estimates.length !== n) {
			refusals.push(`metric ${metric.key} has a seed-count mismatch`);
			continue;
		}
		for (let s = 0; s < n; s += 1) {
			const row = metric.estimates[s];
			if (row === undefined || row.length !== c) {
				refusals.push(
					`metric ${metric.key} seed ${s} has a candidate-count mismatch`,
				);
				break;
			}
			for (const value of row) {
				if (!Number.isFinite(value) || value <= 0) {
					refusals.push(
						`metric ${metric.key} has a non-positive or non-finite seed-level estimate; a log ratio is undefined`,
					);
					break;
				}
			}
		}
	}
	return refusals;
}

export function computeFamilywise(input: FamilyInput): FamilywiseResult {
	const refusals = structuralRefusals(input);
	if (refusals.length > 0) {
		return {
			ok: false,
			refusals,
			bootstrapDraws: input.bootstrapDraws,
			criticalValue: Number.POSITIVE_INFINITY,
			contrasts: [],
			feasibility: [],
		};
	}

	const n = input.seedIds.length;
	const pairs = candidatePairs(input.candidates.length);
	const members: Member[] = [];
	for (const metric of input.metrics) {
		for (const [i, j] of pairs) {
			const diffs: number[] = [];
			for (let s = 0; s < n; s += 1) {
				const row = metric.estimates[s] as number[];
				diffs.push(Math.log(row[i] as number) - Math.log(row[j] as number));
			}
			members.push({
				metric,
				leftIndex: i,
				rightIndex: j,
				diffs,
				point: mean(diffs),
				se: standardErrorOfMean(diffs),
			});
		}
	}

	// A degenerate standard error makes the studentized statistic undefined for
	// that contrast. Refuse rather than invent zero-width certainty.
	const degenerate = members.filter((m) => m.se === 0);
	if (degenerate.length > 0) {
		const keys = [...new Set(degenerate.map((m) => m.metric.key))];
		return {
			ok: false,
			refusals: [
				`zero seed-level spread on contrast(s) for ${keys.join(', ')}; the studentized estimator is degenerate at this sample size`,
			],
			bootstrapDraws: input.bootstrapDraws,
			criticalValue: Number.POSITIVE_INFINITY,
			contrasts: [],
			feasibility: [],
		};
	}

	// Deterministic studentized paired bootstrap over WHOLE seeds. Each draw picks
	// one resampled seed-index set shared by every family member, so the pairing
	// across metrics and candidate pairs within a seed is preserved and no block,
	// reopen, or transaction is ever resampled.
	const random = mulberry32(input.bootstrapSeed);
	const maxStats: number[] = new Array(input.bootstrapDraws);
	const pick = new Array<number>(n);
	for (let b = 0; b < input.bootstrapDraws; b += 1) {
		for (let s = 0; s < n; s += 1) pick[s] = Math.floor(random() * n) % n;
		let maxAbsT = 0;
		for (const member of members) {
			let sum = 0;
			for (let s = 0; s < n; s += 1)
				sum += member.diffs[pick[s] as number] as number;
			const bMean = sum / n;
			let ss = 0;
			for (let s = 0; s < n; s += 1) {
				const d = (member.diffs[pick[s] as number] as number) - bMean;
				ss += d * d;
			}
			const bSe = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
			// Predeclared conservative policy: a resample with zero standard error
			// yields no usable studentized statistic, so it contributes +infinity to
			// the max-|t| distribution rather than a false 0. A degenerate resample can
			// therefore only WIDEN the interval (or, if such resamples exceed 5%, push
			// the 95th-percentile critical value to infinity and refuse to classify),
			// never manufacture certainty. With >= MIN_PILOT_SEEDS unique seeds these
			// resamples stay a small tail the 95th percentile excludes.
			const absT =
				bSe > 0
					? Math.abs((bMean - member.point) / bSe)
					: Number.POSITIVE_INFINITY;
			if (absT > maxAbsT) maxAbsT = absT;
		}
		maxStats[b] = maxAbsT;
	}
	const criticalValue = upperQuantile(
		[...maxStats].sort((a, b) => a - b),
		0.95,
	);

	const contrasts: Contrast[] = members.map((member) => {
		const halfWidth = criticalValue * member.se;
		const interval = {
			lower: member.point - halfWidth,
			upper: member.point + halfWidth,
		};
		return {
			metricKey: member.metric.key,
			kind: member.metric.kind,
			left: input.candidates[member.leftIndex] as string,
			right: input.candidates[member.rightIndex] as string,
			seeds: n,
			pointLogRatio: member.point,
			standardError: member.se,
			interval,
			halfWidth,
			classification: classify(interval, marginFor(member.metric.kind)),
		};
	});

	const feasibility: FeasibilityByKind[] = (['latency', 'storage'] as const)
		.filter((kind) => contrasts.some((c) => c.kind === kind))
		.map((kind) => {
			const ofKind = contrasts.filter((c) => c.kind === kind);
			const maxHalfWidth = Math.max(...ofKind.map((c) => c.halfWidth));
			const targetHalfWidth = marginFor(kind) / 2;
			const withinTarget = maxHalfWidth <= targetHalfWidth;
			// half-width scales as 1/sqrt(n); required n ~ n * (observed/target)^2.
			const projectedSeeds =
				withinTarget || targetHalfWidth <= 0
					? null
					: Math.ceil(n * (maxHalfWidth / targetHalfWidth) ** 2);
			return {
				kind,
				maxHalfWidth,
				targetHalfWidth,
				withinTarget,
				projectedSeeds,
			};
		});

	return {
		ok: true,
		refusals: [],
		bootstrapDraws: input.bootstrapDraws,
		criticalValue,
		contrasts,
		feasibility,
	};
}
