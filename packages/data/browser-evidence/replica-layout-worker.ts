import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type BindingSpec,
	type Database,
	type PreparedStatement,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';

import {
	canonicalize,
	type JsonValue,
	type RecordAddress,
	utf8ByteLength,
} from '../src/protocol/v1/index.js';
import {
	createReplicaStoreSchema,
	REPLICA_STORE_FORMAT_VERSION,
} from '../src/store/replica/schema.js';
import type {
	ReplicaLayoutCandidate,
	ReplicaLayoutCandidateRun,
	ReplicaLayoutEngineResult,
	ReplicaLayoutProfileParameters,
	ReplicaLayoutWorkerMessage,
	ReplicaLayoutWorkerRequest,
} from './replica-layout-contract.js';
import {
	deriveReplicaLayoutAggregate,
	REPLICA_LAYOUT_PROFILES,
	summarizeReplicaLayoutSamples,
} from './replica-layout-contract.js';

type WorkerScope = {
	postMessage(message: ReplicaLayoutWorkerMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: ReplicaLayoutWorkerRequest }) => void,
	): void;
};

const scope = globalThis as unknown as WorkerScope;
const NAMESPACE_COUNT = 25;
const COLLECTION_COUNT = 40;
const SPLIT_FORMAT_VERSION = 1;

const SPLIT_DDL = `
CREATE TABLE meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL,
  replica_id TEXT NOT NULL,
  authority_lifetime TEXT,
  after_sequence INTEGER NOT NULL DEFAULT 0,
  sealed_submission INTEGER,
  sealed_request TEXT,
  sealed_request_hash TEXT,
  next_submission INTEGER NOT NULL DEFAULT 1
) STRICT;
INSERT INTO meta (
  singleton, format_version, replica_id, authority_lifetime
) VALUES (1, ${SPLIT_FORMAT_VERSION}, 'rrrrrrrrrrrrrrrrrrrrrrrr', 'lifetime-one');

CREATE TABLE confirmed_records (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('live', 'tombstone', 'unset')),
  payload TEXT,
  sequence INTEGER NOT NULL,
  PRIMARY KEY (namespace, collection, record_key),
  CHECK ((state = 'live') = (payload IS NOT NULL)),
  CHECK (payload IS NULL OR json_valid(payload))
) WITHOUT ROWID, STRICT;

CREATE TABLE local_intents (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  sealed_op TEXT,
  sealed_args TEXT,
  pending_op TEXT,
  pending_args TEXT,
  parked_op TEXT,
  parked_args TEXT,
  parked_code TEXT,
  parked_measured INTEGER,
  parked_limit INTEGER,
  PRIMARY KEY (namespace, collection, record_key),
  CHECK ((sealed_op IS NULL AND sealed_args IS NULL)
    OR (sealed_op IN ('patch', 'replace') AND sealed_args IS NOT NULL
      AND json_valid(sealed_args))
    OR (sealed_op IN ('tombstone', 'unset') AND sealed_args IS NULL)),
  CHECK ((pending_op IS NULL AND pending_args IS NULL)
    OR (pending_op IN ('patch', 'replace') AND pending_args IS NOT NULL
      AND json_valid(pending_args))
    OR (pending_op IN ('tombstone', 'unset') AND pending_args IS NULL)),
  CHECK ((parked_op IS NULL AND parked_args IS NULL AND parked_code IS NULL
      AND parked_measured IS NULL AND parked_limit IS NULL)
    OR (parked_op = 'patch' AND parked_args IS NOT NULL
      AND json_valid(parked_args)
      AND ((parked_code = 'fact-too-large'
          AND parked_measured IS NOT NULL AND parked_limit IS NOT NULL)
        OR (parked_code = 'patch-base-not-object'
          AND parked_measured IS NULL AND parked_limit IS NULL)))),
  CHECK (parked_op IS NULL OR (pending_op IS NULL AND sealed_op IS NULL)),
  CHECK (sealed_op IS NOT NULL OR pending_op IS NOT NULL OR parked_op IS NOT NULL)
) WITHOUT ROWID, STRICT;
`;

type FixtureShape = {
	baseFillerBytes: number;
	extraFillerRecords: number;
	emptyProxyBytes: number;
};

type FixtureRecord = {
	address: RecordAddress;
	payload: string;
	proxyBytes: number;
};

function progress(message: string): void {
	scope.postMessage({ type: 'progress', message });
}

