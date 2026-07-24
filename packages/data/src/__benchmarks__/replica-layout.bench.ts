#!/usr/bin/env bun

/**
 * ADR-0177 Bun Wide-versus-Split Hot-path Evidence
 *
 * Compares the selected production wide record row with the sole retained
 * split runner-up at ADR-0161's representative final-present envelope. The
 * V1 proxy is the UTF-8 byte length of RFC 8785 canonical
 * `{ address, payload }` values. Every payload uses ASCII filler, so the
 * fixture can distribute bytes exactly without retaining the corpus in memory.
 *
 * This benchmark measures and reports. It intentionally asserts no timing
 * threshold under `bun test`; run it directly with Bun.
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

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	canonicalize,
	type JsonValue,
	type RecordAddress,
	utf8ByteLength,
} from '../protocol/v1/index.js';
import { createReplicaStoreSchema } from '../store/replica/schema.js';

type Candidate = 'wide' | 'split';
type Metric =
	| 'pointRead'
	| 'traversal'
	| 'laneWrite'
	| 'feedInstall'
	| 'reopen';

type Profile = {
	records: number;
	proxyBytes: number;
	repetitions: number;
	pointBatches: number;
	traversals: number;
	laneBatches: number;
	feedBatches: number;
	reopenSamples: number;
	batchSize: number;
};

type Options = Profile & {
	profile: 'smoke' | 'full';
	output?: string;
};

type Summary = {
	rawMs: number[];
	p50Ms: number;
	p95Ms: number;
	minimumMs: number;
	maximumMs: number;
};

type CandidateRun = {
	candidate: Candidate;
	repetition: number;
	metrics: Record<Metric, Summary>;
	storage: {
		pageSize: number;
		pageCount: number;
		freelistCount: number;
		liveBytes: number;
		fileBytes: number;
	};
	integrityCheck: string;
	recordCount: number;
	queryPlans: Record<Exclude<Metric, 'reopen'>, string[]>;
};

const MIB = 1024 * 1024;
const FULL_PROXY_BYTES = 512 * MIB;
const FULL_RECORDS = 1_000_000;
const NAMESPACE_COUNT = 25;
const COLLECTION_COUNT = 40;

const PROFILES: Record<'smoke' | 'full', Profile> = {
	smoke: {
		records: 5_000,
		proxyBytes: MIB,
		repetitions: 1,
		pointBatches: 8,
		traversals: 3,
		laneBatches: 4,
		feedBatches: 4,
		reopenSamples: 3,
		batchSize: 64,
	},
	full: {
		records: FULL_RECORDS,
		proxyBytes: FULL_PROXY_BYTES,
		repetitions: 3,
		pointBatches: 64,
		traversals: 16,
		laneBatches: 64,
		feedBatches: 32,
		reopenSamples: 8,
		batchSize: 64,
	},
};

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
) VALUES (1, 1, 'rrrrrrrrrrrrrrrrrrrrrrrr', 'lifetime-one');

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

const HELP = `
Usage:
  bun packages/data/src/__benchmarks__/replica-layout.bench.ts \\
    --profile smoke|full [--output report.json]

The full profile creates exactly 1,000,000 final-present records whose V1
proxy totals exactly 536,870,912 bytes. Temporary databases are always removed.
`.trim();

function parseOptions(args: string[]): Options | null {
	if (args.includes('--help')) return null;
	let profile: 'smoke' | 'full' = 'smoke';
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
			case '--output':
				output = value;
				break;
			default:
				throw new Error(`unknown option ${flag}`);
		}
	}
	return {
		profile,
		...PROFILES[profile],
		...(output === undefined ? {} : { output }),
	};
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

function createSchema(database: Database, candidate: Candidate): void {
	if (candidate === 'wide') {
		createReplicaStoreSchema(createBunSqliteAdapter(database), {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			owner: null,
			authorityLifetime: 'lifetime-one',
		});
		return;
	}
	database.exec(SPLIT_DDL);
}

function installedSchemaSha256(candidate: Candidate): string {
	const database = new Database(':memory:', { strict: true });
	try {
		createSchema(database, candidate);
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

function seed(
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
	return observedProxyBytes;
}

function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function summarize(rawMs: number[]): Summary {
	return {
		rawMs,
		p50Ms: percentile(rawMs, 0.5),
		p95Ms: percentile(rawMs, 0.95),
		minimumMs: Math.min(...rawMs),
		maximumMs: Math.max(...rawMs),
	};
}

function timed(run: () => void): number {
	const started = performance.now();
	run();
	return performance.now() - started;
}

function explain(
	database: Database,
	sql: string,
	parameters: SQLQueryBindings[],
): string[] {
	return database
		.query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${sql}`)
		.all(...parameters)
		.map((row) => row.detail);
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

function runCandidate(
	candidate: Candidate,
	repetition: number,
	options: Options,
	shape: ReturnType<typeof fixtureShape>,
): CandidateRun {
	const directory = mkdtempSync(
		join(tmpdir(), `epicenter-layout-${candidate}-`),
	);
	const path = join(directory, 'replica.sqlite');
	let database: Database | undefined;
	try {
		database = new Database(path, { create: true, strict: true });
		configure(database);
		createSchema(database, candidate);
		const observedProxyBytes = seed(database, candidate, options, shape);
		if (observedProxyBytes !== options.proxyBytes) {
			throw new Error(
				`proxy mismatch: expected ${options.proxyBytes}, got ${observedProxyBytes}`,
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

		for (let warmup = 0; warmup < 256; warmup += 1) {
			const record = recordAt((warmup * 7_919) % options.records, shape);
			const parameters = [
				record.address.namespace,
				record.address.collection,
				record.address.recordKey,
			] as const;
			point.get(...parameters);
			pointLocal?.get(...parameters);
		}

		const pointSamples: number[] = [];
		for (let sample = 0; sample < options.pointBatches; sample += 1) {
			pointSamples.push(
				timed(() => {
					for (let offset = 0; offset < options.batchSize; offset += 1) {
						const record = recordAt(
							(sample * options.batchSize * 7_919 + offset * 104_729) %
								options.records,
							shape,
						);
						const parameters = [
							record.address.namespace,
							record.address.collection,
							record.address.recordKey,
						] as const;
						const found = point.get(...parameters);
						if (found === null) throw new Error('point read missed a record');
						pointLocal?.get(...parameters);
					}
				}) / options.batchSize,
			);
		}

		const traversalSamples: number[] = [];
		for (let sample = 0; sample < options.traversals; sample += 1) {
			const probe = addressAt(1 + sample * NAMESPACE_COUNT);
			traversalSamples.push(
				timed(() => {
					const rows = traversal.all(probe.namespace, probe.collection);
					if (rows.length === 0)
						throw new Error('traversal returned no records');
				}),
			);
		}

		const laneSamples: number[] = [];
		const laneBatch = database.transaction((sample: number) => {
			for (let offset = 0; offset < options.batchSize; offset += 1) {
				const record = recordAt(
					((sample * options.batchSize + offset) * 65_537 + 1) %
						options.records,
					shape,
				);
				const args = canonicalize({
					value: sample * options.batchSize + offset,
				});
				if (candidate === 'wide') {
					laneWrite.run(
						args,
						record.address.namespace,
						record.address.collection,
						record.address.recordKey,
					);
				} else {
					laneWrite.run(
						record.address.namespace,
						record.address.collection,
						record.address.recordKey,
						args,
					);
				}
			}
		});
		for (let sample = 0; sample < options.laneBatches; sample += 1) {
			laneSamples.push(timed(() => laneBatch(sample)) / options.batchSize);
		}

		const feedSamples: number[] = [];
		const feedBatch = database.transaction((sample: number) => {
			for (let offset = 0; offset < options.batchSize; offset += 1) {
				const index =
					((sample * options.batchSize + offset) * 131_071 + 2) %
					options.records;
				const record = recordAt(index, shape);
				feedInstall.run(
					record.payload,
					options.records + sample * options.batchSize + offset + 1,
					record.address.namespace,
					record.address.collection,
					record.address.recordKey,
				);
			}
		});
		for (let sample = 0; sample < options.feedBatches; sample += 1) {
			feedSamples.push(timed(() => feedBatch(sample)) / options.batchSize);
		}

		database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		const countTable = candidate === 'wide' ? 'records' : 'confirmed_records';
		const recordCount = database
			.query<{ count: number }, []>(
				`SELECT count(*) AS count FROM ${countTable}`,
			)
			.get()?.count;
		if (recordCount !== options.records)
			throw new Error('record count mismatch');
		const integrityCheck = database
			.query<{ integrity_check: string }, []>('PRAGMA integrity_check')
			.get()?.integrity_check;
		if (integrityCheck !== 'ok')
			throw new Error(`integrity check: ${integrityCheck}`);

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
		const queryPlans = {
			pointRead:
				candidate === 'wide'
					? explain(database, pointWideSql, ['n', 'c', 'r'])
					: [
							...explain(database, pointConfirmedSql, ['n', 'c', 'r']),
							...explain(database, pointLocalSql, ['n', 'c', 'r']),
						],
			traversal: explain(database, traversalSql, ['n', 'c']),
			laneWrite: explain(database, laneWriteSql, ['{}', 'n', 'c', 'r']),
			feedInstall: explain(database, feedInstallSql, ['{}', 1, 'n', 'c', 'r']),
		};
		database.close();
		database = undefined;

		const reopenSamples: number[] = [];
		for (let sample = 0; sample < options.reopenSamples; sample += 1) {
			reopenSamples.push(
				timed(() => {
					const reopened = new Database(path, { strict: true });
					configure(reopened);
					const meta = reopened
						.query<{ format_version: number }, []>(
							'SELECT format_version FROM meta WHERE singleton = 1',
						)
						.get();
					if (meta?.format_version !== 1)
						throw new Error('reopen format mismatch');
					const probe = recordAt(sample % options.records, shape);
					const table = candidate === 'wide' ? 'records' : 'confirmed_records';
					const found = reopened
						.query(
							`SELECT record_key FROM ${table}
							WHERE namespace = ? AND collection = ? AND record_key = ?`,
						)
						.get(
							probe.address.namespace,
							probe.address.collection,
							probe.address.recordKey,
						);
					if (found === null) throw new Error('reopen point read missed');
					reopened.close();
				}),
			);
		}

		return {
			candidate,
			repetition,
			metrics: {
				pointRead: summarize(pointSamples),
				traversal: summarize(traversalSamples),
				laneWrite: summarize(laneSamples),
				feedInstall: summarize(feedSamples),
				reopen: summarize(reopenSamples),
			},
			storage: {
				pageSize,
				pageCount,
				freelistCount,
				liveBytes: (pageCount - freelistCount) * pageSize,
				fileBytes: fileBytes(path),
			},
			integrityCheck,
			recordCount,
			queryPlans,
		};
	} finally {
		database?.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

function median(values: readonly number[]): number {
	return percentile(values, 0.5);
}

function comparison(wideMs: number, splitMs: number) {
	return {
		wideMs,
		splitMs,
		differencePercent:
			(Math.abs(wideMs - splitMs) / Math.min(wideMs, splitMs)) * 100,
		faster: (wideMs <= splitMs ? 'wide' : 'split') as Candidate,
	};
}

function aggregate(runs: CandidateRun[]) {
	const metrics = {} as Record<
		Metric,
		{
			p50: ReturnType<typeof comparison>;
			p95: ReturnType<typeof comparison>;
		}
	>;
	for (const metric of [
		'pointRead',
		'traversal',
		'laneWrite',
		'feedInstall',
		'reopen',
	] as const) {
		const wide = runs.filter((run) => run.candidate === 'wide');
		const split = runs.filter((run) => run.candidate === 'split');
		metrics[metric] = {
			p50: comparison(
				median(wide.map((run) => run.metrics[metric].p50Ms)),
				median(split.map((run) => run.metrics[metric].p50Ms)),
			),
			p95: comparison(
				median(wide.map((run) => run.metrics[metric].p95Ms)),
				median(split.map((run) => run.metrics[metric].p95Ms)),
			),
		};
	}
	const differences = Object.values(metrics).flatMap((metric) => [
		metric.p50.differencePercent,
		metric.p95.differencePercent,
	]);
	return {
		metrics,
		stopRule: differences.some((difference) => difference > 20)
			? 'material-direction-found'
			: differences.every((difference) => difference < 10)
				? 'all-hot-metrics-equivalent'
				: 'continue-measurement',
	};
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function main(): void {
	const options = parseOptions(process.argv.slice(2));
	if (options === null) {
		console.log(HELP);
		return;
	}
	const startedAt = new Date().toISOString();
	const output = options.output;
	const reportOptions = { ...options };
	delete reportOptions.output;
	const shape = fixtureShape(options);
	const runs: CandidateRun[] = [];
	for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
		const order: Candidate[] =
			repetition % 2 === 0 ? ['wide', 'split'] : ['split', 'wide'];
		for (const candidate of order) {
			console.error(
				`running ${candidate} repetition ${repetition + 1}/${options.repetitions}`,
			);
			runs.push(runCandidate(candidate, repetition, options, shape));
		}
	}

	const source = readFileSync(import.meta.path);
	const runtimeDatabase = new Database(':memory:');
	const sqliteVersion = runtimeDatabase
		.query<{ version: string }, []>('SELECT sqlite_version() AS version')
		.get()?.version;
	runtimeDatabase.close();
	const finishedAt = new Date().toISOString();
	const report = {
		schemaVersion: 1,
		startedAt,
		finishedAt,
		durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
		charter: 'ADR-0177 wide-versus-split hot paths: Bun slice',
		proxy: {
			version: 1,
			encoding: 'UTF-8 bytes of RFC 8785 canonical {address,payload}',
			records: options.records,
			targetBytes: options.proxyBytes,
			emptyProxyBytes: shape.emptyProxyBytes,
			baseFillerBytes: shape.baseFillerBytes,
			extraFillerRecords: shape.extraFillerRecords,
		},
		measurement: {
			pointRead: 'milliseconds per address across batches of 64',
			traversal: 'milliseconds for one namespace and collection traversal',
			laneWrite: 'milliseconds per address across 64-address transactions',
			feedInstall: 'milliseconds per fact across 64-fact transactions',
			reopen: 'milliseconds to open, validate meta, and read one point',
		},
		runtime: {
			bun: Bun.version,
			sqlite: sqliteVersion,
			platform: platform(),
			release: release(),
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
		},
		options: reportOptions,
		sourceSha256: sha256(source),
		wideDdlOwner: 'packages/data/src/store/replica/schema.ts',
		installedSchemaEncoding:
			'JSON array of non-internal sqlite_schema tables and indexes ordered by type and name',
		wideSchemaSha256: installedSchemaSha256('wide'),
		splitSchemaSha256: installedSchemaSha256('split'),
		splitDdlSha256: sha256(SPLIT_DDL),
		runs,
		aggregate: aggregate(runs),
	};
	const json = `${JSON.stringify(report, null, 2)}\n`;
	if (output !== undefined) {
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, json);
	}
	console.log(json);
}

main();
