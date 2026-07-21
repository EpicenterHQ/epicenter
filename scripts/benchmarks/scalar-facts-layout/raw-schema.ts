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

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import { CANDIDATE_IDS } from './candidates.js';
import {
	buildProbePlan,
	buildProbeSource,
	PROBE_PHASES,
	type ProbePhase,
} from './probe-plan.js';
import { evaluateCalibrationTrials, type ScheduledBlock } from './schedule.js';
import type { TraceOptions } from './trace.js';

export const RAW_OWNERS = ['replica', 'authority'] as const;
export type RawOwner = (typeof RAW_OWNERS)[number];

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
export function buildIdFor(
	configIdentity: string,
	seedId: number,
	owner: string,
	candidate: string,
): string {
	return `${configIdentity}/${seedId}/${owner}/${candidate}/build`;
}

type FieldCheck = (value: unknown) => boolean;
const isNonNegativeFiniteNumber: FieldCheck = (v) =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPositiveFiniteNumber: FieldCheck = (v) =>
	typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNonNegativeInteger: FieldCheck = (v) =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositiveInteger: FieldCheck = (v) =>
	typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isString: FieldCheck = (v) => typeof v === 'string';
const isBoolean: FieldCheck = (v) => typeof v === 'boolean';
const isStringOrNull: FieldCheck = (v) => v === null || typeof v === 'string';
const isNonNegativeFiniteArray: FieldCheck = (v) =>
	Array.isArray(v) &&
	v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
const isThreeNonNegativeFiniteTuple: FieldCheck = (v) =>
	Array.isArray(v) &&
	v.length === 3 &&
	v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);

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

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

const ownerCheck: FieldCheck = (v) =>
	(RAW_OWNERS as readonly string[]).includes(v as string);
const candidateCheck: FieldCheck = (v) => CANDIDATE_IDS.includes(v as string);
const boundaryEnumCheck: FieldCheck = (v) =>
	v === 'start' || v === 'none' || v === 'pair' || v === 'cycle';
const letterCheck: FieldCheck = (v) =>
	(RAW_LETTERS as readonly string[]).includes(v as string);
const probePhaseCheck: FieldCheck = (v) =>
	(PROBE_PHASES as readonly string[]).includes(v as string);
const sha256Check: FieldCheck = (v) =>
	typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

