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
 * Canonical bytes are the ACTUAL V1 bytes: the kernel's RFC 8785 `canonicalize`
 * over the real Fact shape (structured address, `presence`, row `fields`, value
 * `content`). Correctness is checked against the oracle's three-part witness
 * (exact count, exact canonical bytes, and one ordered SHA-256 over facts in
 * ascending sequence), never against a layout's own read path.
 */
import { CryptoHasher } from 'bun';

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type Address =
	| { kind: 'row'; namespace: string; table: string; rowId: string }
	| { kind: 'value'; namespace: string; value: string };

/** A current fact: present carries a payload, absent is a tombstone or unset. */
export type Fact =
	| { address: Address; sequence: number; present: true; payload: JsonValue }
	| { address: Address; sequence: number; present: false };

export type TraceOptions = {
	facts: number;
	namespaceCount: number;
	tableCount: number;
	valueRatio: number;
	dataSeed: number;
	/** Exact final canonical logical byte target; row filler is calibrated to it. */
	targetFinalBytes: number;
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
};

/** The three-part correctness witness of a whole fact set. */
export type OracleWitness = {
	count: number;
	canonicalBytes: number;
	digestHex: string;
};

const SALT_NS = 0x4e53_5041;
const SALT_TABLE = 0x5442_4c45;

// Disjoint, ordered event bands; the final fact at an index is its highest band.
const BAND_PHASE0 = 0;
const BAND_REWRITE = 1;
const BAND_TOMBSTONE = 2;
const BAND_UNSET = 3;
const BAND_RESURRECT = 4;
const BAND_ACTIVATE = 5;

// Deterministic aging selectors (as closed-form congruences).
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

