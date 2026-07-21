/**
 * Owner-specific auxiliary workload traces.
 *
 * The coordinate-layout decision (inline vs normalized structured addresses)
 * applies to every address-bearing owner table, not only confirmed facts, so the
 * spec forbids any universal owner recommendation while pending intents, sealed
 * submissions, parked rows, row-document liveness, and authority retry state are
 * absent from the workload. This module derives those five states deterministically
 * from the same canonical trace, hashes each for provenance, and binds every entry
 * that has a V1 wire shape to the private kernel parser. A layout candidate can
 * then populate the auxiliary tables under both coordinate encodings and be
 * measured on the full owner surface.
 *
 * Everything is a pure function of the trace, the validated limits, and bounded
 * counts: no wall clock, no SQLite, no Bun-specific hashing. The hashes are
 * streamed with the portable SHA-256 so they are reproducible in a browser too.
 */

import { parseAddress } from '../../../packages/data/src/protocol/v1/addresses.js';
import {
	canonicalize,
	utf8ByteLength,
} from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	type Intent,
	parseIntent,
} from '../../../packages/data/src/protocol/v1/intents.js';
import type { ValidatedLimits } from '../../../packages/data/src/protocol/v1/limits.js';
import {
	type ParkedIntent,
	parseSubmissionRequest,
	type SubmissionRequest,
} from '../../../packages/data/src/protocol/v1/operations.js';
import { Sha256Stream } from './portable-hash.js';
import type { Address, RowAddress, Trace } from './trace.js';

export type AuxiliaryKey =
	| 'pending'
	| 'sealed'
	| 'parked'
	| 'document'
	| 'retry';

export type AuxiliaryOwner = 'replica' | 'authority' | 'both';

/** One row-document liveness record: the row plus its baseline/tail byte sizes. */
export type DocumentEntry = {
	address: RowAddress;
	baselineBytes: number;
	tailBytes: number;
};

/** One authority retry-ledger record per replica. */
export type RetryEntry = {
	replicaId: string;
	lastSubmissionNumber: number;
	requestHashHex: string;
	parked: ParkedIntent[];
};

export type AuxiliaryTrace<T> = {
	key: AuxiliaryKey;
	owner: AuxiliaryOwner;
	entries: T[];
	/** Streaming SHA-256 over canonical, length-framed entries in stable order. */
	digestHex: string;
	count: number;
	/**
	 * True when every entry with a V1 wire shape admitted under the kernel parser.
	 * `document` and `retry` have no single wire shape, so their inner V1-shaped
	 * parts (parked results) are checked and other parts are hashed only.
	 */
	v1Bound: boolean;
};

export type AuxiliaryTraces = {
	pending: AuxiliaryTrace<Intent>;
	sealed: AuxiliaryTrace<SubmissionRequest>;
	parked: AuxiliaryTrace<ParkedIntent>;
	document: AuxiliaryTrace<DocumentEntry>;
	retry: AuxiliaryTrace<RetryEntry>;
};

export type AuxiliaryOptions = {
	/** Compacted pending intents (at most one per address). */
	pendingCount: number;
	/** Distinct addresses in the one sealed submission (bounded by maxSubmissionAddresses). */
	sealedIntentCount: number;
	/** Parked row entries. */
	parkedCount: number;
	/** Row-document liveness records. */
	documentCount: number;
	/** Replicas in the authority retry ledger. */
	replicaCount: number;
};

export const DEFAULT_AUXILIARY_OPTIONS: AuxiliaryOptions = {
	pendingCount: 256,
	sealedIntentCount: 64,
	parkedCount: 64,
	documentCount: 256,
	replicaCount: 8,
};

