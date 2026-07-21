/**
 * Deterministic corpus, aging events, and the layout-independent oracle.
 *
 * Everything is a pure function of a numeric seed: no wall clock, no
 * `Math.random`. Two candidates in one repetition consume exactly the same
 * event stream, so any difference they show is the layout, never the data.
 *
 * The oracle is analytical and streaming. Every emitted change gets a dense
 * unique sequence (band-major, index-minor emission), and the final fact at an
 * index is the highest band that applies to it. Closed-form cohort counts give
 * that final band, its dense sequence, and its calibrated payload size in O(1),
 * so the full-scale oracle never retains the payload corpus or a per-fact map.
 *
 * Two byte measures are kept distinct (ADR-0161, ADR-0167):
 *
 * - PRESENT LOGICAL STATE: the ADR-0167 logical content of present rows and
 *   values only, excluding authority sequences and terminal tombstones. This is
 *   the 1,000,000-live-address / 512 MiB target quantity. ADR-0167 leaves the
 *   exact canonical logical-state encoding an unfrozen implementation decision,
 *   so this is a DEFINED PROXY (canonical JSON of the logical columns), reported
 *   as a stress target, never a frozen conformance qualification.
 * - CURRENT PROTOCOL FACT bytes: the full V1 fact record (structured address,
 *   `presence`, sequence, and payload) over every current fact including terminal
 *   absences. A storage and workload diagnostic, not the logical-state target.
 *
 * Correctness is checked against the oracle's three-part witness (exact count,
 * exact current-protocol-fact bytes, one ordered SHA-256 in ascending sequence)
 * over every current fact, never against a layout's own read path.
 */
import {
	canonicalize,
	utf8ByteLength,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import { Sha256Stream } from './portable-hash.js';

/**
 * The trace's fact and address shapes ARE the private V1 kernel shapes, imported
 * rather than mirrored. Every generated fact is therefore a `Fact` the V1 parser
 * would accept, and `v1-binding.ts` proves that at runtime against `parseFact`
 * and `encodedFactBytes`. Re-exported so downstream benchmark modules and tests
 * share one fact vocabulary with the protocol they measure.
 */
export type {
	Address,
	Fact,
	JsonObject,
	JsonValue,
	RowAddress,
	ValueAddress,
} from '../../../packages/data/src/protocol/v1/index.js';

import type {
	Address,
	Fact,
	JsonObject,
	JsonValue,
} from '../../../packages/data/src/protocol/v1/index.js';

export type TraceOptions = {
	facts: number;
	namespaceCount: number;
	tableCount: number;
	valueRatio: number;
	dataSeed: number;
	/** Exact present-logical-state byte target; row filler is calibrated to it. */
	targetLogicalStateBytes: number;
	/** Predeclared provisional per-fact ceiling (ADR-0163); qualification gates on it. */
	maxEncodedFactBytes: number;
};

export type ObservedCardinalities = {
	facts: number;
	namespaces: number;
	tables: number;
	values: number;
	rows: number;
	rewrites: number;
	rowTombstones: number;
	valueUnsets: number;
	valueResurrections: number;
	initialAbsentThenPresent: number;
	finalPresent: number;
	finalAbsent: number;
};

/** The full measurement of one final state: correctness witness plus both byte measures. */
export type Measures = {
	/** Count of every current fact, present or absent (correctness). */
	currentCount: number;
	/** Ordered SHA-256 over every current protocol fact (correctness). */
	digestHex: string;
	/** Current V1 protocol-fact bytes over every current fact (diagnostic). */
	currentProtocolFactBytes: number;
	/** Largest single current protocol fact, to catch a calibration outlier. */
	maxProtocolFactBytes: number;
	/** Count of final-present addresses (the ADR-0161 live-address count). */
	presentCount: number;
	/** Present logical-state bytes (ADR-0167 proxy; the 512 MiB target quantity). */
	presentLogicalStateBytes: number;
	/** Largest single present logical record. */
	maxLogicalRecordBytes: number;
};

const SALT_NS = 0x4e53_5041;
const SALT_TABLE = 0x5442_4c45;

const BAND_PHASE0 = 0;
const BAND_REWRITE = 1;
const BAND_TOMBSTONE = 2;
const BAND_UNSET = 3;
const BAND_RESURRECT = 4;
const BAND_ACTIVATE = 5;

const REWRITE_MOD = 10; // 10% rewrites
const TOMBSTONE_MOD = 20; // 5% of rows
const UNSET_MOD = 100; // 1% of values
const RESURRECT_MOD = 300; // a third of unset values return (100k, k % 3 == 0)
const INITIAL_ABSENT_MOD = 50; // some values start absent, then activate
const INITIAL_ABSENT_OFFSET = 25; // disjoint from unset/rewrite congruences

export function hash32(seed: number, index: number): number {
	let h = (Math.imul(seed ^ 0x9e37_79b9, 0x85eb_ca6b) ^ index) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x85eb_ca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35) >>> 0;
	return (h ^ (h >>> 16)) >>> 0;
}