export function isValidBlock(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		buildId: isString,
		cycle: isNonNegativeInteger,
		ordinal: isNonNegativeInteger,
		position: isNonNegativeInteger,
		letter: letterCheck,
		sequenceLabel: isString,
		predecessor: isStringOrNull,
		boundary: boundaryEnumCheck,
		ops: isPositiveInteger,
		calibrationId: isString,
		warmupProbeId: isString,
		warmupProbeDigest: sha256Check,
		timedProbeId: isString,
		timedProbeDigest: sha256Check,
		temporalOrdinal: isNonNegativeInteger,
		warmupMs: isThreeNonNegativeFiniteTuple,
		elapsedMs: isNonNegativeFiniteNumber,
	});
}
export function isValidCalibration(v: unknown): boolean {
	return isClosed(v, {
		configIdentity: isString,
		seedId: isNonNegativeInteger,
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		buildId: isString,
		roundIndex: isNonNegativeInteger,
		trialIndex: isNonNegativeInteger,
		sequenceOrder: isNonNegativeInteger,
		sequenceIndex: isNonNegativeInteger,
		position: isNonNegativeInteger,
		letter: letterCheck,
		ops: isPositiveInteger,
		elapsedMs: isNonNegativeFiniteNumber,
		minBlockMs: isPositiveFiniteNumber,
		probeId: isString,
		probeDigest: sha256Check,
		calibrationId: isString,
		temporalOrdinal: isNonNegativeInteger,
	});
}
export function isValidProbe(v: unknown): boolean {
	return isClosed(v, {
		configIdentity: isString,
		seedId: isNonNegativeInteger,
		owner: ownerCheck,
		metric: isString,
		phase: probePhaseCheck,
		probeId: isString,
		sourceDigest: sha256Check,
		itemsDigest: sha256Check,
		rowOffset: isNonNegativeInteger,
		rowCount: isPositiveInteger,
		watermarkOffset: isNonNegativeInteger,
		watermarkCount: isPositiveInteger,
		retryOffset: isNonNegativeInteger,
		retryCount: isPositiveInteger,
		traversalOffset: isNonNegativeInteger,
		traversalCount: isPositiveInteger,
		traversalStartSequence: isNonNegativeInteger,
		traversalEndSequence: isPositiveInteger,
		traversalPages: (pages) =>
			Array.isArray(pages) &&
			pages.every((page) =>
				isClosed(page, {
					pageIndex: isNonNegativeInteger,
					afterSequence: isNonNegativeInteger,
					throughSequence: isPositiveInteger,
					digest: sha256Check,
				}),
			),
	});
}
export function isValidBoundary(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		kind: (x) =>
			(RAW_BOUNDARY_KINDS as readonly string[]).includes(x as string),
		atOrdinal: isNonNegativeInteger,
		idleMs: isNonNegativeFiniteNumber,
		reopenMs: isNonNegativeFiniteNumber,
		reopenedCandidates: isPositiveInteger,
		reopenOk: isBoolean,
	});
}
export function isValidReopen(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		candidate: candidateCheck,
		buildId: isString,
		index: isNonNegativeInteger,
		orderPosition: isNonNegativeInteger,
		elapsedMs: isNonNegativeFiniteNumber,
		witnessDigest: isString,
		witnessMatchesOracle: isBoolean,
	});
}
export function isValidTail(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		transactions: isPositiveInteger,
		samplesMs: isNonNegativeFiniteArray,
		p50Ms: isNonNegativeFiniteNumber,
		p95Ms: isNonNegativeFiniteNumber,
		p99Ms: isNonNegativeFiniteNumber,
		throughputPerSec: isNonNegativeFiniteNumber,
		resetVerified: isBoolean,
		warmupTransactions: isNonNegativeInteger,
		walDeltaDiagnostic: isNonNegativeInteger,
		checkpointSignalTruthful: isBoolean,
	});
}
export function isValidMacro(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		metric: isString,
		candidate: candidateCheck,
		units: isPositiveInteger,
		elapsedMs: isNonNegativeFiniteNumber,
		throughputPerSec: isNonNegativeFiniteNumber,
	});
}
export function isValidCell(v: unknown): boolean {
	return isClosed(v, {
		owner: ownerCheck,
		candidate: candidateCheck,
		buildId: isString,
		oracleReproduced: isBoolean,
		integrityOk: isBoolean,
		candidateTableBytes: isNonNegativeInteger,
		fileBytes: isNonNegativeInteger,
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
		'probes',
		'calibrations',
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
			peakRetained: isNonNegativeInteger,
			liveAtCommit: isNonNegativeInteger,
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
		['probes', isValidProbe],
		['calibrations', isValidCalibration],
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
	tailTransactions: number;
	minBlockMs: number;
	maxBlockOps: number;
	seedId: number;
	configIdentity: string;
	traceOptions: TraceOptions;
	/** This seed's index in the config seed list, which fixes its schedule rotation. */
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

export type ExpectedObservationCounts = {
	probes: number;
	blocks: number;
	boundaries: number;
	reopens: number;
	tails: number;
	macros: number;
	cells: number;
};

/** Exact non-calibration observation counts derived from the frozen owners. */
export function expectedObservationCounts(
	exp: CompletenessExpectations,
): ExpectedObservationCounts {
	let readGroups = 0;
	let tailGroups = 0;
	for (const owner of exp.owners) {
		readGroups += RAW_READ_METRICS[owner as RawOwner]?.length ?? 0;
		tailGroups += RAW_TAIL_METRICS[owner as RawOwner]?.length ?? 0;
	}
	const boundariesPerSchedule = exp.schedule.filter(
		(block) =>
			block.precedingBoundary === 'pair' || block.precedingBoundary === 'cycle',
	).length;
	const cells = exp.owners.length * exp.candidates.length;
	return {
		probes: readGroups * PROBE_PHASES.length,
		blocks: readGroups * exp.schedule.length,
		boundaries: readGroups * boundariesPerSchedule,
		reopens: cells * exp.reopenObservations,
		tails: tailGroups * exp.candidates.length,
		macros: cells,
		cells,
	};
}

export type SeedCompleteness = { complete: boolean; reasons: string[] };

/**
 * Validate whole-seed completeness against the exact per-seed expectations. Beyond
 * exact counts and unique identities (macros, cells, reopens, tails), every read
 * block is compared IN ORDER against the expected schedule derived from the single
 * schedule owner: ordinal, cycle, position, letter, mapped candidate, sequence
 * label, predecessor, and boundary marker must all match, and the build id must
 * equal the content-bound config/seed/owner/candidate identity. letterMapping
 * must equal the owner's mapping; the balanced reopen
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
		probes: {
			configIdentity: string;
			seedId: number;
			owner: string;
			metric: string;
			phase: ProbePhase;
			probeId: string;
			sourceDigest: string;
			itemsDigest: string;
			rowOffset: number;
			rowCount: number;
			watermarkOffset: number;
			watermarkCount: number;
			retryOffset: number;
			retryCount: number;
			traversalOffset: number;
			traversalCount: number;
			traversalStartSequence: number;
			traversalEndSequence: number;
			traversalPages: {
				pageIndex: number;
				afterSequence: number;
				throughSequence: number;
				digest: string;
			}[];
		}[];
		calibrations: {
			configIdentity: string;
			seedId: number;
			owner: string;
			metric: string;
			candidate: string;
			buildId: string;
			roundIndex: number;
			trialIndex: number;
			sequenceOrder: number;
			sequenceIndex: number;
			position: number;
			letter: 'A' | 'B' | 'C' | 'D';
			ops: number;
			elapsedMs: number;
			minBlockMs: number;
			probeId: string;
			probeDigest: string;
			calibrationId: string;
			temporalOrdinal: number;
		}[];
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
			ops: number;
			calibrationId: string;
			warmupProbeId: string;
			warmupProbeDigest: string;
			timedProbeId: string;
			timedProbeDigest: string;
			temporalOrdinal: number;
			warmupMs: number[];
			elapsedMs: number;
		}[];
		boundaries: {
			owner: string;
			metric: string;
			kind: string;
			atOrdinal: number;
			reopenedCandidates: number;
			reopenOk: boolean;
		}[];
		reopens: {
			owner: string;
			candidate: string;
			buildId: string;
			index: number;
			orderPosition: number;
			witnessMatchesOracle: boolean;
		}[];
		tails: {
			owner: string;
			metric: string;
			candidate: string;
			transactions: number;
			samplesMs: number[];
			p50Ms: number;
			p95Ms: number;
			p99Ms: number;
			throughputPerSec: number;
			warmupTransactions: number;
		}[];
		macros: {
			owner: string;
			metric: string;
			candidate: string;
			units: number;
			elapsedMs: number;
			throughputPerSec: number;
		}[];
		cells: { owner: string; candidate: string; buildId: string }[];
	};

	const owners = exp.owners;
	const candidates = exp.candidates;
	const candidateSet = new Set(candidates);
	const cellCount = owners.length * candidates.length;
	const expectedCounts = expectedObservationCounts(exp);
	for (const [kind, expected] of Object.entries(expectedCounts)) {
		const actual = r[kind as keyof typeof r];
		if (!Array.isArray(actual) || actual.length !== expected) {
			reasons.push(
				`${kind} count ${Array.isArray(actual) ? actual.length : 'invalid'} != ${expected}`,
			);
		}
	}

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
		buildIdFor(exp.configIdentity, exp.seedId, owner, candidate);
	const expectedCalibrationId = (owner: string, metric: string) =>
		`${exp.configIdentity}/${exp.seedId}/${owner}/${metric}/calibration`;

	// Probe plans: raw never serves as its own oracle. Rebuild the deterministic
	// layout-independent source from the frozen trace options, then compare every
	// retained owner/metric/phase plan to that expected record field-for-field.
	let probeSource: ReturnType<typeof buildProbeSource>;
	try {
		probeSource = buildProbeSource(exp.traceOptions);
	} catch (error) {
		return {
			complete: false,
			reasons: [`expected probe source invalid: ${(error as Error).message}`],
		};
	}
	for (const probe of r.probes) {
		const validMetric = (
			RAW_READ_METRICS[probe.owner as RawOwner] as readonly string[] | undefined
		)?.includes(probe.metric);
		if (!validMetric) {
			reasons.push(
				`probe carries unexpected owner/metric ${probe.owner}/${probe.metric}`,
			);
		}
		if (
			probe.configIdentity !== exp.configIdentity ||
			probe.seedId !== exp.seedId
		) {
			reasons.push(
				`probe config/seed for ${probe.owner}/${probe.metric} changed`,
			);
		}
	}
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			for (const phase of PROBE_PHASES) {
				const matches = r.probes.filter(
					(probe) =>
						probe.owner === owner &&
						probe.metric === metric &&
						probe.phase === phase,
				);
				if (matches.length !== 1) {
					reasons.push(`probe plan ${owner}/${metric}/${phase} is not unique`);
					continue;
				}
				const expected = buildProbePlan(probeSource, {
					configIdentity: exp.configIdentity,
					seedId: exp.seedId,
					owner,
					metric,
					phase,
				}).plan;
				if (canonicalize(matches[0]) !== canonicalize(expected)) {
					reasons.push(`probe plan ${owner}/${metric}/${phase} changed`);
				}
			}
		}
	}

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
		const expectedThroughput =
			m.elapsedMs > 0 ? (m.units / m.elapsedMs) * 1000 : 0;
		if (Math.abs(m.throughputPerSec - expectedThroughput) > 1e-9) {
			reasons.push(`macro throughput for ${m.owner}/${m.candidate} changed`);
		}
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

	// Calibration: every owner+read-metric group owns one retained sequence of
	// ACTUAL balanced candidate trials. The sequence starts at one operation,
	// doubles contiguously, and stops at the first trial where all candidates meet
	// the frozen duration floor. No seconds-per-operation projection is accepted.
	const calibrationDecisions = new Map<
		string,
		{ selectedOps: number; calibrationId: string }
	>();
	for (const c of r.calibrations) {
		const validMetric = (
			RAW_READ_METRICS[c.owner as RawOwner] as readonly string[] | undefined
		)?.includes(c.metric);
		if (!validMetric) {
			reasons.push(
				`calibration carries unexpected owner/metric ${c.owner}/${c.metric}`,
			);
		}
		if (c.minBlockMs !== exp.minBlockMs)
			reasons.push(`calibration minBlockMs for ${c.owner}/${c.metric} changed`);
		if (c.configIdentity !== exp.configIdentity || c.seedId !== exp.seedId) {
			reasons.push(
				`calibration config/seed for ${c.owner}/${c.metric} changed`,
			);
		}
		if (c.buildId !== expectedBuildId(c.owner, c.candidate)) {
			reasons.push(
				`calibration buildId for ${c.owner}/${c.metric}/${c.candidate} changed`,
			);
		}
		if (c.calibrationId !== expectedCalibrationId(c.owner, c.metric)) {
			reasons.push(`calibration identity for ${c.owner}/${c.metric} changed`);
		}
		const plan = r.probes.find(
			(probe) =>
				probe.owner === c.owner &&
				probe.metric === c.metric &&
				probe.phase === 'calibration',
		);
		if (
			plan === undefined ||
			c.probeId !== plan.probeId ||
			c.probeDigest !== plan.itemsDigest
		) {
			reasons.push(
				`calibration probe digest for ${c.owner}/${c.metric} changed`,
			);
		}
	}
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			const group = r.calibrations.filter(
				(c) => c.owner === owner && c.metric === metric,
			);
			const decision = evaluateCalibrationTrials(
				group,
				exp.letterMapping as Record<'A' | 'B' | 'C' | 'D', string>,
				exp.minBlockMs,
				exp.maxBlockOps,
			);
			if (decision.status !== 'SELECTED') {
				reasons.push(
					`calibration for ${owner}/${metric} incomplete: ${decision.reason}`,
				);
				continue;
			}
			calibrationDecisions.set(`${owner}/${metric}`, {
				selectedOps: decision.selectedOps,
				calibrationId: expectedCalibrationId(owner, metric),
			});
		}
	}

	// Temporal identity has one owner: owner order, then declared metric order,
	// then that metric's complete calibration rounds followed by its exact timed
	// schedule. The stored ordinals and both raw arrays must replay this order as
	// the gap-free set 0..N-1. Shifts, gaps, duplicates, and rewrites all refuse.
	let expectedTemporalOrdinal = 0;
	let calibrationArrayIndex = 0;
	let blockArrayIndex = 0;
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			const calibrations = r.calibrations.filter(
				(calibration) =>
					calibration.owner === owner && calibration.metric === metric,
			);
			for (const calibration of calibrations) {
				if (
					r.calibrations[calibrationArrayIndex] !== calibration ||
					calibration.temporalOrdinal !== expectedTemporalOrdinal
				) {
					reasons.push(
						`calibration temporal order for ${owner}/${metric} changed`,
					);
				}
				calibrationArrayIndex += 1;
				expectedTemporalOrdinal += 1;
			}
			const blocks = r.blocks.filter(
				(block) => block.owner === owner && block.metric === metric,
			);
			for (const [scheduleIndex, block] of blocks.entries()) {
				if (
					r.blocks[blockArrayIndex] !== block ||
					block.ordinal !== exp.schedule[scheduleIndex]?.ordinal ||
					block.temporalOrdinal !== expectedTemporalOrdinal
				) {
					reasons.push(`timed temporal order for ${owner}/${metric} changed`);
				}
				blockArrayIndex += 1;
				expectedTemporalOrdinal += 1;
			}
		}
	}
	if (
		calibrationArrayIndex !== r.calibrations.length ||
		blockArrayIndex !== r.blocks.length
	) {
		reasons.push(
			'temporal event arrays contain events outside the frozen order',
		);
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
		if (!x.witnessMatchesOracle)
			reasons.push(`reopen witness for ${x.owner}/${x.candidate} changed`);
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
		const calibration = calibrationDecisions.get(`${b.owner}/${b.metric}`);
		if (
			calibration === undefined ||
			b.ops !== calibration.selectedOps ||
			b.calibrationId !== calibration.calibrationId
		) {
			reasons.push(
				`block ${b.owner}/${b.metric} is not bound to its complete calibration`,
			);
		}
		if (new Set([b.warmupProbeId, b.timedProbeId]).size !== 2) {
			reasons.push(
				`block ${b.owner}/${b.metric} does not keep warmup and timed probes disjoint`,
			);
		}
		const warmupPlan = r.probes.find(
			(probe) =>
				probe.owner === b.owner &&
				probe.metric === b.metric &&
				probe.phase === 'warmup',
		);
		const timedPlan = r.probes.find(
			(probe) =>
				probe.owner === b.owner &&
				probe.metric === b.metric &&
				probe.phase === 'timed',
		);
		if (
			warmupPlan === undefined ||
			timedPlan === undefined ||
			b.warmupProbeId !== warmupPlan.probeId ||
			b.timedProbeId !== timedPlan.probeId ||
			b.warmupProbeDigest !== warmupPlan.itemsDigest ||
			b.timedProbeDigest !== timedPlan.itemsDigest
		) {
			reasons.push(`block ${b.owner}/${b.metric} probe digest binding changed`);
		}
	}
	for (const owner of owners) {
		for (const metric of RAW_READ_METRICS[owner as RawOwner]) {
			const calibrations = r.calibrations.filter(
				(c) => c.owner === owner && c.metric === metric,
			);
			const blocks = r.blocks.filter(
				(b) => b.owner === owner && b.metric === metric,
			);
			const lastCalibration = Math.max(
				...calibrations.map((c) => c.temporalOrdinal),
			);
			const firstTimed = Math.min(...blocks.map((b) => b.temporalOrdinal));
			if (
				!Number.isFinite(lastCalibration) ||
				!Number.isFinite(firstTimed) ||
				lastCalibration >= firstTimed
			) {
				reasons.push(
					`calibration for ${owner}/${metric} did not precede timing`,
				);
			}
		}
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
		if (!bd.reopenOk)
			reasons.push(`boundary reopen failed for ${bd.owner}/${bd.metric}`);
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

	// Tails: exactly one per owner+tailMetric+candidate, with the exact frozen
	// transaction and sample counts. Permissive minima would let a resumed seed
	// silently change the estimator meaning.
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
				const tail = matches[0];
				if (
					tail?.transactions !== exp.tailTransactions ||
					tail.samplesMs.length !== exp.tailTransactions
				) {
					reasons.push(
						`tail ${owner}/${metric}/${candidate} does not have exactly ${exp.tailTransactions} transactions and samples`,
					);
				}
				if (tail?.warmupTransactions !== 3) {
					reasons.push(
						`tail ${owner}/${metric}/${candidate} does not have exactly three warmups`,
					);
				}
				if (tail !== undefined) {
					const totalMs = tail.samplesMs.reduce(
						(sum, sample) => sum + sample,
						0,
					);
					const expectedThroughput =
						totalMs > 0 ? (tail.samplesMs.length / totalMs) * 1000 : 0;
					if (
						tail.p50Ms !== percentile(tail.samplesMs, 0.5) ||
						tail.p95Ms !== percentile(tail.samplesMs, 0.95) ||
						tail.p99Ms !== percentile(tail.samplesMs, 0.99) ||
						Math.abs(tail.throughputPerSec - expectedThroughput) > 1e-9
					) {
						reasons.push(
							`tail summaries for ${owner}/${metric}/${candidate} do not match raw samples`,
						);
					}
				}
			}
		}
	}

	return { complete: reasons.length === 0, reasons };
}
