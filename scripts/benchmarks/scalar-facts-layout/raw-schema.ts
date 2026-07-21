/**
 * Closed schema and completeness validation for one seed's raw pilot observations.
 *
 * A resumed or reloaded seed must be structurally identical to a fresh one, so
 * "arrays of unknown plus a finite scan" is not enough. This module validates
 * every observation against a CLOSED shape (exact keys, no extras, correct types,
 * enum membership, finite numbers, id shapes) and then validates whole-seed
 * completeness against EXACT per-seed expectations: every read block is compared
 * in order against the schedule derived from the single schedule owner (ordinal,
 * cycle, position, letter, mapped candidate, sequence label, predecessor, boundary
 * marker), build ids are bound to seed+owner+candidate, the reopen rotation and
 * boundary records are pinned, and the eight-database lifecycle is enforced. A
 * forged group swap or predecessor rewrite that would pass a membership or
 * permutation check is refused. It is pure: no SQLite, no wall clock.
 */

import type { ScheduledBlock } from './schedule.js';

export const RAW_OWNERS = ['replica', 'authority'] as const;
export type RawOwner = (typeof RAW_OWNERS)[number];

export const RAW_CANDIDATE_IDS = [
	'unified-inline',
	'unified-normalized',
	'split-inline',
	'split-normalized',
] as const;

export const RAW_READ_METRICS: Record<RawOwner, readonly string[]> = {
	replica: [
		'confirmedPointRead',
		'confirmedTraversal',
		'confirmedPendingOverlayRead',
	],
	authority: ['orderedResumeFeed', 'foldPointRead', 'exactRetrySettlementRead'],
};
export const RAW_TAIL_METRICS: Record<RawOwner, readonly string[]> = {
	replica: ['monotonicInstallTail', 'rowTombstoneDocumentCleanupTail'],
	authority: ['submissionSettlementTail'],
};
export const RAW_MACRO_METRIC: Record<RawOwner, string> = {
	replica: 'acquisitionInstall',
	authority: 'orderedFreshFeed',
};
export const RAW_BOUNDARY_KINDS = ['pair', 'cycle'] as const;
export const RAW_LETTERS = ['A', 'B', 'C', 'D'] as const;

type FieldCheck = (value: unknown) => boolean;
const isFiniteNumber: FieldCheck = (v) =>
	typeof v === 'number' && Number.isFinite(v);
const isString: FieldCheck = (v) => typeof v === 'string';
const isBoolean: FieldCheck = (v) => typeof v === 'boolean';
const isStringOrNull: FieldCheck = (v) => v === null || typeof v === 'string';
const isFiniteArray: FieldCheck = (v) =>
	Array.isArray(v) &&
	v.every((x) => typeof x === 'number' && Number.isFinite(x));
const isThreeFiniteTuple: FieldCheck = (v) =>
	Array.isArray(v) &&
	v.length === 3 &&
	v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Validate a value is a plain object with EXACTLY the given keys, each matching. */
function isClosed(value: unknown, spec: Record<string, FieldCheck>): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value as Record<string, unknown>);
	const expected = Object.keys(spec);
	if (keys.length !== expected.length) return false; // no missing or extra keys
	for (const key of expected) {
		if (!Object.hasOwn(value as object, key)) return false;
		if (!spec[key]?.((value as Record<string, unknown>)[key])) return false;
	}
	return true;
}

const ownerCheck: FieldCheck = (v) =>
	(RAW_OWNERS as readonly string[]).includes(v as string);
const candidateCheck: FieldCheck = (v) =>
	(RAW_CANDIDATE_IDS as readonly string[]).includes(v as string);
const boundaryEnumCheck: FieldCheck = (v) =>
	v === 'start' || v === 'none' || v === 'pair' || v === 'cycle';
const letterCheck: FieldCheck = (v) =>
	(RAW_LETTERS as readonly string[]).includes(v as string);