/** Deterministic 24-char lowercase-alphanumeric id from a seed and ordinal. */
function idOf(seed: number, ordinal: number): string {
	// Keep every step unsigned so base36 never emits a leading '-', and strip to
	// the [a-z0-9] grammar defensively before padding to exactly 24 characters.
	let h = (Math.imul(seed ^ 0x9e37_79b1, ordinal + 1) ^ 0x85eb_ca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b_3c6d) >>> 0;
	const raw = (
		h.toString(36) +
		(ordinal >>> 0).toString(36) +
		'replicaseed'
	).replace(/[^a-z0-9]/g, '');
	return raw.padEnd(24, '0').slice(0, 24);
}

/**
 * Whether a parked entry binds to the V1 contract: its address is admitted by the
 * kernel address parser, and its code/limit/measured fields satisfy exactly what
 * the authority's settlement admission enforces (`limitBytes` equals the ceiling,
 * `measuredBytes` strictly above it). This binds the address-bearing part through
 * the real kernel parser without pulling typebox into benchmark code.
 */
function parkedBinds(entry: ParkedIntent, limits: ValidatedLimits): boolean {
	const { error } = parseAddress(entry.address, limits);
	return (
		error === null &&
		entry.code === 'fact-too-large' &&
		entry.limitBytes === limits.maxEncodedFactBytes &&
		Number.isSafeInteger(entry.measuredBytes) &&
		entry.measuredBytes > entry.limitBytes
	);
}

/** Canonical, length-framed streaming hash over any JSON entries in order. */
function hashEntries(entries: readonly unknown[]): string {
	const hasher = new Sha256Stream();
	for (const entry of entries) {
		const record = canonicalize(entry);
		hasher.update(`${utf8ByteLength(record)}:${record}\n`);
	}
	return hasher.digestHex();
}

/** A deterministic row-present or row-absent / value-present or value-absent intent. */
function intentFor(address: Address, ordinal: number): Intent {
	if (address.kind === 'row') {
		if (ordinal % 4 === 3) return { address, presence: 'absent' };
		const fillerLen = 8 + (ordinal % 24);
		return {
			address,
			presence: 'present',
			set: { body: 'x'.repeat(fillerLen), ordinal, phase: 1 },
			unset: ordinal % 2 === 0 ? [] : ['note'],
		};
	}
	if (ordinal % 5 === 4) return { address, presence: 'absent' };
	const cls = ordinal % 3;
	const content = cls === 0 ? null : cls === 1 ? ordinal : `v${ordinal}`;
	return { address, presence: 'present', content };
}

function buildPending(
	trace: Trace,
	limits: ValidatedLimits,
	count: number,
): AuxiliaryTrace<Intent> {
	// Half row addresses, half value addresses, all distinct (the samplers guarantee it).
	const rows = trace.sampleRowAddresses(Math.ceil(count / 2));
	const values = trace.sampleValueAddresses(Math.floor(count / 2));
	const addresses = [...rows, ...values];
	const entries: Intent[] = [];
	let bound = true;
	addresses.forEach((address, ordinal) => {
		const intent = intentFor(address, ordinal);
		const { error } = parseIntent(intent, limits);
		if (error !== null) bound = false;
		entries.push(intent);
	});
	return {
		key: 'pending',
		owner: 'replica',
		entries,
		digestHex: hashEntries(entries),
		count: entries.length,
		v1Bound: bound,
	};
}

function buildSealed(
	trace: Trace,
	limits: ValidatedLimits,
	count: number,
): AuxiliaryTrace<SubmissionRequest> {
	const distinct = Math.min(count, limits.maxSubmissionAddresses);
	const rows = trace.sampleRowAddresses(Math.ceil(distinct / 2));
	const values = trace.sampleValueAddresses(Math.floor(distinct / 2));
	const intents = [...rows, ...values].map((address, ordinal) =>
		intentFor(address, ordinal),
	);
	const submission: SubmissionRequest = {
		authorityLifetime: `lifetime-${trace.options.dataSeed}`,
		replicaId: idOf(trace.options.dataSeed, 0),
		submissionNumber: 1,
		intents,
	};
	const { error } = parseSubmissionRequest(submission, limits);
	return {
		key: 'sealed',
		owner: 'replica',
		entries: [submission],
		digestHex: hashEntries([submission]),
		count: 1,
		v1Bound: error === null,
	};
}

