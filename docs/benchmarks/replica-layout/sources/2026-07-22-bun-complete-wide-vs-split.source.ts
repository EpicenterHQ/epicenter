#!/usr/bin/env bun

/**
 * ADR-0177 complete Bun wide-versus-split replica-layout evidence.
 *
 * This maintained benchmark extends the historical scalar layout run with the
 * complete scalar, document, and blob workload. Measured state transitions go
 * through the production stores. Direct SQL is limited to disclosed fixture
 * shortcuts and the three enumeration operations for which no store API exists.
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import {
	type AuthorityState,
	canonicalize,
	createAuthority,
	type Fact,
	type JsonValue,
	parseSubmissionRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
	submit,
	utf8ByteLength,
} from '../protocol/v1/index.js';
import { openReplicaStore, type ReplicaStore } from '../store/replica/index.js';
import {
	openSplitReplicaStore,
	type SplitReplicaStore,
} from '../store/replica-split/index.js';

type Candidate = 'wide' | 'split';
type Metric =
	| 'pointRead'
	| 'traversal'
	| 'traversalScalar'
	| 'laneWrite'
	| 'seal'
	| 'factInstall'
	| 'docAppend'
	| 'docDrainScan'
	| 'blobDrainScan'
	| 'tombstoneCleanup'
	| 'reopen';
type Store = ReplicaStore | SplitReplicaStore;
type StatementKind = 'run' | 'all';

type Profile = {
	records: number;
	proxyBytes: number;
	repetitions: number;
	pointBatches: number;
	traversals: number;
	laneBatches: number;
	sealBatches: number;
	factPages: number;
	docAppendBatches: number;
	drainScans: number;
	tombstonePages: number;
	reopenSamples: number;
	batchSize: number;
	parkedIntents: number;
};

type Options = Profile & {
	profile: 'smoke' | 'full';
	order: 'wide-first' | 'split-first';
	commit: string;
	output?: string;
};

type Summary = {
	raw: number[];
	p50: number;
	p95: number;
	minimum: number;
	maximum: number;
};

type MetricResult = {
	timingMs: Summary;
	statements: Record<StatementKind, Summary>;
};

type StatementObservation = {
	sql: string;
	parameters: readonly SqliteValue[];
};

type QueryPlan = {
	sql: string;
	detail: string[];
};

type CounterState = {
	activeMetric?: Metric;
	counts: Record<StatementKind, number>;
	observations: Map<Metric, Map<string, StatementObservation>>;
};

type CandidateRun = {
	candidate: Candidate;
	repetition: number;
	metrics: Record<Metric, MetricResult>;
	storage: {
		pageSize: number;
		pageCount: number;
		freelistCount: number;
		liveBytes: number;
		fileBytes: number;
	};
	integrityCheck: string;
	relationCountsAfterReopen: Record<string, number>;
	queryPlans: Record<Metric, QueryPlan[]>;
};

const MIB = 1024 * 1024;
const FULL_PROXY_BYTES = 512 * MIB;
const FULL_RECORDS = 1_000_000;
const NAMESPACE_COUNT = 25;
const COLLECTION_COUNT = 40;
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const AUTHORITY_LIFETIME = 'lifetime-one';
const METRICS: readonly Metric[] = [
	'pointRead',
	'traversal',
	'traversalScalar',
	'laneWrite',
	'seal',
	'factInstall',
	'docAppend',
	'docDrainScan',
	'blobDrainScan',
	'tombstoneCleanup',
	'reopen',
];

const PROFILES: Record<'smoke' | 'full', Profile> = {
	smoke: {
		records: 5_000,
		proxyBytes: MIB,
		repetitions: 1,
		pointBatches: 4,
		traversals: 3,
		laneBatches: 2,
		sealBatches: 2,
		factPages: 2,
		docAppendBatches: 2,
		drainScans: 3,
		tombstonePages: 1,
		reopenSamples: 2,
		batchSize: 16,
		parkedIntents: 5,
	},
	full: {
		records: FULL_RECORDS,
		proxyBytes: FULL_PROXY_BYTES,
		repetitions: 3,
		pointBatches: 32,
		traversals: 12,
		laneBatches: 16,
		sealBatches: 8,
		factPages: 8,
		docAppendBatches: 16,
		drainScans: 8,
		tombstonePages: 4,
		reopenSamples: 4,
		batchSize: 64,
		parkedIntents: 1_000,
	},
};

const HELP = `
Usage:
  bun packages/data/src/__benchmarks__/replica-layout-complete.bench.ts \\
    --profile smoke|full --order wide-first|split-first --commit <hash> \\
    [--output report.json]

The full profile creates exactly 1,000,000 final-present records whose V1
proxy totals exactly 536,870,912 bytes. Temporary databases are always removed.
`.trim();

function parseOptions(args: string[]): Options | null {
	if (args.includes('--help')) return null;
	let profile: 'smoke' | 'full' | undefined;
	let order: 'wide-first' | 'split-first' | undefined;
	let commit: string | undefined;
	let output: string | undefined;
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (value === undefined) throw new Error(`${flag} requires a value`);
		switch (flag) {
			case '--profile':
				if (value !== 'smoke' && value !== 'full') {
					throw new Error('--profile must be smoke or full');
				}
				profile = value;
				break;
			case '--order':
				if (value !== 'wide-first' && value !== 'split-first') {
					throw new Error('--order must be wide-first or split-first');
				}
				order = value;
				break;
			case '--commit':
				commit = value;
				break;
			case '--output':
				output = value;
				break;
			default:
				throw new Error(`unknown option ${flag}`);
		}
	}
	if (profile === undefined) throw new Error('--profile is required');
	if (order === undefined) throw new Error('--order is required');
	if (commit === undefined || commit.length === 0) {
		throw new Error('--commit is required');
	}
	return {
		profile,
		order,
		commit,
		...PROFILES[profile],
		...(output === undefined ? {} : { output }),
	};
}

/** Exact V1 proxy fixture generator retained from replica-layout.bench.ts. */
function addressAt(index: number): RecordAddress {
	const namespace = `so.epicenter.fixture${String(index % NAMESPACE_COUNT).padStart(2, '0')}`;
	if (index % 100 === 0) {
		return {
			namespace,
			collection: 'settings',
			recordKey: `value${index}`,
		};
	}
	return {
		namespace,
		collection: `records${String(Math.floor(index / NAMESPACE_COUNT) % COLLECTION_COUNT).padStart(2, '0')}`,
		recordKey: index.toString(36).padStart(24, '0'),
	};
}