/** UTF-8 byte length via the kernel's exact encoder, so trace byte measures and
 * the V1 encoded-byte oracle come from one function. */
export function utf8Len(text: string): number {
	return utf8ByteLength(text);
}

/** Count of j in [0, n) with j % m === r. */
function countCongruent(n: number, m: number, r: number): number {
	if (n <= 0 || r >= n) return 0;
	return Math.floor((n - 1 - r) / m) + 1;
}

export function addressKey(address: Address): string {
	return address.kind === 'row'
		? `row|${address.namespace}|${address.table}|${address.rowId}`
		: `value|${address.namespace}|${address.value}`;
}

/**
 * The exact V1 canonical bytes of a fact: the kernel's RFC 8785 encoder over the
 * real Fact shape. Because the trace `Fact` IS the kernel `Fact` and `canonicalize`
 * sorts object keys, this is exactly the string the kernel's `encodedFactBytes`
 * hashes, so `utf8Len(canonicalFactRecord(fact)) === encodedFactBytes(fact)`.
 * `v1-binding.ts` proves that identity, making this a true oracle cross-check and
 * not merely a private re-encoding.
 */
export function canonicalFactRecord(fact: Fact): string {
	return canonicalize(fact);
}

/**
 * The ADR-0167 logical-state record of a PRESENT fact: logical columns only, no
 * sequence and no presence, and never for an absent fact. A defined proxy for
 * the unfrozen canonical logical-state encoding.
 */
export function logicalRecord(fact: Fact): string | null {
	if (fact.presence !== 'present') return null; // tombstones are not logical state
	if ('fields' in fact)
		return canonicalize({
			fields: fact.fields,
			namespaceKey: fact.address.namespace,
			rowId: fact.address.rowId,
			tableKey: fact.address.table,
		});
	return canonicalize({
		content: fact.content,
		namespaceKey: fact.address.namespace,
		valueKey: fact.address.value,
	});
}

function namespaceLabel(index: number): string {
	return `so.epicenter.ns${index.toString().padStart(2, '0')}`;
}
function tableLabel(index: number): string {
	return `collection${index.toString().padStart(4, '0')}`;
}
function valueLabel(index: number): string {
	return `setting${index.toString(36)}`;
}
function rowIdOf(index: number): string {
	return index.toString(36).padStart(24, '0');
}

function valueCountOf(facts: number, valueRatio: number): number {
	return Math.max(1, Math.ceil(facts * valueRatio));
}

function isValue(index: number, valueCount: number): boolean {
	return index < valueCount;
}
function isInitialAbsent(index: number, valueCount: number): boolean {
	return (
		index < valueCount && index % INITIAL_ABSENT_MOD === INITIAL_ABSENT_OFFSET
	);
}
function isUnset(index: number, valueCount: number): boolean {
	return index < valueCount && index % UNSET_MOD === 0;
}
function isResurrected(index: number, valueCount: number): boolean {
	return index < valueCount && index % RESURRECT_MOD === 0;
}
function isTombstone(index: number, valueCount: number): boolean {
	return index >= valueCount && index % TOMBSTONE_MOD === 0;
}
function isRewrite(index: number, valueCount: number): boolean {
	return !isInitialAbsent(index, valueCount) && index % REWRITE_MOD === 0;
}

export function addressAt(index: number, options: TraceOptions): Address {
	const valueCount = valueCountOf(options.facts, options.valueRatio);
	const namespace = namespaceLabel(
		hash32(options.dataSeed ^ SALT_NS, index) % options.namespaceCount,
	);
	if (isValue(index, valueCount)) {
		return { kind: 'value', namespace, value: valueLabel(index) };
	}
	const table = tableLabel(
		hash32(options.dataSeed ^ SALT_TABLE, index) % options.tableCount,
	);
	return { kind: 'row', namespace, table, rowId: rowIdOf(index) };
}

