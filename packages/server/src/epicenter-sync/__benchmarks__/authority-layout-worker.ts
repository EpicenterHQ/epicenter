import { DurableObject } from 'cloudflare:workers';

import {
	AUTHORITY_V1_FORMAT_VERSION,
	AUTHORITY_V1_SCHEMA_STATEMENTS,
} from '../authority-v1-schema.js';

type Candidate = 'wide' | 'split';
type SqlValue = ArrayBuffer | string | number | null;

type Fixture = {
	candidate: Candidate;
	records: number;
	baseFillerBytes: number;
	extraFillerRecords: number;
};

type QueryMetric = {
	milliseconds: number;
	rowsRead: number;
	rowsWritten: number;
};

const SPLIT_DDL = `
CREATE TABLE meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	format_version INTEGER NOT NULL,
	authority_lifetime TEXT NOT NULL,
	next_sequence INTEGER NOT NULL
		CHECK (next_sequence BETWEEN 1 AND 9007199254740992)
) STRICT;
CREATE TABLE facts (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT,
	sequence INTEGER NOT NULL
		CHECK (sequence BETWEEN 1 AND 9007199254740991),
	CHECK ((state = 'live' AND payload IS NOT NULL AND json_valid(payload))
		OR (state IN ('tombstone', 'unset') AND payload IS NULL)),
  PRIMARY KEY (namespace, collection, record_key)
) WITHOUT ROWID, STRICT;
CREATE UNIQUE INDEX facts_sequence ON facts(sequence);
CREATE TABLE accepted_blobs (
  namespace TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_key TEXT NOT NULL,
  sha256 TEXT NOT NULL
	CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (namespace, collection, record_key)
) WITHOUT ROWID, STRICT;
CREATE TABLE replica_witness (
	replica_id TEXT PRIMARY KEY
		CHECK (length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'),
	submission_number INTEGER NOT NULL
		CHECK (submission_number BETWEEN 1 AND 9007199254740991),
	request_hash TEXT NOT NULL
		CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
	parked TEXT NOT NULL CHECK (json_valid(parked))
) STRICT;
`;

const FIXTURE_DDL = `CREATE TABLE benchmark_fixture (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	candidate TEXT NOT NULL CHECK (candidate IN ('wide', 'split')),
	records INTEGER NOT NULL,
	base_filler_bytes INTEGER NOT NULL,
	extra_filler_records INTEGER NOT NULL
) STRICT`;

function addressAt(index: number) {
	const namespace = `so.epicenter.fixture${String(index % 25).padStart(2, '0')}`;
	return {
		namespace,
		collection:
			index % 100 === 0
				? 'settings'
				: `records${String(Math.floor(index / 25) % 40).padStart(2, '0')}`,
		recordKey:
			index % 100 === 0
				? `value${index}`
				: index.toString(36).padStart(24, '0'),
	};
}

function payloadAt(index: number, fixture: Fixture): string {
	const filler = 'x'.repeat(
		fixture.baseFillerBytes + (index < fixture.extraFillerRecords ? 1 : 0),
	);
	return JSON.stringify(index % 100 === 0 ? filler : { body: filler });
}

function metric(
	storage: DurableObjectStorage,
	sql: string,
	bindings: SqlValue[] = [],
): { metric: QueryMetric; rows: Record<string, SqlValue>[] } {
	const started = performance.now();
	const cursor = storage.sql.exec(sql, ...bindings);
	const rows = cursor.toArray() as Record<string, SqlValue>[];
	return {
		metric: {
			milliseconds: performance.now() - started,
			rowsRead: cursor.rowsRead,
			rowsWritten: cursor.rowsWritten,
		},
		rows,
	};
}

function sum(metrics: QueryMetric[]): QueryMetric {
	return metrics.reduce(
		(total, entry) => ({
			milliseconds: total.milliseconds + entry.milliseconds,
			rowsRead: total.rowsRead + entry.rowsRead,
			rowsWritten: total.rowsWritten + entry.rowsWritten,
		}),
		{ milliseconds: 0, rowsRead: 0, rowsWritten: 0 },
	);
}