export function utf8Len(text: string): number {
	return Buffer.byteLength(text, 'utf8');
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
 * real Fact shape. Both the oracle and every candidate scan build this same
 * shape independently, so it is a true cross-check, not a shared helper.
 */
export function canonicalFactRecord(fact: Fact): string {
	const a = fact.address;
	const address =
		a.kind === 'row'
			? { kind: 'row', namespace: a.namespace, rowId: a.rowId, table: a.table }
			: { kind: 'value', namespace: a.namespace, value: a.value };
	if (!fact.present)
		return canonicalize({
			address,
			presence: 'absent',
			sequence: fact.sequence,
		});
	if (a.kind === 'row')
		return canonicalize({
			address,
			fields: fact.payload,
			presence: 'present',
			sequence: fact.sequence,
		});
	return canonicalize({
		address,
		content: fact.payload,
		presence: 'present',
		sequence: fact.sequence,
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

function valueCountOf(options: TraceOptions): number {
	return Math.max(1, Math.ceil(options.facts * options.valueRatio));
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
	const namespace = namespaceLabel(
		hash32(options.dataSeed ^ SALT_NS, index) % options.namespaceCount,
	);
	if (isValue(index, valueCountOf(options))) {
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

/** Events emitted in each band over [0, facts), for dense sequence math. */
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

/** Count of indices j < i that emit in `band`. */
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

/** Number of adjustable (present, non-tombstone) rows with index < i. */
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

/** Calibrated row-filler distribution: every adjustable row gets q, the first rem get q+1. */
type Calibration = {
	quotient: number;
	remainder: number;
	adjustableRows: number;
	baseBytes: number;
	achievedFinalBytes: number;
	qualifying: boolean;
};

export type Trace = {
	options: TraceOptions;
	calibration: Calibration;
	finalFactAt(index: number): Fact;
	events(): Generator<Fact>;
	oracleWitness(): OracleWitness;
	initialStateBytes(): number;
	observed(): ObservedCardinalities;
	sampleRowAddresses(count: number): Address[];
	sampleValueAddresses(count: number): Address[];
};

export function makeTrace(options: TraceOptions): Trace {
	const facts = options.facts;
	const valueCount = valueCountOf(options);
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

	function rowFields(
		index: number,
		phase: number,
		fillerLen: number,
	): JsonValue {
		return { body: 'x'.repeat(fillerLen), ordinal: index, phase };
	}

	function finalFactWith(index: number, fillerLen: number): Fact {
		const { band, present, phase } = finalBand(index, valueCount);
		const address = addressAt(index, options);
		const sequence = denseSequence(index, band);
		if (!present) return { address, sequence, present: false };
		const payload =
			address.kind === 'row'
				? rowFields(index, phase, fillerLen)
				: valueContent(index, phase);
		return { address, sequence, present: true, payload };
	}

	function calibrate(): Calibration {
		let baseBytes = 0;
		for (let index = 0; index < facts; index += 1) {
			baseBytes += utf8Len(canonicalFactRecord(finalFactWith(index, 0)));
		}
		const adjustableRows = adjustableRowsBelow(facts, valueCount);
		const delta = options.targetFinalBytes - baseBytes;
		if (adjustableRows <= 0 || delta < 0) {
			return {
				quotient: 0,
				remainder: 0,
				adjustableRows,
				baseBytes,
				achievedFinalBytes: baseBytes,
				qualifying: options.targetFinalBytes === baseBytes,
			};
		}
		const quotient = Math.floor(delta / adjustableRows);
		const remainder = delta - quotient * adjustableRows;
		return {
			quotient,
			remainder,
			adjustableRows,
			baseBytes,
			achievedFinalBytes: baseBytes + adjustableRows * quotient + remainder,
			qualifying: true,
		};
	}
	const calibration = calibrate();

	function fillerLenAt(index: number): number {
		if (!isAdjustableRow(index, valueCount)) return 0;
		const rank = adjustableRowsBelow(index, valueCount);
		return calibration.quotient + (rank < calibration.remainder ? 1 : 0);
	}

	function finalFactAt(index: number): Fact {
		return finalFactWith(index, fillerLenAt(index));
	}

	function* events(): Generator<Fact> {
		let sequence = 0;
		const emit = (index: number, phase: number, present: boolean): Fact => {
			sequence += 1;
			const address = addressAt(index, options);
			if (!present) return { address, sequence, present: false };
			const payload =
				address.kind === 'row'
					? rowFields(index, phase, fillerLenAt(index))
					: valueContent(index, phase);
			return { address, sequence, present: true, payload };
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

	/** Final facts in ascending final-sequence order (band-major over final band). */
	function* finalFactsBySequence(): Generator<Fact> {
		for (let band = 0; band <= BAND_ACTIVATE; band += 1) {
			for (let index = 0; index < facts; index += 1) {
				if (finalBand(index, valueCount).band === band)
					yield finalFactAt(index);
			}
		}
	}

	function oracleWitness(): OracleWitness {
		return factSetDigest(finalFactsBySequence());
	}

	function initialStateBytes(): number {
		let total = 0;
		for (let index = 0; index < facts; index += 1) {
			if (isInitialAbsent(index, valueCount)) continue;
			const address = addressAt(index, options);
			const payload =
				address.kind === 'row'
					? rowFields(index, 0, fillerLenAt(index))
					: valueContent(index, 0);
			const sequence = denseSequence(index, BAND_PHASE0);
			total += utf8Len(
				canonicalFactRecord({ address, sequence, present: true, payload }),
			);
		}
		return total;
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
		oracleWitness,
		initialStateBytes,
		observed,
		sampleRowAddresses,
		sampleValueAddresses,
	};
}

/**
 * One ordered SHA-256 over a fact sequence, with length-prefixed framing so no
 * two records can concatenate into a third. Count and exact canonical bytes
 * accompany the digest; a candidate scan feeds `ORDER BY sequence` records here
 * and must reproduce all three.
 */
export function factSetDigest(facts: Iterable<Fact>): OracleWitness {
	const hasher = new CryptoHasher('sha256');
	let count = 0;
	let bytes = 0;
	for (const fact of facts) {
		const record = canonicalFactRecord(fact);
		hasher.update(`${record.length}:${record}\n`);
		count += 1;
		bytes += utf8Len(record);
	}
	return { count, canonicalBytes: bytes, digestHex: hasher.digest('hex') };
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

// ---------------------------------------------------------------------------
// Self-test: a small in-memory fold, kept only for correctness assertions.
// ---------------------------------------------------------------------------

class SmokeOracle {
	private readonly current = new Map<string, Fact>();
	apply(fact: Fact): void {
		const key = addressKey(fact.address);
		const prior = this.current.get(key);
		if (prior === undefined) {
			this.current.set(key, fact);
			return;
		}
		if (fact.sequence < prior.sequence) return;
		if (fact.sequence === prior.sequence) {
			if (canonicalFactRecord(fact) !== canonicalFactRecord(prior))
				throw new Error('equal sequence, different content');
			return;
		}
		if (prior.address.kind === 'row' && !prior.present && fact.present) return;
		this.current.set(key, fact);
	}
	get(address: Address): Fact | undefined {
		return this.current.get(addressKey(address));
	}
}

/** Independent self-tests of the fold law and analytical/streamed agreement. */
export function traceSelfTest(): string[] {
	const failures: string[] = [];
	const rowA: Address = {
		kind: 'row',
		namespace: 'so.epicenter.ns00',
		table: 'collection0000',
		rowId: rowIdOf(1),
	};
	const valA: Address = {
		kind: 'value',
		namespace: 'so.epicenter.ns00',
		value: 'settingx',
	};

	const o1 = new SmokeOracle();
	o1.apply({ address: rowA, sequence: 1, present: true, payload: { a: 1 } });
	o1.apply({ address: rowA, sequence: 2, present: false });
	o1.apply({ address: rowA, sequence: 3, present: true, payload: { a: 2 } });
	if (o1.get(rowA)?.present !== false)
		failures.push('row tombstone was resurrected by a later present');

	const o2 = new SmokeOracle();
	o2.apply({ address: valA, sequence: 1, present: true, payload: 'a' });
	o2.apply({ address: valA, sequence: 2, present: false });
	o2.apply({ address: valA, sequence: 3, present: true, payload: 'b' });
	const v = o2.get(valA);
	if (!(v?.present === true && v.payload === 'b'))
		failures.push('value unset did not resurrect on a later present');

	const o3 = new SmokeOracle();
	o3.apply({ address: valA, sequence: 5, present: true, payload: 'new' });
	o3.apply({ address: valA, sequence: 3, present: true, payload: 'old' });
	if (o3.get(valA)?.sequence !== 5) failures.push('applied a stale sequence');
	let threw = false;
	try {
		o3.apply({ address: valA, sequence: 5, present: true, payload: 'other' });
	} catch {
		threw = true;
	}
	if (!threw) failures.push('accepted equal sequence with different content');

	// The analytical oracle must equal the map-fold over the same event stream,
	// including dense sequences and calibrated payloads.
	const trace = makeTrace({
		facts: 900,
		namespaceCount: 5,
		tableCount: 16,
		valueRatio: 0.1,
		dataSeed: 12345,
		targetFinalBytes: 900 * 120 + 777,
	});
	const folded = new SmokeOracle();
	let maxSeq = 0;
	const seenSeq = new Set<number>();
	for (const fact of trace.events()) {
		folded.apply(fact);
		if (seenSeq.has(fact.sequence)) failures.push('duplicate emitted sequence');
		seenSeq.add(fact.sequence);
		maxSeq = Math.max(maxSeq, fact.sequence);
	}
	if (seenSeq.size !== maxSeq)
		failures.push(
			`sequences are not dense: ${seenSeq.size} distinct, max ${maxSeq}`,
		);
	for (let index = 0; index < trace.options.facts; index += 1) {
		const analytical = trace.finalFactAt(index);
		const viaFold = folded.get(analytical.address);
		if (
			viaFold === undefined ||
			canonicalFactRecord(viaFold) !== canonicalFactRecord(analytical)
		) {
			failures.push(
				`analytical oracle disagreed with the fold at index ${index}`,
			);
			break;
		}
	}

	return failures;
}