export function isValidBlock(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		buildId: isString,
		cycle: isFiniteNumber,
		ordinal: isFiniteNumber,
		position: isFiniteNumber,
		letter: letterCheck,
		sequenceLabel: isString,
		predecessor: isStringOrNull,
		boundary: boundaryEnumCheck,
		ops: isFiniteNumber,
		warmupMs: isThreeFiniteTuple,
		elapsedMs: isFiniteNumber,
	});
}
export function isValidBoundary(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		kind: (x) =>
			(RAW_BOUNDARY_KINDS as readonly string[]).includes(x as string),
		atOrdinal: isFiniteNumber,
		idleMs: isFiniteNumber,
		reopenMs: isFiniteNumber,
		reopenedCandidates: isFiniteNumber,
		reopenOk: isBoolean,
	});
}
export function isValidReopen(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		candidate: candidateCheck,
		buildId: isString,
		index: isFiniteNumber,
		orderPosition: isFiniteNumber,
		elapsedMs: isFiniteNumber,
		witnessDigest: isString,
		witnessMatchesOracle: isBoolean,
	});
}
export function isValidTail(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		transactions: isFiniteNumber,
		samplesMs: isFiniteArray,
		p50Ms: isFiniteNumber,
		p95Ms: isFiniteNumber,
		p99Ms: isFiniteNumber,
		throughputPerSec: isFiniteNumber,
		resetVerified: isBoolean,
		warmupTransactions: isFiniteNumber,
		walDeltaDiagnostic: isFiniteNumber,
		checkpointSignalTruthful: isBoolean,
	});
}
export function isValidMacro(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		elapsedMs: isFiniteNumber,
		throughputPerSec: isFiniteNumber,
	});
}
export function isValidCell(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		candidate: candidateCheck,
		buildId: isString,
		oracleReproduced: isBoolean,
		integrityOk: isBoolean,
		candidateTableBytes: isFiniteNumber,
		fileBytes: isFiniteNumber,
	});
}

export type SeedRawValidation = { valid: boolean; reason?: string };

/** Validate the closed shape of every observation and the seed-level fields. */
export function validateSeedRawClosed(raw: unknown): SeedRawValidation {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { valid: false, reason: 'raw is not an object' };
	}
	const r = raw as Record<string, unknown>;
	const expectedKeys = [
		'letterMapping',
		'lifecycle',
		'blocks',
		'boundaries',
		'reopens',
		'tails',
		'macros',
		'cells',
	];
	if (Object.keys(r).length !== expectedKeys.length) {
		return { valid: false, reason: 'raw has missing or extra top-level keys' };
	}
	for (const key of expectedKeys) {
		if (!Object.hasOwn(r, key))
			return { valid: false, reason: `raw missing ${key}` };
	}
	if (
		!isClosed(r.lifecycle, {
			peakRetained: isFiniteNumber,
			liveAtCommit: isFiniteNumber,
			retainedThroughCommit: isBoolean,
		})
	) {
		return { valid: false, reason: 'lifecycle shape invalid' };
	}
	// letterMapping is CLOSED to exactly the four letters (no extra keys) with a
	// string value each; bijection onto the candidate set is checked in completeness.
	if (
		typeof r.letterMapping !== 'object' ||
		r.letterMapping === null ||
		Array.isArray(r.letterMapping)
	) {
		return { valid: false, reason: 'letterMapping is not an object' };
	}
	const letterKeys = Object.keys(r.letterMapping as Record<string, unknown>);
	if (
		letterKeys.length !== RAW_LETTERS.length ||
		!RAW_LETTERS.every(
			(l) =>
				typeof (r.letterMapping as Record<string, unknown>)[l] === 'string',
		)
	) {
		return { valid: false, reason: 'letterMapping has wrong or extra keys' };
	}
	const arrays: [string, FieldCheck][] = [
		['blocks', isValidBlock],
		['boundaries', isValidBoundary],
		['reopens', isValidReopen],
		['tails', isValidTail],
		['macros', isValidMacro],
		['cells', isValidCell],
	];
	for (const [key, check] of arrays) {
		const value = r[key];
		if (!Array.isArray(value))
			return { valid: false, reason: `${key} is not an array` };
		for (let i = 0; i < value.length; i += 1) {
			if (!check(value[i])) {
				return {
					valid: false,
					reason: `${key}[${i}] failed closed validation`,
				};
			}
		}
	}
	return { valid: true };
}