function adapterFor(database: Database) {
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

function fixtureShape(
	parameters: ReplicaLayoutProfileParameters,
): FixtureShape {
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

function recordAt(index: number, shape: FixtureShape): FixtureRecord {
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

function createSchema(
	database: Database,
	candidate: ReplicaLayoutCandidate,
): void {
	if (candidate === 'wide') {
		createReplicaStoreSchema(adapterFor(database), {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		});
		return;
	}
	database.exec(SPLIT_DDL);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function installedSchemaSha256(database: Database): Promise<string> {
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

function execute(statement: PreparedStatement, bindings: BindingSpec): void {
	try {
		statement.bind(bindings).step();
	} finally {
		statement.reset(true);
	}
}

function hasRow(statement: PreparedStatement, bindings: BindingSpec): boolean {
	try {
		statement.bind(bindings);
		return statement.step();
	} finally {
		statement.reset(true);
	}
}

function countRows(
	statement: PreparedStatement,
	bindings: BindingSpec,
): number {
	let count = 0;
	try {
		statement.bind(bindings);
		while (statement.step()) count += 1;
		return count;
	} finally {
		statement.reset(true);
	}
}

function seed(
	database: Database,
	candidate: ReplicaLayoutCandidate,
	parameters: ReplicaLayoutProfileParameters,
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
		return observedProxyBytes;
	} finally {
		statement.finalize();
	}
}

function timed(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

function explain(
	database: Database,
	sql: string,
	parameters: readonly (string | number)[],
): string[] {
	return adapterFor(database)
		.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, parameters)
		.map(({ detail }) => detail);
}

function scalarNumber(database: Database, sql: string): number {
	const row = adapterFor(database).all<{ value: number }>(sql)[0];
	if (row === undefined)
		throw new Error(`SQLite scalar query returned no row: ${sql}`);
	return row.value;
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
	candidate: ReplicaLayoutCandidate;
	repetition: number;
	parameters: ReplicaLayoutProfileParameters;
	shape: FixtureShape;
	runId: string;
}): Promise<{
	run: ReplicaLayoutCandidateRun;
	schemaSha256: string;
	sqliteVersion: string;
}> {
	const identity = `${runId}-${candidate}-${repetition}`;
	const databaseFilename = '/replica.sqlite3';
	let pool: SAHPoolUtil | undefined;
	let database: Database | undefined;
	try {
		pool = await sqlite.installOpfsSAHPoolVfs({
			name: `epicenter-layout-${identity}`,
			directory: `.epicenter-layout-${identity}`,
		});
		database = new pool.OpfsSAHPoolDb(databaseFilename);
		configure(database);
		createSchema(database, candidate);
		const schemaSha256 = await installedSchemaSha256(database);
		const sqliteVersion = String(
			adapterFor(database).all<{ version: string }>(
				'SELECT sqlite_version() AS version',
			)[0]?.version ?? 'unknown',
		);
		const observedProxyBytes = seed(database, candidate, parameters, shape);
		if (observedProxyBytes !== parameters.proxyBytes) {
			throw new Error(
				`Proxy mismatch: expected ${parameters.proxyBytes}, got ${observedProxyBytes}`,
			);
		}

		const pointWideSql = `SELECT confirmed_state, confirmed_payload,
			confirmed_sequence, sealed_op, sealed_args, pending_op, pending_args,
			parked_op, parked_args, parked_code, parked_measured, parked_limit
			FROM records WHERE namespace = ? AND collection = ? AND record_key = ?`;
		const pointConfirmedSql = `SELECT state, payload, sequence
			FROM confirmed_records WHERE namespace = ? AND collection = ? AND record_key = ?`;
		const pointLocalSql = `SELECT sealed_op, sealed_args, pending_op, pending_args,
			parked_op, parked_args, parked_code, parked_measured, parked_limit
			FROM local_intents WHERE namespace = ? AND collection = ? AND record_key = ?`;
		const traversalSql =
			candidate === 'wide'
				? `SELECT record_key, confirmed_state, confirmed_payload, confirmed_sequence,
						sealed_op, sealed_args, pending_op, pending_args,
						parked_op, parked_args, parked_code, parked_measured, parked_limit
					FROM records WHERE namespace = ? AND collection = ? ORDER BY record_key`
				: `SELECT c.record_key, c.state, c.payload, c.sequence,
						l.sealed_op, l.sealed_args, l.pending_op, l.pending_args,
						l.parked_op, l.parked_args, l.parked_code,
						l.parked_measured, l.parked_limit
					FROM confirmed_records c
					LEFT JOIN local_intents l
						ON l.namespace = c.namespace
						AND l.collection = c.collection
						AND l.record_key = c.record_key
					WHERE c.namespace = ? AND c.collection = ?
					ORDER BY c.record_key`;
		const laneWriteSql =
			candidate === 'wide'
				? `UPDATE records SET pending_op = 'replace', pending_args = ?
					WHERE namespace = ? AND collection = ? AND record_key = ?`
				: `INSERT INTO local_intents (
						namespace, collection, record_key, pending_op, pending_args
					) VALUES (?, ?, ?, 'replace', ?)
					ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
						pending_op = excluded.pending_op,
						pending_args = excluded.pending_args`;
		const feedInstallSql =
			candidate === 'wide'
				? `UPDATE records SET confirmed_state = 'live', confirmed_payload = ?,
						confirmed_sequence = ?
					WHERE namespace = ? AND collection = ? AND record_key = ?`
				: `UPDATE confirmed_records SET state = 'live', payload = ?, sequence = ?
					WHERE namespace = ? AND collection = ? AND record_key = ?`;

		const point = database.prepare(
			candidate === 'wide' ? pointWideSql : pointConfirmedSql,
		);
		const pointLocal =
			candidate === 'split' ? database.prepare(pointLocalSql) : undefined;
		const traversal = database.prepare(traversalSql);
		const laneWrite = database.prepare(laneWriteSql);
		const feedInstall = database.prepare(feedInstallSql);
		let pointSamples: number[] = [];
		let traversalSamples: number[] = [];
		let laneSamples: number[] = [];
		let feedSamples: number[] = [];
		try {
			for (let warmup = 0; warmup < 256; warmup += 1) {
				const record = recordAt((warmup * 7_919) % parameters.records, shape);
				const bindings = [
					record.address.namespace,
					record.address.collection,
					record.address.recordKey,
				];
				hasRow(point, bindings);
				if (pointLocal !== undefined) hasRow(pointLocal, bindings);
			}

			pointSamples = [];
			for (let sample = 0; sample < parameters.pointBatches; sample += 1) {
				pointSamples.push(
					timed(() => {
						for (let offset = 0; offset < parameters.batchSize; offset += 1) {
							const record = recordAt(
								(sample * parameters.batchSize * 7_919 + offset * 104_729) %
									parameters.records,
								shape,
							);
							const bindings = [
								record.address.namespace,
								record.address.collection,
								record.address.recordKey,
							];
							if (!hasRow(point, bindings)) {
								throw new Error('Point read missed a record');
							}
							if (pointLocal !== undefined) hasRow(pointLocal, bindings);
						}
					}) / parameters.batchSize,
				);
			}

			traversalSamples = [];
			for (let sample = 0; sample < parameters.traversals; sample += 1) {
				const probe = addressAt(1 + sample * NAMESPACE_COUNT);
				traversalSamples.push(
					timed(() => {
						if (
							countRows(traversal, [probe.namespace, probe.collection]) === 0
						) {
							throw new Error('Traversal returned no records');
						}
					}),
				);
			}

			laneSamples = [];
			for (let sample = 0; sample < parameters.laneBatches; sample += 1) {
				laneSamples.push(
					timed(() => {
						database?.transaction('IMMEDIATE', () => {
							for (let offset = 0; offset < parameters.batchSize; offset += 1) {
								const record = recordAt(
									((sample * parameters.batchSize + offset) * 65_537 + 1) %
										parameters.records,
									shape,
								);
								const args = canonicalize({
									value: sample * parameters.batchSize + offset,
								});
								execute(
									laneWrite,
									candidate === 'wide'
										? [
												args,
												record.address.namespace,
												record.address.collection,
												record.address.recordKey,
											]
										: [
												record.address.namespace,
												record.address.collection,
												record.address.recordKey,
												args,
											],
								);
							}
						});
					}) / parameters.batchSize,
				);
			}

			feedSamples = [];
			for (let sample = 0; sample < parameters.feedBatches; sample += 1) {
				feedSamples.push(
					timed(() => {
						database?.transaction('IMMEDIATE', () => {
							for (let offset = 0; offset < parameters.batchSize; offset += 1) {
								const index =
									((sample * parameters.batchSize + offset) * 131_071 + 2) %
									parameters.records;
								const record = recordAt(index, shape);
								execute(feedInstall, [
									record.payload,
									parameters.records +
										sample * parameters.batchSize +
										offset +
										1,
									record.address.namespace,
									record.address.collection,
									record.address.recordKey,
								]);
							}
						});
					}) / parameters.batchSize,
				);
			}
		} finally {
			point.finalize();
			pointLocal?.finalize();
			traversal.finalize();
			laneWrite.finalize();
			feedInstall.finalize();
		}

		const countTable = candidate === 'wide' ? 'records' : 'confirmed_records';
		const recordCount = scalarNumber(
			database,
			`SELECT count(*) AS value FROM ${countTable}`,
		);
		if (recordCount !== parameters.records)
			throw new Error('Record count mismatch');
		const integrityCheck = String(
			adapterFor(database).all<{ integrity_check: string }>(
				'PRAGMA integrity_check',
			)[0]?.integrity_check ?? '',
		);
		if (integrityCheck !== 'ok') {
			throw new Error(`Integrity check failed: ${integrityCheck}`);
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
		const queryPlans = {
			pointRead:
				candidate === 'wide'
					? explain(database, pointWideSql, ['n', 'c', 'r'])
					: [
							...explain(database, pointConfirmedSql, ['n', 'c', 'r']),
							...explain(database, pointLocalSql, ['n', 'c', 'r']),
						],
			traversal: explain(database, traversalSql, ['n', 'c']),
			laneWrite:
				candidate === 'wide'
					? explain(database, laneWriteSql, ['{}', 'n', 'c', 'r'])
					: explain(database, laneWriteSql, ['n', 'c', 'r', '{}']),
			feedInstall: explain(database, feedInstallSql, ['{}', 1, 'n', 'c', 'r']),
		};
		database.close();
		database = undefined;
		const fileBytes = (await pool.exportFile(databaseFilename)).byteLength;
		const openedPool = pool;

		const reopenSamples: number[] = [];
		for (let sample = 0; sample < parameters.reopenSamples; sample += 1) {
			reopenSamples.push(
				timed(() => {
					const reopened = new openedPool.OpfsSAHPoolDb(databaseFilename);
					try {
						configure(reopened);
						const meta = scalarNumber(
							reopened,
							'SELECT format_version AS value FROM meta WHERE singleton = 1',
						);
						const expectedFormat =
							candidate === 'wide'
								? REPLICA_STORE_FORMAT_VERSION
								: SPLIT_FORMAT_VERSION;
						if (meta !== expectedFormat) {
							throw new Error('Reopen format mismatch');
						}
						const probe = recordAt(sample % parameters.records, shape);
						const table =
							candidate === 'wide' ? 'records' : 'confirmed_records';
						const statement = reopened.prepare(
							`SELECT record_key FROM ${table}
							WHERE namespace = ? AND collection = ? AND record_key = ?`,
						);
						try {
							if (
								!hasRow(statement, [
									probe.address.namespace,
									probe.address.collection,
									probe.address.recordKey,
								])
							) {
								throw new Error('Reopen point read missed a record');
							}
						} finally {
							statement.finalize();
						}
					} finally {
						reopened.close();
					}
				}),
			);
		}

		return {
			schemaSha256,
			sqliteVersion,
			run: {
				candidate,
				repetition,
				metrics: {
					pointRead: summarizeReplicaLayoutSamples(pointSamples),
					traversal: summarizeReplicaLayoutSamples(traversalSamples),
					laneWrite: summarizeReplicaLayoutSamples(laneSamples),
					feedInstall: summarizeReplicaLayoutSamples(feedSamples),
					reopen: summarizeReplicaLayoutSamples(reopenSamples),
				},
				storage: {
					pageSize,
					pageCount,
					freelistCount,
					liveBytes: (pageCount - freelistCount) * pageSize,
					fileBytes,
				},
				integrityCheck: 'ok',
				recordCount,
				observedProxyBytes,
				queryPlans,
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
}: ReplicaLayoutWorkerRequest): Promise<ReplicaLayoutEngineResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const parameters = REPLICA_LAYOUT_PROFILES[profile];
	const shape = fixtureShape(parameters);
	const estimate = await navigator.storage.estimate();
	const usageBytes =
		estimate.usage === undefined ? undefined : Math.floor(estimate.usage);
	const quotaBytes =
		estimate.quota === undefined ? undefined : Math.floor(estimate.quota);
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
					? 'The browser did not report measured storage availability for the full profile'
					: `Measured available storage ${availableBytes} is below the ${requiredAvailableBytes}-byte preflight`,
		};
	}

	const sqlite = await sqlite3InitModule();
	const runs: ReplicaLayoutCandidateRun[] = [];
	let wideSchemaSha256: string | undefined;
	let splitSchemaSha256: string | undefined;
	let sqliteVersion: string | undefined;
	for (
		let repetition = 0;
		repetition < parameters.repetitions;
		repetition += 1
	) {
		const order: ReplicaLayoutCandidate[] =
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
			sqliteVersion ??= result.sqliteVersion;
			if (candidate === 'wide') wideSchemaSha256 ??= result.schemaSha256;
			else splitSchemaSha256 ??= result.schemaSha256;
		}
	}
	if (wideSchemaSha256 === undefined || splitSchemaSha256 === undefined) {
		throw new Error('Browser layout run did not install both schemas');
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
		schemas: {
			installedSchemaEncoding:
				'JSON array of non-internal sqlite_schema tables and indexes ordered by type and name',
			wideDdlOwner: 'packages/data/src/store/replica/schema.ts',
			wideSchemaSha256,
			splitSchemaSha256,
			splitDdlSha256: await sha256(SPLIT_DDL),
		},
		runs,
		aggregate: deriveReplicaLayoutAggregate(runs),
	};
}

scope.addEventListener('message', ({ data: request }) => {
	void runBenchmark(request).then(
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