/** Fixed-size value content by class, so value facts never carry adjustable filler. */
function valueContent(index: number, phase: number): JsonValue {
	const cls = index % 3;
	if (cls === 0) return null;
	if (cls === 1) return index;
	return `${phase}v${index}`;
}

/** The highest applicable band for an index and the payload phase it carries. */
function finalBand(
	index: number,
	valueCount: number,
): { band: number; present: boolean; phase: number } {
	if (isInitialAbsent(index, valueCount))
		return { band: BAND_ACTIVATE, present: true, phase: 2 };
	if (isValue(index, valueCount)) {
		if (isResurrected(index, valueCount))
			return { band: BAND_RESURRECT, present: true, phase: 2 };
		if (isUnset(index, valueCount))
			return { band: BAND_UNSET, present: false, phase: 0 };
	} else if (isTombstone(index, valueCount)) {
		return { band: BAND_TOMBSTONE, present: false, phase: 0 };
	}
	if (isRewrite(index, valueCount))
		return { band: BAND_REWRITE, present: true, phase: 1 };
	return { band: BAND_PHASE0, present: true, phase: 0 };
}

function bandCounts(facts: number, valueCount: number): number[] {
	const e0 =
		facts -
		countCongruent(valueCount, INITIAL_ABSENT_MOD, INITIAL_ABSENT_OFFSET);
	const e1 = countCongruent(facts, REWRITE_MOD, 0);
	const e2 =
		countCongruent(facts, TOMBSTONE_MOD, 0) -
		countCongruent(valueCount, TOMBSTONE_MOD, 0);
	const e3 = countCongruent(valueCount, UNSET_MOD, 0);
	const e4 = countCongruent(valueCount, RESURRECT_MOD, 0);
	const e5 = countCongruent(
		valueCount,
		INITIAL_ABSENT_MOD,
		INITIAL_ABSENT_OFFSET,
	);
	return [e0, e1, e2, e3, e4, e5];
}

function bandRankBelow(i: number, band: number, valueCount: number): number {
	const vHi = Math.min(i, valueCount);
	switch (band) {
		case BAND_PHASE0:
			return i - countCongruent(vHi, INITIAL_ABSENT_MOD, INITIAL_ABSENT_OFFSET);
		case BAND_REWRITE:
			return countCongruent(i, REWRITE_MOD, 0);
		case BAND_TOMBSTONE:
			return (
				countCongruent(i, TOMBSTONE_MOD, 0) -
				countCongruent(vHi, TOMBSTONE_MOD, 0)
			);
		case BAND_UNSET:
			return countCongruent(vHi, UNSET_MOD, 0);
		case BAND_RESURRECT:
			return countCongruent(vHi, RESURRECT_MOD, 0);
		default:
			return countCongruent(vHi, INITIAL_ABSENT_MOD, INITIAL_ABSENT_OFFSET);
	}
}

function adjustableRowsBelow(i: number, valueCount: number): number {
	if (i <= valueCount) return 0;
	const rows = i - valueCount;
	const tombstones =
		countCongruent(i, TOMBSTONE_MOD, 0) -
		countCongruent(valueCount, TOMBSTONE_MOD, 0);
	return rows - tombstones;
}

function isAdjustableRow(index: number, valueCount: number): boolean {
	return index >= valueCount && !isTombstone(index, valueCount);
}

/** Final-absent count in [0, facts): row tombstones plus non-resurrected value unsets. */
function finalAbsentCount(facts: number, valueCount: number): number {
	const rowTombstones =
		countCongruent(facts, TOMBSTONE_MOD, 0) -
		countCongruent(valueCount, TOMBSTONE_MOD, 0);
	const unsets = countCongruent(valueCount, UNSET_MOD, 0);
	const resurrected = countCongruent(valueCount, RESURRECT_MOD, 0);
	return rowTombstones + (unsets - resurrected);
}

type Calibration = {
	quotient: number;
	remainder: number;
	adjustableRows: number;
	baseLogicalBytes: number;
	achievedLogicalStateBytes: number;
	/** Upper bound on any current protocol fact (build or final), for the ceiling gate. */
	maxProtocolFactBytesBound: number;
	/**
	 * True only if the logical byte target is hit AND no fact exceeds
	 * maxEncodedFactBytes. This is a NARROW trace-construction flag: the corpus is
	 * admissible as a workload source. It is not an ADR/evidence-cell
	 * qualification and never implies a layout, cell, or run is decision-eligible.
	 */
	traceAdmissible: boolean;
	/** Why the trace is not admissible, when it is not. */
	inadmissibleBecause: 'none' | 'logical-target' | 'fact-ceiling';
};