export type CompletenessExpectations = {
	owners: readonly string[];
	candidates: readonly string[];
	reopenObservations: number;
	minTailTransactions: number;
	/** This seed's index in the config seed list, which fixes the build-id prefix. */
	seedIndex: number;
	/**
	 * The EXACT expected ordered schedule for this seed, derived from the single
	 * schedule owner (`buildSeedSchedule`) and truncated to the read-block cap. Block
	 * identities are compared against this in order, so a forged group swap or
	 * predecessor rewrite cannot pass a mere membership or permutation check.
	 */
	schedule: readonly ScheduledBlock[];
	/** The schedule owner's letter-to-candidate mapping for this seed. */
	letterMapping: Record<string, string>;
};

export type SeedCompleteness = { complete: boolean; reasons: string[] };

/**
 * Validate whole-seed completeness against the exact per-seed expectations. Beyond
 * exact counts and unique identities (macros, cells, reopens, tails), every read
 * block is compared IN ORDER against the expected schedule derived from the single
 * schedule owner: ordinal, cycle, position, letter, mapped candidate, sequence
 * label, predecessor, and boundary marker must all match, and the build id must be
 * `s<seedIndex>/<owner>/<candidate>` (bound to seed as well as owner and
 * candidate). letterMapping must equal the owner's mapping; the balanced reopen
 * rotation must hold; and boundary records must correspond exactly to the blocks
 * marked pair/cycle. Malformed committed and resumed seeds are rejected identically.
 */