function payloadAt(index: number, fillerBytes: number): JsonValue {
	const filler = 'x'.repeat(fillerBytes);
	return index % 100 === 0 ? filler : { body: filler };
}

function proxyBytes(address: RecordAddress, payload: JsonValue): number {
	return utf8ByteLength(canonicalize({ address, payload }));
}

function fixtureShape(options: Options) {
	let emptyProxyBytes = 0;
	for (let index = 0; index < options.records; index += 1) {
		emptyProxyBytes += proxyBytes(addressAt(index), payloadAt(index, 0));
	}
	const fillerBytes = options.proxyBytes - emptyProxyBytes;
	if (fillerBytes < 0) {
		throw new Error(
			`proxy target ${options.proxyBytes} is below empty fixture ${emptyProxyBytes}`,
		);
	}
	return {
		baseFillerBytes: Math.floor(fillerBytes / options.records),
		extraFillerRecords: fillerBytes % options.records,
		emptyProxyBytes,
	};
}

function recordAt(
	index: number,
	shape: ReturnType<typeof fixtureShape>,
): { address: RecordAddress; payload: string; proxyBytes: number } {
	const address = addressAt(index);
	const payloadValue = payloadAt(
		index,
		shape.baseFillerBytes + (index < shape.extraFillerRecords ? 1 : 0),
	);
	return {
		address,
		payload: canonicalize(payloadValue),
		proxyBytes: proxyBytes(address, payloadValue),
	};
}

function configure(database: Database): void {
	database.exec('PRAGMA journal_mode = WAL');
	database.exec('PRAGMA synchronous = NORMAL');
	database.exec('PRAGMA temp_store = MEMORY');
	database.exec('PRAGMA cache_size = -16384');
	database.exec('PRAGMA wal_autocheckpoint = 1000');
}

function directRun(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[] = [],
): void {
	database.run(sql, parameters as SQLQueryBindings[]);
}

function directAll<TRow extends SqliteRow>(
	database: Database,
	sql: string,
	parameters: readonly SqliteValue[] = [],
): TRow[] {
	return database
		.query<TRow, SQLQueryBindings[]>(sql)
		.all(...(parameters as SQLQueryBindings[]));
}

function createCounterState(): CounterState {
	return {
		counts: { run: 0, all: 0 },
		observations: new Map(),
	};
}

function observe(
	state: CounterState,
	kind: StatementKind,
	sql: string,
	parameters: readonly SqliteValue[],
): void {
	const metric = state.activeMetric;
	if (metric === undefined) return;
	state.counts[kind] += 1;
	let metricObservations = state.observations.get(metric);
	if (metricObservations === undefined) {
		metricObservations = new Map();
		state.observations.set(metric, metricObservations);
	}
	if (!metricObservations.has(sql)) {
		metricObservations.set(sql, { sql, parameters: [...parameters] });
	}
}