function average(metricValue: QueryMetric, divisor: number): QueryMetric {
	return {
		milliseconds: metricValue.milliseconds / divisor,
		rowsRead: metricValue.rowsRead / divisor,
		rowsWritten: metricValue.rowsWritten / divisor,
	};
}

export class AuthorityLayoutBenchmark extends DurableObject {
	override async fetch(request: Request): Promise<Response> {
		const command = (await request.json()) as Record<string, unknown>;
		try {
			switch (command.command) {
				case 'initialize':
					return Response.json(
						this.initialize({
							candidate: command.candidate as Candidate,
							records: Number(command.records),
							baseFillerBytes: Number(command.baseFillerBytes),
							extraFillerRecords: Number(command.extraFillerRecords),
						}),
					);
				case 'seed':
					return Response.json(
						this.seed(Number(command.start), Number(command.count)),
					);
				case 'measure':
					return Response.json(
						this.measure(
							Number(command.repetitions),
							Number(command.batchSize),
						),
					);
				case 'inspect':
					return Response.json(this.inspect());
				default:
					return Response.json({ error: 'unknown-command' }, { status: 400 });
			}
		} catch (cause) {
			return Response.json(
				{ error: cause instanceof Error ? cause.message : String(cause) },
				{ status: 500 },
			);
		}
	}

	private initialize(fixture: Fixture) {
		const existing = this.ctx.storage.sql
			.exec(
				"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'meta'",
			)
			.toArray();
		if (existing.length === 0) {
			this.ctx.storage.transactionSync(() => {
				if (fixture.candidate === 'wide') {
					for (const statement of AUTHORITY_V1_SCHEMA_STATEMENTS) {
						this.ctx.storage.sql.exec(statement);
					}
				} else {
					this.ctx.storage.sql.exec(SPLIT_DDL);
				}
				this.ctx.storage.sql.exec(
					`INSERT INTO meta (
						singleton, format_version, authority_lifetime, next_sequence
					) VALUES (1, ?, 'benchmark-authority-lifetime', 1)`,
					AUTHORITY_V1_FORMAT_VERSION,
				);
				this.ctx.storage.sql.exec(FIXTURE_DDL);
				this.ctx.storage.sql.exec(
					`INSERT INTO benchmark_fixture (
						singleton, candidate, records, base_filler_bytes,
						extra_filler_records
					) VALUES (1, ?, ?, ?, ?)`,
					fixture.candidate,
					fixture.records,
					fixture.baseFillerBytes,
					fixture.extraFillerRecords,
				);
			});
		}
		const stored = this.fixture();
		if (JSON.stringify(stored) !== JSON.stringify(fixture)) {
			throw new Error('fixture does not match the persisted benchmark');
		}
		return {
			initialized: true,
			databaseSize: this.ctx.storage.sql.databaseSize,
		};
	}

	private fixture(): Fixture {
		const row = this.ctx.storage.sql
			.exec<{
				candidate: Candidate;
				records: number;
				base_filler_bytes: number;
				extra_filler_records: number;
			}>('SELECT * FROM benchmark_fixture WHERE singleton = 1')
			.one();
		return {
			candidate: row.candidate,
			records: row.records,
			baseFillerBytes: row.base_filler_bytes,
			extraFillerRecords: row.extra_filler_records,
		};
	}

	private seed(start: number, count: number) {
		const fixture = this.fixture();
		let rowsWritten = 0;
		const started = performance.now();
		this.ctx.storage.transactionSync(() => {
			for (let index = start; index < start + count; index += 1) {
				const address = addressAt(index);
				const sql =
					fixture.candidate === 'wide'
						? `INSERT INTO records (
							namespace, collection, record_key, state, payload, sequence
						) VALUES (?, ?, ?, 'live', ?, ?)`
						: `INSERT INTO facts (
							namespace, collection, record_key, state, payload, sequence
						) VALUES (?, ?, ?, 'live', ?, ?)`;
				const cursor = this.ctx.storage.sql.exec(
					sql,
					address.namespace,
					address.collection,
					address.recordKey,
					payloadAt(index, fixture),
					index + 1,
				);
				cursor.toArray();
				rowsWritten += cursor.rowsWritten;
			}
		});
		return {
			milliseconds: performance.now() - started,
			rowsWritten,
			databaseSize: this.ctx.storage.sql.databaseSize,
		};
	}