export type Trace = {
	options: TraceOptions;
	calibration: Calibration;
	finalFactAt(index: number): Fact;
	events(): Generator<Fact>;
	/** One streaming pass: correctness witness plus both byte measures. */
	measure(): Measures;
	observed(): ObservedCardinalities;
	sampleRowAddresses(count: number): Address[];
	sampleValueAddresses(count: number): Address[];
};

export function makeTrace(options: TraceOptions): Trace {
	const facts = options.facts;
	const valueCount = valueCountOf(options.facts, options.valueRatio);
	const [e0, e1, e2, e3, e4] = bandCounts(facts, valueCount) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const cumBefore = [
		0,
		e0,
		e0 + e1,
		e0 + e1 + e2,
		e0 + e1 + e2 + e3,
		e0 + e1 + e2 + e3 + e4,
	];

	function denseSequence(index: number, band: number): number {
		return (cumBefore[band] ?? 0) + bandRankBelow(index, band, valueCount) + 1;
	}

	function rowFieldsObject(
		index: number,
		phase: number,
		fillerLen: number,
	): JsonObject {
		return { body: 'x'.repeat(fillerLen), ordinal: index, phase };
	}

	function factWith(
		index: number,
		band: number,
		phase: number,
		present: boolean,
		fillerLen: number,
	): Fact {
		const address = addressAt(index, options);
		const sequence = denseSequence(index, band);
		if (address.kind === 'row') {
			return present
				? {
						address,
						sequence,
						presence: 'present',
						fields: rowFieldsObject(index, phase, fillerLen),
					}
				: { address, sequence, presence: 'absent' };
		}
		return present
			? {
					address,
					sequence,
					presence: 'present',
					content: valueContent(index, phase),
				}
			: { address, sequence, presence: 'absent' };
	}

	function finalFactWith(index: number, fillerLen: number): Fact {
		const { band, present, phase } = finalBand(index, valueCount);
		return factWith(index, band, phase, present, fillerLen);
	}

	const totalEvents = bandCounts(facts, valueCount).reduce((s, x) => s + x, 0);

	/**
	 * A safe upper bound on any current protocol fact, build or final: a present
	 * row at the largest ordinal and sequence with the largest filler. Every real
	 * row fact is no larger, and value facts are smaller, so a bound within the
	 * ceiling proves every fact fits.
	 */
	function maxProtocolFactBound(maxBody: number): number {
		const worst: Fact = {
			address: {
				kind: 'row',
				namespace: namespaceLabel(Math.max(0, options.namespaceCount - 1)),
				table: tableLabel(Math.max(0, options.tableCount - 1)),
				rowId: rowIdOf(Math.max(0, facts - 1)),
			},
			sequence: Math.max(1, totalEvents),
			presence: 'present',
			fields: {
				body: 'x'.repeat(maxBody),
				ordinal: Math.max(0, facts - 1),
				phase: 2,
			},
		};
		return utf8Len(canonicalFactRecord(worst));
	}

	// Calibration pass: present logical bytes at zero row filler, then exact split.
	function calibrate(): Calibration {
		let baseLogicalBytes = 0;
		for (let index = 0; index < facts; index += 1) {
			const record = logicalRecord(finalFactWith(index, 0));
			if (record !== null) baseLogicalBytes += utf8Len(record);
		}
		const adjustableRows = adjustableRowsBelow(facts, valueCount);
		const delta = options.targetLogicalStateBytes - baseLogicalBytes;
		const gate = (
			quotient: number,
			remainder: number,
			achieved: number,
			logicalOk: boolean,
		): Calibration => {
			const maxBody = quotient + (remainder > 0 ? 1 : 0);
			const bound = maxProtocolFactBound(maxBody);
			const ceilingOk = bound <= options.maxEncodedFactBytes;
			return {
				quotient,
				remainder,
				adjustableRows,
				baseLogicalBytes,
				achievedLogicalStateBytes: achieved,
				maxProtocolFactBytesBound: bound,
				traceAdmissible: logicalOk && ceilingOk,
				inadmissibleBecause: !logicalOk
					? 'logical-target'
					: ceilingOk
						? 'none'
						: 'fact-ceiling',
			};
		};
		if (adjustableRows <= 0 || delta < 0) {
			return gate(
				0,
				0,
				baseLogicalBytes,
				options.targetLogicalStateBytes === baseLogicalBytes,
			);
		}
		const quotient = Math.floor(delta / adjustableRows);
		const remainder = delta - quotient * adjustableRows;
		return gate(
			quotient,
			remainder,
			baseLogicalBytes + adjustableRows * quotient + remainder,
			true,
		);
	}
	const calibration = calibrate();

	/** Final-state filler for an adjustable (surviving) row. */
	function finalFillerLenAt(index: number): number {
		if (!isAdjustableRow(index, valueCount)) return 0;
		const rank = adjustableRowsBelow(index, valueCount);
		return calibration.quotient + (rank < calibration.remainder ? 1 : 0);
	}

	/**
	 * Build-time filler for a PRESENT row event. A surviving row uses its final
	 * calibrated size; a terminal (later-tombstoned) row still gets a
	 * representative present payload (the quotient) so the build and aging
	 * workload is weighted realistically, without entering final calibration.
	 */
	function buildFillerLenAt(index: number): number {
		if (isAdjustableRow(index, valueCount)) return finalFillerLenAt(index);
		return calibration.quotient; // terminal row: representative initial payload
	}

	function finalFactAt(index: number): Fact {
		return finalFactWith(index, finalFillerLenAt(index));
	}

	function* events(): Generator<Fact> {
		let sequence = 0;
		const emit = (index: number, phase: number, present: boolean): Fact => {
			sequence += 1;
			const address = addressAt(index, options);
			if (address.kind === 'row') {
				return present
					? {
							address,
							sequence,
							presence: 'present',
							fields: rowFieldsObject(index, phase, buildFillerLenAt(index)),
						}
					: { address, sequence, presence: 'absent' };
			}
			return present
				? {
						address,
						sequence,
						presence: 'present',
						content: valueContent(index, phase),
					}
				: { address, sequence, presence: 'absent' };
		};
		for (let index = 0; index < facts; index += 1)
			if (!isInitialAbsent(index, valueCount)) yield emit(index, 0, true);
		for (let index = 0; index < facts; index += 1)
			if (isRewrite(index, valueCount)) yield emit(index, 1, true);
		for (let index = 0; index < facts; index += 1)
			if (isTombstone(index, valueCount)) yield emit(index, 0, false);
		for (let index = 0; index < facts; index += 1)
			if (isUnset(index, valueCount)) yield emit(index, 0, false);
		for (let index = 0; index < facts; index += 1)
			if (isResurrected(index, valueCount)) yield emit(index, 2, true);
		for (let index = 0; index < facts; index += 1)
			if (isInitialAbsent(index, valueCount)) yield emit(index, 2, true);
	}

	function* finalFactsBySequence(): Generator<Fact> {
		for (let band = 0; band <= BAND_ACTIVATE; band += 1) {
			for (let index = 0; index < facts; index += 1) {
				if (finalBand(index, valueCount).band === band)
					yield finalFactAt(index);
			}
		}
	}

	function measure(): Measures {
		const hasher = new Sha256Stream();
		let currentCount = 0;
		let currentProtocolFactBytes = 0;
		let maxProtocolFactBytes = 0;
		let presentCount = 0;
		let presentLogicalStateBytes = 0;
		let maxLogicalRecordBytes = 0;
		for (const fact of finalFactsBySequence()) {
			const record = canonicalFactRecord(fact);
			const recordBytes = utf8Len(record);
			// Length-prefixed by UTF-8 byte length so no two records concatenate.
			hasher.update(`${recordBytes}:${record}\n`);
			currentCount += 1;
			currentProtocolFactBytes += recordBytes;
			if (recordBytes > maxProtocolFactBytes)
				maxProtocolFactBytes = recordBytes;
			const logical = logicalRecord(fact);
			if (logical !== null) {
				const logicalBytes = utf8Len(logical);
				presentCount += 1;
				presentLogicalStateBytes += logicalBytes;
				if (logicalBytes > maxLogicalRecordBytes)
					maxLogicalRecordBytes = logicalBytes;
			}
		}
		return {
			currentCount,
			digestHex: hasher.digestHex(),
			currentProtocolFactBytes,
			maxProtocolFactBytes,
			presentCount,
			presentLogicalStateBytes,
			maxLogicalRecordBytes,
		};
	}

	function observed(): ObservedCardinalities {
		const namespaces = new Set<number>();
		const tables = new Set<number>();
		let values = 0;
		let rows = 0;
		let rewrites = 0;
		let rowTombstones = 0;
		let valueUnsets = 0;
		let valueResurrections = 0;
		let initialAbsentThenPresent = 0;
		for (let index = 0; index < facts; index += 1) {
			namespaces.add(
				hash32(options.dataSeed ^ SALT_NS, index) % options.namespaceCount,
			);
			if (isValue(index, valueCount)) {
				values += 1;
				if (isInitialAbsent(index, valueCount)) initialAbsentThenPresent += 1;
				else if (isResurrected(index, valueCount)) valueResurrections += 1;
				else if (isUnset(index, valueCount)) valueUnsets += 1;
			} else {
				rows += 1;
				tables.add(
					hash32(options.dataSeed ^ SALT_TABLE, index) % options.tableCount,
				);
				if (isTombstone(index, valueCount)) rowTombstones += 1;
			}
			if (isRewrite(index, valueCount)) rewrites += 1;
		}
		const finalAbsent = finalAbsentCount(facts, valueCount);
		return {
			facts,
			namespaces: namespaces.size,
			tables: tables.size,
			values,
			rows,
			rewrites,
			rowTombstones,
			valueUnsets,
			valueResurrections,
			initialAbsentThenPresent,
			finalPresent: facts - finalAbsent,
			finalAbsent,
		};
	}

	function permutation(
		seed: number,
		count: number,
		lo: number,
		hi: number,
	): number[] {
		const range = hi - lo;
		if (range <= 0) return [];
		const wanted = Math.min(count, range);
		const start = hash32(seed, 0) % range;
		let stride = 1 + (hash32(seed, 1) % range);
		while (gcd(stride, range) !== 1) stride = (stride % range) + 1;
		const out: number[] = [];
		for (let k = 0; k < wanted; k += 1)
			out.push(lo + ((start + k * stride) % range));
		return out;
	}

	function sampleRowAddresses(count: number): Address[] {
		return permutation(
			options.dataSeed ^ 0x524f57,
			count,
			valueCount,
			facts,
		).map((index) => addressAt(index, options));
	}
	function sampleValueAddresses(count: number): Address[] {
		return permutation(options.dataSeed ^ 0x56414c, count, 0, valueCount).map(
			(index) => addressAt(index, options),
		);
	}

	return {
		options,
		calibration,
		finalFactAt,
		events,
		measure,
		observed,
		sampleRowAddresses,
		sampleValueAddresses,
	};
}

