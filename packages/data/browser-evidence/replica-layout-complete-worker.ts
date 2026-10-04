import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import sqlite3InitModule, {
	type BindingSpec,
	type Database,
	type PreparedStatement,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
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
} from '../src/protocol/v1/index.js';
import { openReplicaStore, type ReplicaStore } from '../src/store/replica/index.js';
import {
	openSplitReplicaStore,
	type SplitReplicaStore,
} from '../src/store/replica-split/index.js';
import {
	aggregateCompleteRuns,
	COMPLETE_METRICS,
	COMPLETE_PROFILES,
	type CompleteCandidate,
	type CompleteCandidateRun,
	type CompleteEngineResult,
	type CompleteMetric,
	type CompleteProfileParameters,
	type CompleteWorkerMessage,
	type CompleteWorkerRequest,
	summarize,
	type StatementKind,
} from './replica-layout-complete-contract.js';

type Store = ReplicaStore | SplitReplicaStore;
type StatementObservation = { sql: string; parameters: readonly SqliteValue[] };
type CounterState = {
	activeMetric?: CompleteMetric;
	counts: Record<StatementKind, number>;
	observations: Map<CompleteMetric, Map<string, StatementObservation>>;
};
type MetricSamples = Record<
	CompleteMetric,
	{ timingMs: number[]; run: number[]; all: number[] }
>;
type FixtureShape = {
	baseFillerBytes: number;
	extraFillerRecords: number;
	emptyProxyBytes: number;
};
type WorkerScope = {
	postMessage(message: CompleteWorkerMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: CompleteWorkerRequest }) => void,
	): void;
};

const scope = globalThis as unknown as WorkerScope;
const NAMESPACE_COUNT = 25;
const COLLECTION_COUNT = 40;
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const AUTHORITY_LIFETIME = 'lifetime-one';

function progress(message: string): void {
	scope.postMessage({ type: 'progress', message });
}

function adapterFor(database: Database): SqliteDatabase {
	return createBrowserSqliteAdapter(
		database as unknown as BrowserSqliteDatabase,
	);
}