function buildParked(
	trace: Trace,
	limits: ValidatedLimits,
	count: number,
): AuxiliaryTrace<ParkedIntent> {
	const rows = trace.sampleRowAddresses(count);
	const entries: ParkedIntent[] = [];
	let bound = true;
	rows.forEach((address, ordinal) => {
		if (address.kind !== 'row') return;
		const entry: ParkedIntent = {
			address,
			code: 'fact-too-large',
			// Admission requires limitBytes === the configured ceiling and
			// measuredBytes strictly above it.
			limitBytes: limits.maxEncodedFactBytes,
			measuredBytes: limits.maxEncodedFactBytes + ordinal + 1,
		};
		if (!parkedBinds(entry, limits)) bound = false;
		entries.push(entry);
	});
	return {
		key: 'parked',
		owner: 'both',
		entries,
		digestHex: hashEntries(entries),
		count: entries.length,
		v1Bound: bound,
	};
}

function buildDocument(
	trace: Trace,
	count: number,
): AuxiliaryTrace<DocumentEntry> {
	const rows = trace.sampleRowAddresses(count);
	const entries: DocumentEntry[] = [];
	for (const address of rows) {
		if (address.kind !== 'row') continue;
		// A compact gc:true baseline plus a bounded ordered tail; sizes vary
		// deterministically so the document table exercises a realistic byte spread.
		const seed = Number.parseInt(address.rowId.slice(-6), 36) || 0;
		entries.push({
			address,
			baselineBytes: 64 + (seed % 512),
			tailBytes: seed % 256,
		});
	}
	return {
		key: 'document',
		owner: 'both',
		entries,
		digestHex: hashEntries(entries),
		count: entries.length,
		v1Bound: true,
	};
}

function buildRetry(
	trace: Trace,
	limits: ValidatedLimits,
	replicaCount: number,
	parkedSource: readonly ParkedIntent[],
): AuxiliaryTrace<RetryEntry> {
	const entries: RetryEntry[] = [];
	let bound = true;
	for (let index = 0; index < replicaCount; index += 1) {
		const parked = parkedSource.slice(0, (index % 3) + 1);
		for (const p of parked) {
			if (!parkedBinds(p, limits)) bound = false;
		}
		entries.push({
			replicaId: idOf(trace.options.dataSeed, index + 1),
			lastSubmissionNumber: index + 1,
			// A server-private canonical request hash witness; the wire never carries it.
			requestHashHex: hashEntries([
				{
					replica: index,
					seed: trace.options.dataSeed,
					limit: limits.maxEncodedFactBytes,
				},
			]),
			parked,
		});
	}
	return {
		key: 'retry',
		owner: 'authority',
		entries,
		digestHex: hashEntries(entries),
		count: entries.length,
		v1Bound: bound,
	};
}

export function makeAuxiliaryTraces(
	trace: Trace,
	limits: ValidatedLimits,
	options: AuxiliaryOptions = DEFAULT_AUXILIARY_OPTIONS,
): AuxiliaryTraces {
	const parked = buildParked(trace, limits, options.parkedCount);
	return {
		pending: buildPending(trace, limits, options.pendingCount),
		sealed: buildSealed(trace, limits, options.sealedIntentCount),
		parked,
		document: buildDocument(trace, options.documentCount),
		retry: buildRetry(trace, limits, options.replicaCount, parked.entries),
	};
}

/** True when every auxiliary trace with V1-shaped entries bound to the kernel. */
export function allAuxiliaryBound(traces: AuxiliaryTraces): boolean {
	return (
		traces.pending.v1Bound &&
		traces.sealed.v1Bound &&
		traces.parked.v1Bound &&
		traces.document.v1Bound &&
		traces.retry.v1Bound
	);
}