/** Final-present addresses when the corpus has `facts` total addresses. */
export function presentCountFor(facts: number, valueRatio: number): number {
	const valueCount = valueCountOf(facts, valueRatio);
	return facts - finalAbsentCount(facts, valueCount);
}

/**
 * Choose the smallest `facts` so the corpus has EXACTLY `presentTarget`
 * final-present addresses (the ADR-0161 live-address count), or `null` when no
 * integer corpus is exact.
 *
 * `presentCountFor` is non-decreasing in `facts`, but a `valueCount = ceil(facts
 * * ratio)` jump reclassifies a boundary index (row to value), so the count can
 * step by more than one and skip a target. A fixed-point iteration cannot see
 * that and would return a false "exact" count; this binary-searches the smallest
 * `facts` whose present count reaches the target, then verifies equality and
 * refuses if the target was skipped.
 */
export function factsForPresentTarget(
	presentTarget: number,
	valueRatio: number,
): number | null {
	if (presentTarget <= 0) return presentTarget === 0 ? 0 : null;
	let lo = presentTarget;
	let hi = presentTarget + 64;
	while (presentCountFor(hi, valueRatio) < presentTarget) hi *= 2;
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (presentCountFor(mid, valueRatio) >= presentTarget) hi = mid;
		else lo = mid + 1;
	}
	return presentCountFor(lo, valueRatio) === presentTarget ? lo : null;
}

/**
 * One ordered SHA-256 over a fact sequence, framed by UTF-8 byte length so no
 * two records can concatenate into a third. Count and exact current-protocol
 * bytes accompany the digest; a candidate scan feeds `ORDER BY sequence` records
 * here and must reproduce all three.
 */
export function factSetDigest(facts: Iterable<Fact>): {
	count: number;
	bytes: number;
	digestHex: string;
} {
	const hasher = new Sha256Stream();
	let count = 0;
	let bytes = 0;
	for (const fact of facts) {
		const record = canonicalFactRecord(fact);
		const recordBytes = utf8Len(record);
		hasher.update(`${recordBytes}:${record}\n`);
		count += 1;
		bytes += recordBytes;
	}
	return { count, bytes, digestHex: hasher.digestHex() };
}

function gcd(a: number, b: number): number {
	let x = a;
	let y = b;
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}