export function validateSeedCompleteness(
	raw: unknown,
	exp: CompletenessExpectations,
): SeedCompleteness {
	const reasons: string[] = [];
	const closed = validateSeedRawClosed(raw);
	if (!closed.valid)
		return { complete: false, reasons: [closed.reason ?? 'invalid'] };
	const r = raw as {
		lifecycle: {
			peakRetained: number;
			liveAtCommit: number;
			retainedThroughCommit: boolean;
		};
		letterMapping: Record<string, string>;
		blocks: {
			owner: string;
			metric: string;
			candidate: string;
			buildId: string;
			cycle: number;
			ordinal: number;
			position: number;
			letter: string;
			sequenceLabel: string;
			predecessor: string | null;
			boundary: string;
			warmupMs: number[];
		}[];
		boundaries: {
			owner: string;
			metric: string;
			kind: string;
			atOrdinal: number;
			reopenedCandidates: number;
		}[];
		reopens: {
			owner: string;
			candidate: string;
			buildId: string;
			index: number;
			orderPosition: number;
		}[];
		tails: {
			owner: string;
			metric: string;
			candidate: string;
			samplesMs: number[];
		}[];
		macros: { owner: string; metric: string; candidate: string }[];
		cells: { owner: string; candidate: string; buildId: string }[];
	};

	const owners = exp.owners;
	const candidates = exp.candidates;
	const candidateSet = new Set(candidates);
	const cellCount = owners.length * candidates.length;

	// Lifecycle: all eight databases retained, live, and still retained THROUGH the
	// durable commit write (deletion happens strictly after, so the durable record
	// must witness them retained).
	if (r.lifecycle.peakRetained !== cellCount)
		reasons.push(`peakRetained ${r.lifecycle.peakRetained} != ${cellCount}`);
	if (r.lifecycle.liveAtCommit !== cellCount)
		reasons.push(`liveAtCommit ${r.lifecycle.liveAtCommit} != ${cellCount}`);
	if (r.lifecycle.retainedThroughCommit !== true)
		reasons.push('retainedThroughCommit is not true');

	// letterMapping must EQUAL the schedule owner's mapping for this seed (exact),
	// which also makes it the same bijection onto the candidate set.
	for (const letter of RAW_LETTERS) {
		if (r.letterMapping[letter] !== exp.letterMapping[letter])
			reasons.push(
				`letterMapping[${letter}] does not match the schedule owner`,
			);
	}

	// Build identity is bound to seed, owner, AND candidate. A wrong-seed prefix or a
	// swapped owner/candidate is rejected wherever the id appears.
	const expectedBuildId = (owner: string, candidate: string) =>
		`s${exp.seedIndex}/${owner}/${candidate}`;

	// Macros: exactly one per owner+candidate, each with the owner's macro metric.
	const macroKeys = r.macros.map((m) => `${m.owner}/${m.candidate}`);
	if (new Set(macroKeys).size !== macroKeys.length)
		reasons.push('duplicate macro');
	if (macroKeys.length !== cellCount)
		reasons.push(`macro count ${macroKeys.length} != ${cellCount}`);
	for (const m of r.macros) {
		if (!candidateSet.has(m.candidate)) reasons.push('macro unknown candidate');
		if (m.metric !== RAW_MACRO_METRIC[m.owner as RawOwner])
			reasons.push(`macro metric mismatch for ${m.owner}`);
	}

	// Cells: exactly one per owner+candidate, with the exact seed-bound build id.
	const cellKeys = r.cells.map((c) => `${c.owner}/${c.candidate}`);
	if (new Set(cellKeys).size !== cellKeys.length)
		reasons.push('duplicate cell');
	if (cellKeys.length !== cellCount)
		reasons.push(`cell count ${cellKeys.length} != ${cellCount}`);
	for (const c of r.cells) {
		if (c.buildId !== expectedBuildId(c.owner, c.candidate))
			reasons.push(`cell buildId for ${c.owner}/${c.candidate} != expected`);
	}

	// Reopens: per owner+candidate the index set must be EXACTLY {0..N-1} (not merely
	// unique, so a uniform +N shift that keeps the mod-L rotation is still refused),
	// every order position in range, the seed-bound build id, and the balanced
	// rotation relationship candidate = candidates[(orderPosition + index) mod L].
	const candidateCount = candidates.length;
	for (const owner of owners) {
		for (const candidate of candidates) {
			const cellReopens = r.reopens.filter(
				(x) => x.owner === owner && x.candidate === candidate,
			);
			if (cellReopens.length !== exp.reopenObservations) {
				reasons.push(
					`reopens for ${owner}/${candidate} = ${cellReopens.length} != ${exp.reopenObservations}`,
				);
			}
			const indices = cellReopens.map((x) => x.index).sort((a, b) => a - b);
			const exactIndexSet =
				indices.length === exp.reopenObservations &&
				indices.every((v, i) => v === i);
			if (!exactIndexSet)
				reasons.push(
					`reopen index set for ${owner}/${candidate} is not 0..${exp.reopenObservations - 1}`,
				);
		}
	}
	for (const x of r.reopens) {
		if (x.orderPosition < 0 || x.orderPosition >= candidateCount) {
			reasons.push(`reopen orderPosition out of range for ${x.owner}`);
			continue;
		}
		const rotated =
			candidates[
				(x.orderPosition + (x.index % candidateCount)) % candidateCount
			];
		if (x.candidate !== rotated)
			reasons.push(
				`reopen (index ${x.index}, pos ${x.orderPosition}) breaks the balanced rotation`,
			);
		if (x.buildId !== expectedBuildId(x.owner, x.candidate))
			reasons.push(`reopen buildId for ${x.owner}/${x.candidate} != expected`);
	}

	// No block may carry an owner or read metric outside the frozen expectation
	// (this alone rejects invented metrics even when every expected group is full).
	for (const b of r.blocks) {
		const validMetric = (
			RAW_READ_METRICS[b.owner as RawOwner] as readonly string[] | undefined
		)?.includes(b.metric);
		if (!validMetric)
			reasons.push(
				`block carries unexpected owner/metric ${b.owner}/${b.metric}`,
			);
	}

	// Blocks: for each owner+readMetric, exactly the expected count, and every block
	// compared IN ORDER against the exact expected schedule (ordinal, cycle,
	// position, letter, mapped candidate, sequence label, predecessor, boundary
	// marker) plus its seed-bound build id and three positive warmups. This defeats a
	// forged group swap or predecessor rewrite that a membership/permutation check
	// would miss.
	const expectedByOrdinal = new Map(exp.schedule.map((e) => [e.ordinal, e]));
	const perMetricTotal = exp.schedule.length;
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			const metricBlocks = r.blocks.filter(
				(b) => b.owner === owner && b.metric === metric,
			);
			if (metricBlocks.length !== perMetricTotal) {
				reasons.push(
					`blocks for ${owner}/${metric} = ${metricBlocks.length} != ${perMetricTotal}`,
				);
			}
			const byOrdinal = new Map<number, (typeof metricBlocks)[number]>();
			for (const b of metricBlocks) {
				if (byOrdinal.has(b.ordinal))
					reasons.push(`duplicate ordinal ${b.ordinal} in ${owner}/${metric}`);
				byOrdinal.set(b.ordinal, b);
				if (!expectedByOrdinal.has(b.ordinal))
					reasons.push(
						`block ${owner}/${metric}#${b.ordinal} is outside the expected schedule`,
					);
			}
			for (const e of exp.schedule) {
				const b = byOrdinal.get(e.ordinal);
				if (b === undefined) {
					reasons.push(`missing block ${owner}/${metric}#${e.ordinal}`);
					continue;
				}
				const label = e.sequence.join('');
				if (
					b.cycle !== e.cycle ||
					b.position !== e.positionInSequence ||
					b.letter !== e.letter ||
					b.candidate !== e.candidate ||
					b.sequenceLabel !== label ||
					b.predecessor !== e.predecessor ||
					b.boundary !== e.precedingBoundary
				) {
					reasons.push(
						`block ${owner}/${metric}#${e.ordinal} does not match the expected schedule`,
					);
				}
				if (b.buildId !== expectedBuildId(owner, e.candidate))
					reasons.push(
						`block ${owner}/${metric}#${e.ordinal} buildId != expected`,
					);
				if (b.warmupMs.length !== 3 || !b.warmupMs.every((w) => w > 0))
					reasons.push(
						`block ${owner}/${metric}#${e.ordinal} lacks three positive warmups`,
					);
			}
		}
	}

	// Boundaries: no unexpected owner/metric; every reopen touches all candidates;
	// and the boundary records for each owner+metric correspond EXACTLY (by ordinal
	// and kind) to that group's blocks marked pair/cycle. Derived from the blocks,
	// this rejects zero-boundary seeds because valid blocks carry real markers.
	for (const bd of r.boundaries) {
		const validMetric = (
			RAW_READ_METRICS[bd.owner as RawOwner] as readonly string[] | undefined
		)?.includes(bd.metric);
		if (!validMetric)
			reasons.push(`boundary unexpected owner/metric ${bd.owner}/${bd.metric}`);
		if (bd.reopenedCandidates !== candidates.length)
			reasons.push(
				`boundary reopenedCandidates ${bd.reopenedCandidates} != ${candidates.length}`,
			);
	}
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			const expected = r.blocks
				.filter(
					(b) =>
						b.owner === owner &&
						b.metric === metric &&
						(b.boundary === 'pair' || b.boundary === 'cycle'),
				)
				.map((b) => `${b.ordinal}/${b.boundary}`)
				.sort();
			const actual = r.boundaries
				.filter((bd) => bd.owner === owner && bd.metric === metric)
				.map((bd) => `${bd.atOrdinal}/${bd.kind}`)
				.sort();
			if (
				expected.length !== actual.length ||
				expected.some((e, i) => e !== actual[i])
			) {
				reasons.push(
					`boundaries for ${owner}/${metric} do not match block markers`,
				);
			}
		}
	}

	// Tails: exactly one per owner+tailMetric+candidate, each with enough samples.
	for (const owner of owners) {
		for (const metric of RAW_TAIL_METRICS[owner as RawOwner]) {
			for (const candidate of candidates) {
				const matches = r.tails.filter(
					(t) =>
						t.owner === owner &&
						t.metric === metric &&
						t.candidate === candidate,
				);
				if (matches.length !== 1) {
					reasons.push(
						`tail count ${owner}/${metric}/${candidate} = ${matches.length} != 1`,
					);
					continue;
				}
				if ((matches[0]?.samplesMs.length ?? 0) < exp.minTailTransactions) {
					reasons.push(
						`tail ${owner}/${metric}/${candidate} has < ${exp.minTailTransactions} samples`,
					);
				}
			}
		}
	}

	return { complete: reasons.length === 0, reasons };
}