	private measure(repetitions: number, batchSize: number) {
		const fixture = this.fixture();
		const point: QueryMetric[] = [];
		const feed: QueryMetric[] = [];
		const factWrite: QueryMetric[] = [];
		const blobWrite: QueryMetric[] = [];
		const settlement: QueryMetric[] = [];

		for (let repetition = 0; repetition < repetitions; repetition += 1) {
			const pointMetrics: QueryMetric[] = [];
			for (let offset = 0; offset < batchSize; offset += 1) {
				const index =
					(repetition * batchSize * 7919 + offset * 104729) % fixture.records;
				const address = addressAt(index);
				const table = fixture.candidate === 'wide' ? 'records' : 'facts';
				pointMetrics.push(
					metric(
						this.ctx.storage,
						`SELECT state, payload, sequence FROM ${table}
						WHERE namespace = ? AND collection = ? AND record_key = ?`,
						[address.namespace, address.collection, address.recordKey],
					).metric,
				);
			}
			point.push(average(sum(pointMetrics), batchSize));

			const feedTable = fixture.candidate === 'wide' ? 'records' : 'facts';
			feed.push(
				average(
					metric(
						this.ctx.storage,
						`SELECT namespace, collection, record_key, state, payload, sequence
						FROM ${feedTable} WHERE sequence > ? ORDER BY sequence LIMIT ?`,
						[(repetition * batchSize) % fixture.records, batchSize],
					).metric,
					batchSize,
				),
			);

			const updateMetrics: QueryMetric[] = [];
			this.ctx.storage.transactionSync(() => {
				for (let offset = 0; offset < batchSize; offset += 1) {
					const index = (repetition * batchSize + offset) % fixture.records;
					const address = addressAt(index);
					updateMetrics.push(
						metric(
							this.ctx.storage,
							fixture.candidate === 'wide'
								? `INSERT INTO records (
									namespace, collection, record_key, state, payload, sequence
								) VALUES (?, ?, ?, 'live', ?, ?)
								ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
									state = excluded.state,
									payload = excluded.payload,
									sequence = excluded.sequence,
									accepted_blob_sha256 = records.accepted_blob_sha256`
								: `INSERT INTO facts (
									namespace, collection, record_key, state, payload, sequence
								) VALUES (?, ?, ?, 'live', ?, ?)
								ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
									state = excluded.state,
									payload = excluded.payload,
									sequence = excluded.sequence`,
							[
								address.namespace,
								address.collection,
								address.recordKey,
								payloadAt(index, fixture),
								fixture.records + repetition * batchSize + offset + 1,
							],
						).metric,
					);
				}
			});
			factWrite.push(average(sum(updateMetrics), batchSize));

			const blobMetrics: QueryMetric[] = [];
			this.ctx.storage.transactionSync(() => {
				for (let offset = 0; offset < batchSize; offset += 1) {
					const index =
						(repetition * batchSize + offset + batchSize) % fixture.records;
					const address = addressAt(index);
					blobMetrics.push(
						metric(
							this.ctx.storage,
							fixture.candidate === 'wide'
								? `UPDATE records SET accepted_blob_sha256 = ?
									WHERE namespace = ? AND collection = ? AND record_key = ?`
								: `INSERT INTO accepted_blobs (
										namespace, collection, record_key, sha256
									) VALUES (?, ?, ?, ?)
									ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
										sha256 = excluded.sha256`,
							fixture.candidate === 'wide'
								? [
										'a'.repeat(64),
										address.namespace,
										address.collection,
										address.recordKey,
									]
								: [
										address.namespace,
										address.collection,
										address.recordKey,
										'a'.repeat(64),
									],
						).metric,
					);
				}
			});
			blobWrite.push(average(sum(blobMetrics), batchSize));

			const settlementMetrics: QueryMetric[] = [];
			const settlementAddresses = Array.from(
				{ length: batchSize },
				(_, offset) => {
					const index =
						(repetition * batchSize + offset + batchSize * 2) % fixture.records;
					return { address: addressAt(index), index, offset };
				},
			);
			const started = performance.now();
			this.ctx.storage.transactionSync(() => {
				settlementMetrics.push(
					metric(
						this.ctx.storage,
						'SELECT authority_lifetime, next_sequence FROM meta WHERE singleton = 1',
					).metric,
					metric(
						this.ctx.storage,
						'SELECT submission_number, request_hash, parked FROM replica_witness WHERE replica_id = ?',
						['rrrrrrrrrrrrrrrrrrrrrrrr'],
					).metric,
				);
				for (const { address } of settlementAddresses) {
					settlementMetrics.push(
						metric(
							this.ctx.storage,
							`SELECT state, payload, sequence FROM ${fixture.candidate === 'wide' ? 'records' : 'facts'}
							WHERE namespace = ? AND collection = ? AND record_key = ?`,
							[address.namespace, address.collection, address.recordKey],
						).metric,
					);
				}
				for (const { address, index, offset } of settlementAddresses) {
					settlementMetrics.push(
						metric(
							this.ctx.storage,
							fixture.candidate === 'wide'
								? `INSERT INTO records (
									namespace, collection, record_key, state, payload, sequence
								) VALUES (?, ?, ?, 'live', ?, ?)
								ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
									state = excluded.state,
									payload = excluded.payload,
									sequence = excluded.sequence,
									accepted_blob_sha256 = CASE
										WHEN excluded.state = 'tombstone' THEN NULL
										ELSE records.accepted_blob_sha256
									END`
								: `INSERT INTO facts (
									namespace, collection, record_key, state, payload, sequence
								) VALUES (?, ?, ?, 'live', ?, ?)
								ON CONFLICT(namespace, collection, record_key) DO UPDATE SET
									state = excluded.state,
									payload = excluded.payload,
									sequence = excluded.sequence`,
							[
								address.namespace,
								address.collection,
								address.recordKey,
								payloadAt(index, fixture),
								fixture.records +
									(repetitions + repetition) * batchSize +
									offset +
									1,
							],
						).metric,
					);
				}
				settlementMetrics.push(
					metric(
						this.ctx.storage,
						'UPDATE meta SET next_sequence = next_sequence + ? WHERE singleton = 1',
						[batchSize],
					).metric,
				);
				settlementMetrics.push(
					metric(
						this.ctx.storage,
						`INSERT INTO replica_witness (
							replica_id, submission_number, request_hash, parked
						) VALUES (?, ?, ?, '[]')
						ON CONFLICT(replica_id) DO UPDATE SET
							submission_number = excluded.submission_number,
							request_hash = excluded.request_hash,
							parked = excluded.parked`,
						['rrrrrrrrrrrrrrrrrrrrrrrr', repetition + 1, 'b'.repeat(64)],
					).metric,
				);
				for (const { address } of settlementAddresses) {
					settlementMetrics.push(
						metric(
							this.ctx.storage,
							`SELECT state, payload, sequence FROM ${fixture.candidate === 'wide' ? 'records' : 'facts'}
							WHERE namespace = ? AND collection = ? AND record_key = ?`,
							[address.namespace, address.collection, address.recordKey],
						).metric,
					);
				}
			});
			const settlementTotal = sum(settlementMetrics);
			settlement.push({
				...settlementTotal,
				milliseconds: performance.now() - started,
			});
		}

		return {
			candidate: fixture.candidate,
			point,
			feed,
			factWrite,
			blobWrite,
			settlement,
			databaseSize: this.ctx.storage.sql.databaseSize,
			rowCount: this.ctx.storage.sql
				.exec<{ count: number }>(
					`SELECT count(*) AS count FROM ${fixture.candidate === 'wide' ? 'records' : 'facts'}`,
				)
				.one().count,
		};
	}

	private inspect() {
		const fixture = this.fixture();
		const table = fixture.candidate === 'wide' ? 'records' : 'facts';
		const count = this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
			.one().count;
		return {
			candidate: fixture.candidate,
			count,
			databaseSize: this.ctx.storage.sql.databaseSize,
		};
	}
}

export default {
	async fetch(request: Request, env: { LAYOUT: DurableObjectNamespace }) {
		const url = new URL(request.url);
		const candidate = url.searchParams.get('candidate');
		if (candidate !== 'wide' && candidate !== 'split') {
			return Response.json({ error: 'invalid-candidate' }, { status: 400 });
		}
		return env.LAYOUT.getByName(candidate).fetch(request);
	},
};