function countingAdapter(
	database: Database,
	state: CounterState,
): SqliteDatabase {
	return {
		run(sql, parameters = []): void {
			observe(state, 'run', sql, parameters);
			directRun(database, sql, parameters);
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			observe(state, 'all', sql, parameters);
			return directAll<TRow>(database, sql, parameters);
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
	};
}

function openStore(
	candidate: Candidate,
	database: SqliteDatabase,
	initialize = false,
): Store {
	const options = {
		database,
		limits: SCALAR_SYNC_V1_LIMITS,
		...(initialize
			? {
					initialize: {
						replicaId: REPLICA_ID,
						authorityLifetime: AUTHORITY_LIFETIME,
					},
				}
			: {}),
	};
	return candidate === 'wide'
		? openReplicaStore(options)
		: openSplitReplicaStore(options);
}

function seedConfirmed(
	database: Database,
	candidate: Candidate,
	options: Options,
	shape: ReturnType<typeof fixtureShape>,
): number {
	const statement =
		candidate === 'wide'
			? database.prepare(
					`INSERT INTO records (
						namespace, collection, record_key,
						confirmed_state, confirmed_payload, confirmed_sequence
					) VALUES (?, ?, ?, 'live', ?, ?)`,
				)
			: database.prepare(
					`INSERT INTO confirmed_records (
						namespace, collection, record_key, state, payload, sequence
					) VALUES (?, ?, ?, 'live', ?, ?)`,
				);
	let observedProxyBytes = 0;
	const insertBatch = database.transaction((start: number, end: number) => {
		for (let index = start; index < end; index += 1) {
			const record = recordAt(index, shape);
			statement.run(
				record.address.namespace,
				record.address.collection,
				record.address.recordKey,
				record.payload,
				index + 1,
			);
			observedProxyBytes += record.proxyBytes;
		}
	});
	for (let start = 0; start < options.records; start += 5_000) {
		insertBatch(start, Math.min(options.records, start + 5_000));
	}
	directRun(
		database,
		'UPDATE meta SET after_sequence = ? WHERE singleton = 1',
		[options.records],
	);
	return observedProxyBytes;
}

function deterministicDocumentUpdates(
	index: number,
	count: 1 | 2,
): Uint8Array[] {
	const document = new Y.Doc({ gc: true, guid: `fixture-${index}` });
	document.clientID = index + 1;
	const text = document.get('content');
	const updates: Uint8Array[] = [];
	try {
		text.insert(0, `record-${index}`);
		updates.push(new Uint8Array(Y.encodeStateAsUpdateV2(document)));
		if (count === 2) {
			const stateVector = Y.encodeStateVector(document);
			text.insert(text.length, '-tail');
			updates.push(
				new Uint8Array(Y.encodeStateAsUpdateV2(document, stateVector)),
			);
		}
		return updates;
	} finally {
		document.destroy();
	}
}

function seedDocuments(store: Store, options: Options): void {
	for (let index = 0; index < options.records; index += 20) {
		const updates = deterministicDocumentUpdates(
			index,
			index % 200 === 0 ? 2 : 1,
		);
		for (const update of updates) {
			store.appendLocalDocumentUpdate(addressAt(index), update);
		}
	}
}

function seedBlobs(
	database: Database,
	candidate: Candidate,
	options: Options,
): void {
	const statement =
		candidate === 'wide'
			? database.prepare(
					`UPDATE records SET blob_sha256 = ?, blob_pending = ?, blob_parked_code = ?
					WHERE namespace = ? AND collection = ? AND record_key = ?`,
				)
			: database.prepare(
					`INSERT INTO blob_state (
						namespace, collection, record_key, sha256, pending, parked_code
					) VALUES (?, ?, ?, ?, ?, ?)`,
				);
	const batch = database.transaction(() => {
		for (let index = 0; index < options.records; index += 25) {
			const address = addressAt(index);
			const digest = sha256(String(index));
			const pending = (index / 25) % 2 === 0 ? 1 : 0;
			const parked = index % 400 === 0 ? 'blob-conflict' : null;
			if (candidate === 'wide') {
				statement.run(
					digest,
					pending,
					parked,
					address.namespace,
					address.collection,
					address.recordKey,
				);
			} else {
				statement.run(
					address.namespace,
					address.collection,
					address.recordKey,
					digest,
					pending,
					parked,
				);
			}
		}
	});
	batch();
}

function seedPendingIntents(store: Store, options: Options): void {
	for (let index = 0; index < options.records; index += 50) {
		store.localWrite({
			address: addressAt(index),
			op: 'patch',
			set: { note: 'x' },
			unset: [],
		});
	}
}

function seedParkedIntents(
	database: Database,
	candidate: Candidate,
	options: Options,
): void {
	const parkedArgs = canonicalize({ set: { parked: true }, unset: [] });
	const statement =
		candidate === 'wide'
			? database.prepare(
					`UPDATE records SET
						parked_op = 'patch', parked_args = ?, parked_code = 'fact-too-large',
						parked_measured = 5000, parked_limit = 4096
					WHERE namespace = ? AND collection = ? AND record_key = ?`,
				)
			: database.prepare(
					`INSERT INTO local_intents (
						namespace, collection, record_key,
						parked_op, parked_args, parked_code, parked_measured, parked_limit
					) VALUES (?, ?, ?, 'patch', ?, 'fact-too-large', 5000, 4096)`,
				);
	const batch = database.transaction(() => {
		for (let offset = 0; offset < options.parkedIntents; offset += 1) {
			const index = offset * 50 + 1;
			const address = addressAt(index);
			if (candidate === 'wide') {
				statement.run(
					parkedArgs,
					address.namespace,
					address.collection,
					address.recordKey,
				);
			} else {
				statement.run(
					address.namespace,
					address.collection,
					address.recordKey,
					parkedArgs,
				);
			}
		}
	});
	batch();
}

function seedDocumentInflight(store: Store, options: Options): void {
	for (let index = 0; index < options.records; index += 400) {
		const publication = store.documentPublication(addressAt(index));
		if (publication.kind !== 'ready') {
			throw new Error('fixture document publication did not freeze an image');
		}
	}
}

function seedCompleteFixture(
	database: Database,
	candidate: Candidate,
	store: Store,
	options: Options,
	shape: ReturnType<typeof fixtureShape>,
): void {
	const observedProxyBytes = seedConfirmed(database, candidate, options, shape);
	if (observedProxyBytes !== options.proxyBytes) {
		throw new Error(
			`proxy mismatch: expected ${options.proxyBytes}, got ${observedProxyBytes}`,
		);
	}
	seedDocuments(store, options);
	seedBlobs(database, candidate, options);
	seedPendingIntents(store, options);
	seedParkedIntents(database, candidate, options);
	seedDocumentInflight(store, options);
}

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function summarize(raw: number[]): Summary {
	return {
		raw,
		p50: percentile(raw, 0.5),
		p95: percentile(raw, 0.95),
		minimum: Math.min(...raw),
		maximum: Math.max(...raw),
	};
}

function emptyMetricSamples(): Record<
	Metric,
	{ timingMs: number[]; run: number[]; all: number[] }
> {
	const samples = {} as Record<
		Metric,
		{ timingMs: number[]; run: number[]; all: number[] }
	>;
	for (const metric of METRICS) {
		samples[metric] = { timingMs: [], run: [], all: [] };
	}
	return samples;
}

function measure<TResult>(
	metric: Metric,
	state: CounterState,
	samples: ReturnType<typeof emptyMetricSamples>,
	work: () => TResult,
	unitDivisor = 1,
): TResult {
	const beforeRun = state.counts.run;
	const beforeAll = state.counts.all;
	state.activeMetric = metric;
	const started = performance.now();
	try {
		return work();
	} finally {
		const elapsed = performance.now() - started;
		state.activeMetric = undefined;
		samples[metric].timingMs.push(elapsed / unitDivisor);
		samples[metric].run.push(state.counts.run - beforeRun);
		samples[metric].all.push(state.counts.all - beforeAll);
	}
}

function mixedPointIndex(
	sample: number,
	offset: number,
	records: number,
): number {
	const ordinal = sample * 64 + offset;
	switch (offset % 4) {
		case 0:
			return (ordinal * 100 + 3) % records;
		case 1:
			return (ordinal * 50) % records;
		case 2:
			return (ordinal * 100 + 20) % records;
		case 3:
			return (ordinal * 50 + 25) % records;
		default:
			throw new Error('unreachable mixed point category');
	}
}

function traversalSql(candidate: Candidate): string {
	return candidate === 'wide'
		? `SELECT record_key, confirmed_state, confirmed_payload, confirmed_sequence,
			sealed_op, sealed_args, pending_op, pending_args,
			parked_op, parked_args, parked_code, parked_measured, parked_limit,
			doc_revision, doc_dirty, blob_sha256, blob_pending, blob_parked_code
		FROM records WHERE namespace = ? AND collection = ? ORDER BY record_key`
		: `WITH address AS (
			SELECT namespace, collection, record_key FROM confirmed_records
			WHERE namespace = ? AND collection = ?
			UNION SELECT namespace, collection, record_key FROM local_intents
			WHERE namespace = ? AND collection = ?
			UNION SELECT namespace, collection, record_key FROM record_documents
			WHERE namespace = ? AND collection = ?
			UNION SELECT namespace, collection, record_key FROM blob_state
			WHERE namespace = ? AND collection = ?
		)
		SELECT a.record_key, c.state, c.payload, c.sequence,
			i.sealed_op, i.sealed_args, i.pending_op, i.pending_args,
			i.parked_op, i.parked_args, i.parked_code,
			i.parked_measured, i.parked_limit,
			d.revision, d.dirty, b.sha256, b.pending, b.parked_code AS blob_parked_code
		FROM address a
		LEFT JOIN confirmed_records c USING (namespace, collection, record_key)
		LEFT JOIN local_intents i USING (namespace, collection, record_key)
		LEFT JOIN record_documents d USING (namespace, collection, record_key)
		LEFT JOIN blob_state b USING (namespace, collection, record_key)
		ORDER BY a.record_key`;
}

function traversalParameters(
	candidate: Candidate,
	address: RecordAddress,
): readonly string[] {
	return candidate === 'wide'
		? [address.namespace, address.collection]
		: Array.from({ length: 4 }, () => [
				address.namespace,
				address.collection,
			]).flat();
}

/**
 * The scalar-lane traversal continuous with the earlier scalar-only run: it
 * projects only confirmed and local scalar lanes, so it tests whether the
 * split candidate's measured traversal win survives while the document and
 * blob relations exist but stay unjoined.
 */
function traversalScalarSql(candidate: Candidate): string {
	return candidate === 'wide'
		? `SELECT record_key, confirmed_state, confirmed_payload, confirmed_sequence,
			sealed_op, sealed_args, pending_op, pending_args,
			parked_op, parked_args, parked_code, parked_measured, parked_limit
		FROM records WHERE namespace = ? AND collection = ? ORDER BY record_key`
		: `WITH address AS (
			SELECT namespace, collection, record_key FROM confirmed_records
			WHERE namespace = ? AND collection = ?
			UNION SELECT namespace, collection, record_key FROM local_intents
			WHERE namespace = ? AND collection = ?
		)
		SELECT a.record_key, c.state, c.payload, c.sequence,
			i.sealed_op, i.sealed_args, i.pending_op, i.pending_args,
			i.parked_op, i.parked_args, i.parked_code,
			i.parked_measured, i.parked_limit
		FROM address a
		LEFT JOIN confirmed_records c USING (namespace, collection, record_key)
		LEFT JOIN local_intents i USING (namespace, collection, record_key)
		ORDER BY a.record_key`;
}

function traversalScalarParameters(
	candidate: Candidate,
	address: RecordAddress,
): readonly string[] {
	return candidate === 'wide'
		? [address.namespace, address.collection]
		: Array.from({ length: 2 }, () => [
				address.namespace,
				address.collection,
			]).flat();
}

function docDrainSql(candidate: Candidate): string {
	return candidate === 'wide'
		? `SELECT namespace, collection, record_key, doc_revision
			FROM records WHERE doc_dirty = 1
			ORDER BY namespace, collection, record_key`
		: `SELECT namespace, collection, record_key, revision
			FROM record_documents WHERE dirty = 1
			ORDER BY namespace, collection, record_key`;
}

function blobDrainSql(candidate: Candidate): string {
	return candidate === 'wide'
		? `SELECT namespace, collection, record_key, blob_sha256
			FROM records WHERE blob_pending = 1
			ORDER BY namespace, collection, record_key`
		: `SELECT namespace, collection, record_key, sha256
			FROM blob_state WHERE pending = 1
			ORDER BY namespace, collection, record_key`;
}

function freshAddress(kind: string, ordinal: number): RecordAddress {
	return {
		namespace: 'so.epicenter.benchmark',
		collection: kind.replaceAll('-', '_'),
		recordKey: ordinal.toString(36).padStart(24, '0'),
	};
}

function unwrapResult<TResult>(result: {
	data: TResult | null;
	error: { message: string } | null;
}): TResult {
	if (result.error !== null) throw new Error(result.error.message);
	if (result.data === null) throw new Error('successful result has no data');
	return result.data;
}

function settleSeal(
	store: Store,
	sealedBytes: string,
	authority: AuthorityState,
): AuthorityState {
	const request = unwrapResult(
		parseSubmissionRequest(JSON.parse(sealedBytes), SCALAR_SYNC_V1_LIMITS),
	);
	const outcome = unwrapResult(
		submit(authority, request, SCALAR_SYNC_V1_LIMITS),
	);
	store.settle(outcome.response);
	return outcome.state;
}

function factsPage(
	store: Store,
	facts: Fact[],
	requestAfterSequence: number,
): void {
	store.installFacts({
		request: {
			authorityLifetime: AUTHORITY_LIFETIME,
			afterSequence: requestAfterSequence,
		},
		response: {
			authorityLifetime: AUTHORITY_LIFETIME,
			facts,
			hasMore: false,
		},
	});
}

function planFor(
	database: Database,
	observation: StatementObservation,
): QueryPlan {
	const rows = database
		.query<{ detail: string }, SQLQueryBindings[]>(
			`EXPLAIN QUERY PLAN ${observation.sql}`,
		)
		.all(...(observation.parameters as SQLQueryBindings[]));
	return { sql: observation.sql, detail: rows.map((row) => row.detail) };
}

function queryPlans(
	database: Database,
	state: CounterState,
): Record<Metric, QueryPlan[]> {
	return Object.fromEntries(
		METRICS.map((metric) => [
			metric,
			[...(state.observations.get(metric)?.values() ?? [])].map((observation) =>
				planFor(database, observation),
			),
		]),
	) as Record<Metric, QueryPlan[]>;
}

function fileBytes(path: string): number {
	return [path, `${path}-wal`, `${path}-shm`].reduce((total, candidate) => {
		try {
			return total + statSync(candidate).size;
		} catch {
			return total;
		}
	}, 0);
}

function tableNames(database: Database): string[] {
	return database
		.query<{ name: string }, []>(
			`SELECT name FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
		)
		.all()
		.map((row) => row.name);
}

function relationCounts(database: Database): Record<string, number> {
	return Object.fromEntries(
		tableNames(database).map((table) => {
			const count = database
				.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
				.get()?.count;
			return [table, count ?? 0];
		}),
	);
}

function runCandidate(
	candidate: Candidate,
	repetition: number,
	options: Options,
	shape: ReturnType<typeof fixtureShape>,
): CandidateRun {
	const directory = mkdtempSync(
		join(tmpdir(), `epicenter-complete-${candidate}-`),
	);
	const path = join(directory, 'replica.sqlite');
	let database: Database | undefined;
	try {
		database = new Database(path, { create: true, strict: true });
		configure(database);
		const counters = createCounterState();
		let adapter = countingAdapter(database, counters);
		let store = openStore(candidate, adapter, true);
		seedCompleteFixture(database, candidate, store, options, shape);
		const samples = emptyMetricSamples();

		for (let sample = 0; sample < options.pointBatches; sample += 1) {
			measure(
				'pointRead',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < options.batchSize; offset += 1) {
						const index = mixedPointIndex(sample, offset, options.records);
						if (store.record(addressAt(index)) === null) {
							throw new Error('point read missed a fixture record');
						}
					}
				},
				options.batchSize,
			);
		}

		const traversal = traversalSql(candidate);
		for (let sample = 0; sample < options.traversals; sample += 1) {
			const probe = addressAt(1 + sample * NAMESPACE_COUNT);
			measure('traversal', counters, samples, () => {
				const rows = adapter.all(
					traversal,
					traversalParameters(candidate, probe),
				);
				if (rows.length === 0) throw new Error('traversal returned no records');
			});
		}

		const traversalScalar = traversalScalarSql(candidate);
		for (let sample = 0; sample < options.traversals; sample += 1) {
			const probe = addressAt(1 + sample * NAMESPACE_COUNT);
			measure('traversalScalar', counters, samples, () => {
				const rows = adapter.all(
					traversalScalar,
					traversalScalarParameters(candidate, probe),
				);
				if (rows.length === 0) {
					throw new Error('scalar traversal returned no records');
				}
			});
		}

		for (let sample = 0; sample < options.laneBatches; sample += 1) {
			measure(
				'laneWrite',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < options.batchSize; offset += 1) {
						const address =
							offset % 2 === 0
								? addressAt(
										((sample * options.batchSize + offset) * 65_537 + 3) %
											options.records,
									)
								: freshAddress(
										'lane-write',
										sample * options.batchSize + offset,
									);
						store.localWrite({
							address,
							op: 'patch',
							set: { lane: sample * options.batchSize + offset },
							unset: [],
						});
					}
				},
				options.batchSize,
			);
		}

		const initialAuthority = unwrapResult(
			createAuthority(AUTHORITY_LIFETIME, SCALAR_SYNC_V1_LIMITS),
		);
		let authority: AuthorityState = {
			...initialAuthority,
			nextSequence: options.records + 1,
		};
		for (let sample = 0; sample < options.sealBatches; sample += 1) {
			for (let offset = 0; offset < 64; offset += 1) {
				store.localWrite({
					address: freshAddress('seal', sample * 64 + offset),
					op: 'replace',
					value: { sealed: sample * 64 + offset },
				});
			}
			const sealed = measure('seal', counters, samples, () => store.seal());
			const parsed = JSON.parse(sealed.bytes) as { intents: unknown[] };
			if (parsed.intents.length !== 64) {
				throw new Error(`seal admitted ${parsed.intents.length}, expected 64`);
			}
			authority = settleSeal(store, sealed.bytes, authority);
		}

		let nextFactSequence = authority.nextSequence;
		for (let sample = 0; sample < options.factPages; sample += 1) {
			const requestAfterSequence = store.sync().afterSequence;
			const facts: Fact[] = [];
			for (let offset = 0; offset < 64; offset += 1) {
				const ordinal = sample * 64 + offset;
				const address =
					offset % 2 === 0
						? addressAt((ordinal * 104_729 + 7) % options.records)
						: freshAddress('fact-install', ordinal);
				facts.push({
					address,
					sequence: nextFactSequence,
					state: 'live',
					payload: { installed: ordinal },
				});
				nextFactSequence += 1;
			}
			measure('factInstall', counters, samples, () =>
				factsPage(store, facts, requestAfterSequence),
			);
		}

		for (let sample = 0; sample < options.docAppendBatches; sample += 1) {
			const batch = Math.min(
				options.batchSize,
				Math.floor(options.records / 20),
			);
			measure(
				'docAppend',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < batch; offset += 1) {
						const documentOrdinal =
							(sample * batch + offset + 1_001) %
							Math.floor(options.records / 20);
						const index = documentOrdinal * 20;
						const update = deterministicDocumentUpdates(
							options.records + sample * batch + offset,
							1,
						)[0];
						if (update === undefined)
							throw new Error('missing document update');
						store.appendLocalDocumentUpdate(addressAt(index), update);
					}
				},
				batch,
			);
		}

		const documentDrain = docDrainSql(candidate);
		for (let sample = 0; sample < options.drainScans; sample += 1) {
			measure('docDrainScan', counters, samples, () => {
				if (adapter.all(documentDrain).length === 0) {
					throw new Error('document drain scan returned no obligations');
				}
			});
		}

		const blobDrain = blobDrainSql(candidate);
		for (let sample = 0; sample < options.drainScans; sample += 1) {
			measure('blobDrainScan', counters, samples, () => {
				if (adapter.all(blobDrain).length === 0) {
					throw new Error('blob drain scan returned no obligations');
				}
			});
		}

		const tombstoneCandidates = Array.from(
			{ length: Math.floor((options.records - 1) / 100) + 1 },
			(_, ordinal) => ordinal * 100,
		).reverse();
		let tombstoneOffset = 0;
		for (let sample = 0; sample < options.tombstonePages; sample += 1) {
			const count = Math.min(
				64,
				options.batchSize,
				tombstoneCandidates.length - tombstoneOffset,
			);
			if (count <= 0) break;
			const facts: Fact[] = [];
			for (let offset = 0; offset < count; offset += 1) {
				const index = tombstoneCandidates[tombstoneOffset + offset];
				if (index === undefined) throw new Error('missing tombstone candidate');
				const address = addressAt(index);
				store.localWrite({
					address,
					op: 'patch',
					set: { tombstonePreparation: true },
					unset: [],
				});
				facts.push({
					address,
					sequence: nextFactSequence,
					state: 'tombstone',
				});
				nextFactSequence += 1;
			}
			tombstoneOffset += count;
			const requestAfterSequence = store.sync().afterSequence;
			measure('tombstoneCleanup', counters, samples, () =>
				factsPage(store, facts, requestAfterSequence),
			);
		}

		for (let sample = 0; sample < options.reopenSamples; sample += 1) {
			measure('reopen', counters, samples, () => {
				database?.close();
				database = new Database(path, { strict: true });
				configure(database);
				adapter = countingAdapter(database, counters);
				store = openStore(candidate, adapter);
				if (
					store.record(addressAt((sample * 7_919 + 3) % options.records)) ===
					null
				) {
					throw new Error('reopen point read missed');
				}
			});
		}

		database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		const integrityCheck = database
			.query<{ integrity_check: string }, []>('PRAGMA integrity_check')
			.get()?.integrity_check;
		if (integrityCheck !== 'ok') {
			throw new Error(`integrity check: ${integrityCheck}`);
		}
		const pageSize =
			database.query<{ page_size: number }, []>('PRAGMA page_size').get()
				?.page_size ?? 0;
		const pageCount =
			database.query<{ page_count: number }, []>('PRAGMA page_count').get()
				?.page_count ?? 0;
		const freelistCount =
			database
				.query<{ freelist_count: number }, []>('PRAGMA freelist_count')
				.get()?.freelist_count ?? 0;
		const plans = queryPlans(database, counters);
		const counts = relationCounts(database);
		database.close();
		database = undefined;

		return {
			candidate,
			repetition,
			metrics: Object.fromEntries(
				METRICS.map((metric) => [
					metric,
					{
						timingMs: summarize(samples[metric].timingMs),
						statements: {
							run: summarize(samples[metric].run),
							all: summarize(samples[metric].all),
						},
					},
				]),
			) as Record<Metric, MetricResult>,
			storage: {
				pageSize,
				pageCount,
				freelistCount,
				liveBytes: (pageCount - freelistCount) * pageSize,
				fileBytes: fileBytes(path),
			},
			integrityCheck,
			relationCountsAfterReopen: counts,
			queryPlans: plans,
		};
	} finally {
		database?.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

function installedSchemaSha256(candidate: Candidate): string {
	const database = new Database(':memory:', { strict: true });
	try {
		openStore(candidate, createBunSqliteAdapter(database), true);
		const objects = database
			.query<
				{ name: string; sql: string | null; tableName: string; type: string },
				[]
			>(
				`SELECT type, name, tbl_name AS tableName, sql
				FROM sqlite_schema
				WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
				ORDER BY type, name`,
			)
			.all();
		return sha256(JSON.stringify(objects));
	} finally {
		database.close();
	}
}

function aggregate(runs: CandidateRun[]) {
	return {
		metrics: Object.fromEntries(
			METRICS.map((metric) => [
				metric,
				Object.fromEntries(
					(['wide', 'split'] as const).map((candidate) => {
						const raw = runs
							.filter((run) => run.candidate === candidate)
							.flatMap((run) => run.metrics[metric].timingMs.raw);
						return [candidate, summarize(raw)];
					}),
				),
			]),
		),
	};
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function candidateOrder(
	first: Options['order'],
	repetition: number,
): Candidate[] {
	const base: Candidate[] =
		first === 'wide-first' ? ['wide', 'split'] : ['split', 'wide'];
	return repetition % 2 === 0 ? base : [...base].reverse();
}

function main(): void {
	const options = parseOptions(process.argv.slice(2));
	if (options === null) {
		console.log(HELP);
		return;
	}
	const startedAt = new Date().toISOString();
	const shape = fixtureShape(options);
	const runs: CandidateRun[] = [];
	for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
		for (const candidate of candidateOrder(options.order, repetition)) {
			console.error(
				`running ${candidate} repetition ${repetition + 1}/${options.repetitions}`,
			);
			runs.push(runCandidate(candidate, repetition, options, shape));
		}
	}

	const runtimeDatabase = new Database(':memory:');
	const sqliteVersion = runtimeDatabase
		.query<{ version: string }, []>('SELECT sqlite_version() AS version')
		.get()?.version;
	runtimeDatabase.close();
	const finishedAt = new Date().toISOString();
	const reportOptions = { ...options };
	delete reportOptions.output;
	const report = {
		schemaVersion: 1,
		charter: 'ADR-0177 COMPLETE wide-versus-split replica benchmark: Bun owner',
		commit: options.commit,
		startedAt,
		finishedAt,
		durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
		profile: reportOptions,
		proxy: {
			version: 1,
			encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}',
			records: options.records,
			targetBytes: options.proxyBytes,
			emptyProxyBytes: shape.emptyProxyBytes,
			baseFillerBytes: shape.baseFillerBytes,
			extraFillerRecords: shape.extraFillerRecords,
		},
		fixture: {
			documents: Math.ceil(options.records / 20),
			documentsWithSecondUpdate: Math.ceil(options.records / 200),
			activeDocumentInflight: Math.ceil(options.records / 400),
			blobMemberships: Math.ceil(options.records / 25),
			pendingIntents: Math.ceil(options.records / 50),
			parkedIntents: options.parkedIntents,
			disclosures: [
				'Confirmed rows use direct INSERT batches. The candidate-specific INSERT statement differs only by installed schema; the 5,000-row transaction loop and exact V1 proxy generator are structurally identical.',
				'Blob membership uses direct candidate-specific INSERT/UPDATE statements in an identical index loop. Real blob capture requires the layout-independent file store.',
				'Parked scalar intents use direct candidate-specific INSERT/UPDATE statements in an identical address loop because no store API creates an already parked lane.',
			],
		},
		measurement: {
			timing:
				'milliseconds; per-address for pointRead, laneWrite, and docAppend; per operation for all other metrics',
			statementCounts:
				'run() and all() calls observed at the production SqliteDatabase adapter, retained per raw timing sample',
			rowsCounterLimitation:
				'SQLite embedded APIs expose no rows-read/rows-written counters, unlike Durable Object SqlStorageCursor; statement counts and query plans are the measurable proxies.',
		},
		workloadDecisions: [
			'Smoke uses one candidate repetition and reduced per-metric samples; full uses three repetitions and alternates the requested first candidate.',
			'Lane writes alternate confirmed existing addresses and benchmark-only fresh addresses within every batch.',
			'Fact-install pages alternate updates to confirmed fixture addresses and fresh addresses.',
			'Tombstone pages walk eligible multiples of 100 from the end of the fixture, then restore a pending intent before timing so every target owns document, blob, and intent state.',
			'Relation counts include every installed user table, including the shared meta relation, rather than omitting useful stronger evidence.',
		],
		runtime: {
			bun: Bun.version,
			sqlite: sqliteVersion,
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
		},
		sourceFile:
			'packages/data/src/__benchmarks__/replica-layout-complete.bench.ts',
		sourceSha256: sha256(readFileSync(import.meta.path)),
		installedSchemaEncoding:
			'JSON array of non-internal sqlite_schema tables and indexes ordered by type and name',
		installedSchemaSha256: {
			wide: installedSchemaSha256('wide'),
			split: installedSchemaSha256('split'),
		},
		runs,
		aggregate: aggregate(runs),
	};
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output !== undefined) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, json);
	}
	console.log(json);
}

main();