function configure(database: Database): void {
	database.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = EXTRA;
		PRAGMA temp_store = MEMORY;
	`);
}

function addressAt(index: number): RecordAddress {
	const namespace = `so.epicenter.fixture${String(index % NAMESPACE_COUNT).padStart(2, '0')}`;
	if (index % 100 === 0) {
		return { namespace, collection: 'settings', recordKey: `value${index}` };
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

function fixtureShape(parameters: CompleteProfileParameters): FixtureShape {
	let emptyProxyBytes = 0;
	for (let index = 0; index < parameters.records; index += 1) {
		emptyProxyBytes += proxyBytes(addressAt(index), payloadAt(index, 0));
	}
	const fillerBytes = parameters.proxyBytes - emptyProxyBytes;
	if (fillerBytes < 0) {
		throw new Error(
			`Proxy target ${parameters.proxyBytes} is below empty fixture ${emptyProxyBytes}`,
		);
	}
	return {
		baseFillerBytes: Math.floor(fillerBytes / parameters.records),
		extraFillerRecords: fillerBytes % parameters.records,
		emptyProxyBytes,
	};
}

function recordAt(index: number, shape: FixtureShape) {
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

function sha256(value: string | Uint8Array): string {
	return bytesToHex(
		sha256Digest(typeof value === 'string' ? new TextEncoder().encode(value) : value),
	);
}

function execute(statement: PreparedStatement, bindings: BindingSpec): void {
	try {
		statement.bind(bindings).step();
	} finally {
		statement.reset(true);
	}
}

function createCounterState(): CounterState {
	return { counts: { run: 0, all: 0 }, observations: new Map() };
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
	let observations = state.observations.get(metric);
	if (observations === undefined) {
		observations = new Map();
		state.observations.set(metric, observations);
	}
	if (!observations.has(sql)) {
		observations.set(sql, { sql, parameters: [...parameters] });
	}
}

function countingAdapter(database: Database, state: CounterState): SqliteDatabase {
	const base = adapterFor(database);
	return {
		run(sql, parameters = []): void {
			observe(state, 'run', sql, parameters);
			base.run(sql, parameters);
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			observe(state, 'all', sql, parameters);
			return base.all<TRow>(sql, parameters);
		},
		transaction<TResult>(run: () => TResult): TResult {
			return base.transaction(run);
		},
	};
}

function openStore(
	candidate: CompleteCandidate,
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

function installedSchemaSha256(database: Database): string {
	const objects = adapterFor(database).all<{
		name: string;
		sql: string | null;
		tableName: string;
		type: string;
	}>(
		`SELECT type, name, tbl_name AS tableName, sql
		FROM sqlite_schema
		WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
		ORDER BY type, name`,
	);
	return sha256(JSON.stringify(objects));
}

function seedConfirmed(
	database: Database,
	candidate: CompleteCandidate,
	parameters: CompleteProfileParameters,
	shape: FixtureShape,
): number {
	const statement = database.prepare(
		candidate === 'wide'
			? `INSERT INTO records (
				namespace, collection, record_key,
				confirmed_state, confirmed_payload, confirmed_sequence
			) VALUES (?, ?, ?, 'live', ?, ?)`
			: `INSERT INTO confirmed_records (
				namespace, collection, record_key, state, payload, sequence
			) VALUES (?, ?, ?, 'live', ?, ?)`,
	);
	let observedProxyBytes = 0;
	try {
		for (let start = 0; start < parameters.records; start += 5_000) {
			const end = Math.min(parameters.records, start + 5_000);
			database.transaction('IMMEDIATE', () => {
				for (let index = start; index < end; index += 1) {
					const record = recordAt(index, shape);
					execute(statement, [
						record.address.namespace,
						record.address.collection,
						record.address.recordKey,
						record.payload,
						index + 1,
					]);
					observedProxyBytes += record.proxyBytes;
				}
			});
			if (
				parameters.records >= 100_000 &&
				(end % 50_000 === 0 || end === parameters.records)
			) {
				progress(`${candidate}: seeded ${end}/${parameters.records} records`);
			}
		}
	} finally {
		statement.finalize();
	}
	adapterFor(database).run(
		'UPDATE meta SET after_sequence = ? WHERE singleton = 1',
		[parameters.records],
	);
	return observedProxyBytes;
}

function deterministicDocumentUpdates(index: number, count: 1 | 2): Uint8Array[] {
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

function seedDocuments(store: Store, parameters: CompleteProfileParameters): void {
	for (let ordinal = 0; ordinal < parameters.documents; ordinal += 1) {
		const index = ordinal * 20;
		const updates = deterministicDocumentUpdates(
			index,
			index % 200 === 0 ? 2 : 1,
		);
		for (const update of updates) {
			store.appendLocalDocumentUpdate(addressAt(index), update);
		}
		if (
			parameters.documents >= 10_000 &&
			((ordinal + 1) % 2_500 === 0 || ordinal + 1 === parameters.documents)
		) {
			progress(
				`seeded ${ordinal + 1}/${parameters.documents} documents`,
			);
		}
	}
}

function seedBlobs(
	database: Database,
	candidate: CompleteCandidate,
	parameters: CompleteProfileParameters,
): void {
	const statement = database.prepare(
		candidate === 'wide'
			? `UPDATE records SET blob_sha256 = ?, blob_pending = ?, blob_parked_code = ?
				WHERE namespace = ? AND collection = ? AND record_key = ?`
			: `INSERT INTO blob_state (
				namespace, collection, record_key, sha256, pending, parked_code
			) VALUES (?, ?, ?, ?, ?, ?)`,
	);
	try {
		database.transaction('IMMEDIATE', () => {
			for (let ordinal = 0; ordinal < parameters.blobs; ordinal += 1) {
				const index = ordinal * 25;
				const address = addressAt(index);
				const digest = sha256(String(index));
				const pending = ordinal % 2 === 0 ? 1 : 0;
				const parked = index % 400 === 0 ? 'blob-conflict' : null;
				execute(
					statement,
					candidate === 'wide'
						? [
								digest,
								pending,
								parked,
								address.namespace,
								address.collection,
								address.recordKey,
							]
						: [
								address.namespace,
								address.collection,
								address.recordKey,
								digest,
								pending,
								parked,
							],
				);
			}
		});
	} finally {
		statement.finalize();
	}
}

function seedPendingIntents(
	store: Store,
	parameters: CompleteProfileParameters,
): void {
	for (let ordinal = 0; ordinal < parameters.pendingIntents; ordinal += 1) {
		store.localWrite({
			address: addressAt(ordinal * 50),
			op: 'patch',
			set: { note: 'x' },
			unset: [],
		});
	}
}

function seedParkedIntents(
	database: Database,
	candidate: CompleteCandidate,
	parameters: CompleteProfileParameters,
): void {
	const parkedArgs = canonicalize({ set: { parked: true }, unset: [] });
	const statement = database.prepare(
		candidate === 'wide'
			? `UPDATE records SET
				parked_op = 'patch', parked_args = ?, parked_code = 'fact-too-large',
				parked_measured = 5000, parked_limit = 4096
			WHERE namespace = ? AND collection = ? AND record_key = ?`
			: `INSERT INTO local_intents (
				namespace, collection, record_key,
				parked_op, parked_args, parked_code, parked_measured, parked_limit
			) VALUES (?, ?, ?, 'patch', ?, 'fact-too-large', 5000, 4096)`,
	);
	try {
		database.transaction('IMMEDIATE', () => {
			for (let ordinal = 0; ordinal < parameters.parkedIntents; ordinal += 1) {
				const address = addressAt(ordinal * 50 + 1);
				execute(
					statement,
					candidate === 'wide'
						? [
								parkedArgs,
								address.namespace,
								address.collection,
								address.recordKey,
							]
						: [
								address.namespace,
								address.collection,
								address.recordKey,
								parkedArgs,
							],
				);
			}
		});
	} finally {
		statement.finalize();
	}
}

function seedDocumentInflight(
	store: Store,
	parameters: CompleteProfileParameters,
): void {
	for (let ordinal = 0; ordinal < parameters.documentInflight; ordinal += 1) {
		const publication = store.documentPublication(addressAt(ordinal * 400));
		if (publication.kind !== 'ready') {
			throw new Error('Fixture document publication did not freeze an image');
		}
	}
}

function seedCompleteFixture(
	database: Database,
	candidate: CompleteCandidate,
	store: Store,
	parameters: CompleteProfileParameters,
	shape: FixtureShape,
): void {
	const observedProxyBytes = seedConfirmed(
		database,
		candidate,
		parameters,
		shape,
	);
	if (observedProxyBytes !== parameters.proxyBytes) {
		throw new Error(
			`Proxy mismatch: expected ${parameters.proxyBytes}, got ${observedProxyBytes}`,
		);
	}
	seedDocuments(store, parameters);
	seedBlobs(database, candidate, parameters);
	seedPendingIntents(store, parameters);
	seedParkedIntents(database, candidate, parameters);
	seedDocumentInflight(store, parameters);
}

function emptyMetricSamples(): MetricSamples {
	const samples = {} as MetricSamples;
	for (const metric of COMPLETE_METRICS) {
		samples[metric] = { timingMs: [], run: [], all: [] };
	}
	return samples;
}

function measure<TResult>(
	metric: CompleteMetric,
	state: CounterState,
	samples: MetricSamples,
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
		samples[metric].timingMs.push((performance.now() - started) / unitDivisor);
		samples[metric].run.push(state.counts.run - beforeRun);
		samples[metric].all.push(state.counts.all - beforeAll);
		state.activeMetric = undefined;
	}
}

function mixedPointIndex(sample: number, offset: number, records: number): number {
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
			throw new Error('Unreachable mixed point category');
	}
}

function traversalSql(candidate: CompleteCandidate): string {
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
	candidate: CompleteCandidate,
	address: RecordAddress,
): string[] {
	return candidate === 'wide'
		? [address.namespace, address.collection]
		: Array.from({ length: 4 }, () => [
				address.namespace,
				address.collection,
			]).flat();
}

function traversalScalarSql(candidate: CompleteCandidate): string {
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
	candidate: CompleteCandidate,
	address: RecordAddress,
): string[] {
	return candidate === 'wide'
		? [address.namespace, address.collection]
		: Array.from({ length: 2 }, () => [
				address.namespace,
				address.collection,
			]).flat();
}

function docDrainSql(candidate: CompleteCandidate): string {
	return candidate === 'wide'
		? `SELECT namespace, collection, record_key, doc_revision
			FROM records WHERE doc_dirty = 1
			ORDER BY namespace, collection, record_key`
		: `SELECT namespace, collection, record_key, revision
			FROM record_documents WHERE dirty = 1
			ORDER BY namespace, collection, record_key`;
}

function blobDrainSql(candidate: CompleteCandidate): string {
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
	if (result.data === null) throw new Error('Successful result has no data');
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
	const outcome = unwrapResult(submit(authority, request, SCALAR_SYNC_V1_LIMITS));
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

function explain(
	database: Database,
	observation: StatementObservation,
): { sql: string; detail: string[] } {
	const rows = adapterFor(database).all<{ detail: string }>(
		`EXPLAIN QUERY PLAN ${observation.sql}`,
		observation.parameters,
	);
	return { sql: observation.sql, detail: rows.map((row) => row.detail) };
}

function queryPlans(
	database: Database,
	state: CounterState,
): CompleteCandidateRun['queryPlans'] {
	return Object.fromEntries(
		COMPLETE_METRICS.map((metric) => [
			metric,
			[...(state.observations.get(metric)?.values() ?? [])].map((observation) =>
				explain(database, observation),
			),
		]),
	) as CompleteCandidateRun['queryPlans'];
}

function scalarNumber(database: Database, sql: string): number {
	const row = adapterFor(database).all<{ value: number }>(sql)[0];
	if (row === undefined) throw new Error(`SQLite scalar query returned no row: ${sql}`);
	return row.value;
}

function relationCounts(database: Database): Record<string, number> {
	const names = adapterFor(database)
		.all<{ name: string }>(
			`SELECT name FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
		)
		.map((row) => row.name);
	return Object.fromEntries(
		names.map((name) => [
			name,
			scalarNumber(database, `SELECT count(*) AS value FROM ${name}`),
		]),
	);
}

function integrityCheck(database: Database): string {
	try {
		return String(
			adapterFor(database).all<{ integrity_check: string }>(
				'PRAGMA integrity_check',
			)[0]?.integrity_check ?? 'no-result',
		);
	} catch (cause) {
		return `not-authorized: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}

async function runCandidate({
	sqlite,
	candidate,
	repetition,
	parameters,
	shape,
	runId,
}: {
	sqlite: Awaited<ReturnType<typeof sqlite3InitModule>>;
	candidate: CompleteCandidate;
	repetition: number;
	parameters: CompleteProfileParameters;
	shape: FixtureShape;
	runId: string;
}): Promise<{
	run: CompleteCandidateRun;
	schemaSha256: string;
	sqliteVersion: string;
}> {
	const identity = `${runId}-${candidate}-${repetition}`;
	const databaseFilename = '/replica.sqlite3';
	let pool: SAHPoolUtil | undefined;
	let database: Database | undefined;
	try {
		pool = await sqlite.installOpfsSAHPoolVfs({
			name: `epicenter-complete-${identity}`,
			directory: `.epicenter-complete-${identity}`,
		});
		database = new pool.OpfsSAHPoolDb(databaseFilename);
		configure(database);
		const counters = createCounterState();
		let adapter = countingAdapter(database, counters);
		let store = openStore(candidate, adapter, true);
		const schemaSha256 = installedSchemaSha256(database);
		const sqliteVersion = String(
			adapterFor(database).all<{ version: string }>(
				'SELECT sqlite_version() AS version',
			)[0]?.version ?? 'unknown',
		);
		seedCompleteFixture(
			database,
			candidate,
			store,
			parameters,
			shape,
		);
		const samples = emptyMetricSamples();

		for (let sample = 0; sample < parameters.pointBatches; sample += 1) {
			measure(
				'pointRead',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < parameters.batchSize; offset += 1) {
						const index = mixedPointIndex(sample, offset, parameters.records);
						if (store.record(addressAt(index)) === null) {
							throw new Error('Point read missed a fixture record');
						}
					}
				},
				parameters.batchSize,
			);
		}

		const traversal = traversalSql(candidate);
		for (let sample = 0; sample < parameters.traversals; sample += 1) {
			const probe = addressAt(1 + sample * NAMESPACE_COUNT);
			measure('traversal', counters, samples, () => {
				if (
					adapter.all(traversal, traversalParameters(candidate, probe)).length === 0
				) {
					throw new Error('Traversal returned no records');
				}
			});
		}

		const traversalScalar = traversalScalarSql(candidate);
		for (let sample = 0; sample < parameters.traversals; sample += 1) {
			const probe = addressAt(1 + sample * NAMESPACE_COUNT);
			measure('traversalScalar', counters, samples, () => {
				if (
					adapter.all(
						traversalScalar,
						traversalScalarParameters(candidate, probe),
					).length === 0
				) {
					throw new Error('Scalar traversal returned no records');
				}
			});
		}

		for (let sample = 0; sample < parameters.laneBatches; sample += 1) {
			measure(
				'laneWrite',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < parameters.batchSize; offset += 1) {
						const address =
							offset % 2 === 0
								? addressAt(
										((sample * parameters.batchSize + offset) * 65_537 + 3) %
											parameters.records,
									)
								: freshAddress(
										'lane-write',
										sample * parameters.batchSize + offset,
									);
						store.localWrite({
							address,
							op: 'patch',
							set: { lane: sample * parameters.batchSize + offset },
							unset: [],
						});
					}
				},
				parameters.batchSize,
			);
		}

		const initialAuthority = unwrapResult(
			createAuthority(AUTHORITY_LIFETIME, SCALAR_SYNC_V1_LIMITS),
		);
		let authority: AuthorityState = {
			...initialAuthority,
			nextSequence: parameters.records + 1,
		};
		for (let sample = 0; sample < parameters.sealBatches; sample += 1) {
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
				throw new Error(`Seal admitted ${parsed.intents.length}, expected 64`);
			}
			authority = settleSeal(store, sealed.bytes, authority);
		}

		let nextFactSequence = authority.nextSequence;
		for (let sample = 0; sample < parameters.factPages; sample += 1) {
			const requestAfterSequence = store.sync().afterSequence;
			const facts: Fact[] = [];
			for (let offset = 0; offset < 64; offset += 1) {
				const ordinal = sample * 64 + offset;
				facts.push({
					address:
						offset % 2 === 0
							? addressAt((ordinal * 104_729 + 7) % parameters.records)
							: freshAddress('fact-install', ordinal),
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

		for (let sample = 0; sample < parameters.docAppendBatches; sample += 1) {
			const batch = Math.min(parameters.batchSize, parameters.documents);
			measure(
				'docAppend',
				counters,
				samples,
				() => {
					for (let offset = 0; offset < batch; offset += 1) {
						const documentOrdinal =
							(sample * batch + offset + 1_001) % parameters.documents;
						const update = deterministicDocumentUpdates(
							parameters.records + sample * batch + offset,
							1,
						)[0];
						if (update === undefined) throw new Error('Missing document update');
						store.appendLocalDocumentUpdate(
							addressAt(documentOrdinal * 20),
							update,
						);
					}
				},
				batch,
			);
		}

		const documentDrain = docDrainSql(candidate);
		for (let sample = 0; sample < parameters.drainScans; sample += 1) {
			measure('docDrainScan', counters, samples, () => {
				if (adapter.all(documentDrain).length === 0) {
					throw new Error('Document drain scan returned no obligations');
				}
			});
		}

		const blobDrain = blobDrainSql(candidate);
		for (let sample = 0; sample < parameters.drainScans; sample += 1) {
			measure('blobDrainScan', counters, samples, () => {
				if (adapter.all(blobDrain).length === 0) {
					throw new Error('Blob drain scan returned no obligations');
				}
			});
		}

		const tombstoneCandidates = Array.from(
			{ length: Math.floor((parameters.records - 1) / 100) + 1 },
			(_, ordinal) => ordinal * 100,
		).reverse();
		let tombstoneOffset = 0;
		for (let sample = 0; sample < parameters.tombstonePages; sample += 1) {
			const count = Math.min(
				64,
				parameters.batchSize,
				tombstoneCandidates.length - tombstoneOffset,
			);
			if (count <= 0) break;
			const facts: Fact[] = [];
			for (let offset = 0; offset < count; offset += 1) {
				const index = tombstoneCandidates[tombstoneOffset + offset];
				if (index === undefined) throw new Error('Missing tombstone candidate');
				const address = addressAt(index);
				store.localWrite({
					address,
					op: 'patch',
					set: { tombstonePreparation: true },
					unset: [],
				});
				facts.push({ address, sequence: nextFactSequence, state: 'tombstone' });
				nextFactSequence += 1;
			}
			tombstoneOffset += count;
			const requestAfterSequence = store.sync().afterSequence;
			measure('tombstoneCleanup', counters, samples, () =>
				factsPage(store, facts, requestAfterSequence),
			);
		}

		for (let sample = 0; sample < parameters.reopenSamples; sample += 1) {
			measure('reopen', counters, samples, () => {
				database?.close();
				database = new (pool as SAHPoolUtil).OpfsSAHPoolDb(databaseFilename);
				configure(database);
				adapter = countingAdapter(database, counters);
				store = openStore(candidate, adapter);
				if (
					store.record(addressAt((sample * 7_919 + 3) % parameters.records)) ===
					null
				) {
					throw new Error('Reopen point read missed');
				}
			});
		}

		const check = integrityCheck(database);
		if (check !== 'ok' && !check.startsWith('not-authorized:')) {
			throw new Error(`Integrity check failed: ${check}`);
		}
		const pageSize = scalarNumber(
			database,
			'SELECT page_size AS value FROM pragma_page_size',
		);
		const pageCount = scalarNumber(
			database,
			'SELECT page_count AS value FROM pragma_page_count',
		);
		const freelistCount = scalarNumber(
			database,
			'SELECT freelist_count AS value FROM pragma_freelist_count',
		);
		const plans = queryPlans(database, counters);
		const counts = relationCounts(database);
		database.close();
		database = undefined;
		const opfsFileBytes = (await pool.exportFile(databaseFilename)).byteLength;

		return {
			schemaSha256,
			sqliteVersion,
			run: {
				candidate,
				repetition,
				metrics: Object.fromEntries(
					COMPLETE_METRICS.map((metric) => [
						metric,
						{
							timingMs: summarize(samples[metric].timingMs),
							statements: {
								run: summarize(samples[metric].run),
								all: summarize(samples[metric].all),
							},
						},
					]),
				) as CompleteCandidateRun['metrics'],
				storage: {
					pageSize,
					pageCount,
					freelistCount,
					liveBytes: (pageCount - freelistCount) * pageSize,
					opfsFileBytes,
				},
				integrityCheck: check,
				relationCountsAfterReopen: counts,
				queryPlans: plans,
			},
		};
	} finally {
		database?.close();
		await pool?.removeVfs();
	}
}

async function runBenchmark({
	profile,
	runId,
}: CompleteWorkerRequest): Promise<CompleteEngineResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const parameters = COMPLETE_PROFILES[profile];
	const shape = fixtureShape(parameters);
	const estimate = await navigator.storage.estimate();
	const usageBytes = estimate.usage === undefined ? undefined : Math.floor(estimate.usage);
	const quotaBytes = estimate.quota === undefined ? undefined : Math.floor(estimate.quota);
	const availableBytes =
		usageBytes === undefined || quotaBytes === undefined
			? undefined
			: Math.max(0, quotaBytes - usageBytes);
	const requiredAvailableBytes = Math.ceil(parameters.proxyBytes * 1.25);
	const storageEstimate = {
		...(usageBytes === undefined ? {} : { usageBytes }),
		...(quotaBytes === undefined ? {} : { quotaBytes }),
		...(availableBytes === undefined ? {} : { availableBytes }),
		requiredAvailableBytes,
	};
	if (
		profile === 'full' &&
		(availableBytes === undefined || availableBytes < requiredAvailableBytes)
	) {
		const finishedAt = new Date().toISOString();
		return {
			outcome: 'not-admitted',
			startedAt,
			finishedAt,
			durationMs: Date.parse(finishedAt) - started,
			profile,
			parameters,
			storageEstimate,
			runtime: {
				opfsBackend: 'sqlite.org OPFS SAH Pool VFS',
				journalMode: 'delete',
				synchronous: 'extra',
			},
			proxy: {
				version: 1,
				encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}',
				records: parameters.records,
				targetBytes: parameters.proxyBytes,
				emptyProxyBytes: shape.emptyProxyBytes,
				baseFillerBytes: shape.baseFillerBytes,
				extraFillerRecords: shape.extraFillerRecords,
			},
			runs: [],
			reason:
				availableBytes === undefined
					? 'The browser did not report measurable storage availability'
					: `Measured available storage ${availableBytes} is below the ${requiredAvailableBytes}-byte preflight`,
		};
	}

	const sqlite = await sqlite3InitModule();
	const runs: CompleteCandidateRun[] = [];
	const installedSchemaSha256 = {} as Record<CompleteCandidate, string>;
	let sqliteVersion: string | undefined;
	for (let repetition = 0; repetition < parameters.repetitions; repetition += 1) {
		const order: CompleteCandidate[] =
			repetition % 2 === 0 ? ['wide', 'split'] : ['split', 'wide'];
		for (const candidate of order) {
			progress(
				`${candidate}: repetition ${repetition + 1}/${parameters.repetitions}`,
			);
			const result = await runCandidate({
				sqlite,
				candidate,
				repetition,
				parameters,
				shape,
				runId,
			});
			runs.push(result.run);
			installedSchemaSha256[candidate] ??= result.schemaSha256;
			sqliteVersion ??= result.sqliteVersion;
		}
	}
	const finishedAt = new Date().toISOString();
	return {
		outcome: 'passed',
		startedAt,
		finishedAt,
		durationMs: Date.parse(finishedAt) - started,
		profile,
		parameters,
		storageEstimate,
		runtime: {
			...(sqliteVersion === undefined ? {} : { sqliteVersion }),
			opfsBackend: 'sqlite.org OPFS SAH Pool VFS',
			journalMode: 'delete',
			synchronous: 'extra',
		},
		proxy: {
			version: 1,
			encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}',
			records: parameters.records,
			targetBytes: parameters.proxyBytes,
			emptyProxyBytes: shape.emptyProxyBytes,
			baseFillerBytes: shape.baseFillerBytes,
			extraFillerRecords: shape.extraFillerRecords,
		},
		installedSchemaEncoding:
			'JSON array of non-internal sqlite_schema tables and indexes ordered by type and name',
		installedSchemaSha256,
		runs,
		aggregate: aggregateCompleteRuns(runs),
	};
}

scope.addEventListener('message', ({ data }) => {
	void runBenchmark(data).then(
		(result) => scope.postMessage({ type: 'result', result }),
		(cause: unknown) => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			scope.postMessage({
				type: 'error',
				name: error.name,
				message: error.message,
				...(error.stack === undefined ? {} : { stack: error.stack }),
			});
		},
	);
});
