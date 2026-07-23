#!/usr/bin/env bun

/**
 * ADR-0177 decision-support probe for the target document/blob watermark model.
 *
 * This isolates the remaining fairness question after the complete replica
 * benchmark: when both physical candidates derive publication obligations from
 * local truth versus authority-accepted watermarks and both have covering drain
 * indexes, does split retain a material drain or settlement advantage?
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const RECORDS = 1_000_000;
const DOC_EVERY = 20;
const DOC_OWED_EVERY = 400;
const BLOB_EVERY = 25;
const BLOB_OWED_EVERY = 50;
const SAMPLES = 9;

type Candidate = 'wide' | 'split';

type Measurement = {
	p50Ms: number;
	rawMs: number[];
	rows: number;
};

const output = process.argv.includes('--output')
	? process.argv[process.argv.indexOf('--output') + 1]
	: undefined;
const directory = join(tmpdir(), `epicenter-watermark-layout-${process.pid}`);
mkdirSync(directory, { recursive: true });

function address(index: number): [string, string, string] {
	return [
		`so.epicenter.fixture${String(index % 25).padStart(2, '0')}`,
		`records${String(Math.floor(index / 25) % 40).padStart(2, '0')}`,
		index.toString(36).padStart(24, '0'),
	];
}

function digest(index: number): string {
	return index.toString(16).padStart(64, '0');
}

function sha256(value: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(value);
	return hasher.digest('hex');
}

function gitOutput(...args: string[]): string {
	const result = Bun.spawnSync(['git', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function open(candidate: Candidate): { database: Database; path: string } {
	const path = join(directory, `${candidate}.sqlite`);
	const database = new Database(path, { create: true, strict: true });
	database.exec('PRAGMA journal_mode = WAL');
	database.exec('PRAGMA synchronous = NORMAL');
	return { database, path };
}

function seedWide(database: Database): void {
	database.exec(`CREATE TABLE records (
		record_id INTEGER PRIMARY KEY,
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		confirmed_payload TEXT NOT NULL,
		document_revision INTEGER NOT NULL DEFAULT 0,
		document_accepted_revision INTEGER NOT NULL DEFAULT 0,
		document_refused_revision INTEGER,
		document_refused_bytes INTEGER,
		document_refused_structs INTEGER,
		blob_sha256 TEXT,
		blob_accepted_sha256 TEXT,
		blob_parked_code TEXT,
		UNIQUE (namespace, collection, record_key),
		CHECK (document_accepted_revision <= document_revision)
	) STRICT`);
	database.exec(`CREATE INDEX records_document_owed
		ON records(namespace, collection, record_key)
		WHERE document_revision > document_accepted_revision`);
	database.exec(`CREATE INDEX records_blob_owed
		ON records(namespace, collection, record_key)
		WHERE blob_sha256 IS NOT NULL AND
			(blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256)`);

	const insert = database.prepare(`INSERT INTO records (
		namespace, collection, record_key, confirmed_payload,
		document_revision, document_accepted_revision,
		blob_sha256, blob_accepted_sha256
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	const seed = database.transaction(() => {
		for (let index = 0; index < RECORDS; index += 1) {
			const hasDocument = index % DOC_EVERY === 0;
			const documentOwed = hasDocument && index % DOC_OWED_EVERY === 0;
			const hasBlob = index % BLOB_EVERY === 0;
			const blobOwed = hasBlob && index % BLOB_OWED_EVERY === 0;
			const blobDigest = hasBlob ? digest(index) : null;
			insert.run(
				...address(index),
				JSON.stringify({ index }),
				hasDocument ? 2 : 0,
				documentOwed ? 1 : hasDocument ? 2 : 0,
				blobDigest,
				blobOwed ? null : blobDigest,
			);
		}
	});
	seed();
	insert.finalize();
}

function seedSplit(database: Database): void {
	database.exec(`CREATE TABLE confirmed_records (
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		payload TEXT NOT NULL,
		PRIMARY KEY (namespace, collection, record_key)
	) WITHOUT ROWID, STRICT`);
	database.exec(`CREATE TABLE document_state (
		document_id INTEGER PRIMARY KEY,
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		document_revision INTEGER NOT NULL,
		document_accepted_revision INTEGER NOT NULL,
		document_refused_revision INTEGER,
		document_refused_bytes INTEGER,
		document_refused_structs INTEGER,
		UNIQUE (namespace, collection, record_key),
		CHECK (document_accepted_revision <= document_revision)
	) STRICT`);
	database.exec(`CREATE INDEX document_state_owed
		ON document_state(namespace, collection, record_key)
		WHERE document_revision > document_accepted_revision`);
	database.exec(`CREATE TABLE blob_state (
		namespace TEXT NOT NULL,
		collection TEXT NOT NULL,
		record_key TEXT NOT NULL,
		blob_sha256 TEXT NOT NULL,
		blob_accepted_sha256 TEXT,
		blob_parked_code TEXT,
		PRIMARY KEY (namespace, collection, record_key)
	) WITHOUT ROWID, STRICT`);
	database.exec(`CREATE INDEX blob_state_owed
		ON blob_state(namespace, collection, record_key)
		WHERE blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256`);

	const insertConfirmed = database.prepare(
		'INSERT INTO confirmed_records VALUES (?, ?, ?, ?)',
	);
	const insertDocument = database.prepare(`INSERT INTO document_state (
		namespace, collection, record_key,
		document_revision, document_accepted_revision
	) VALUES (?, ?, ?, ?, ?)`);
	const insertBlob = database.prepare(`INSERT INTO blob_state (
		namespace, collection, record_key, blob_sha256, blob_accepted_sha256
	) VALUES (?, ?, ?, ?, ?)`);
	const seed = database.transaction(() => {
		for (let index = 0; index < RECORDS; index += 1) {
			const triple = address(index);
			insertConfirmed.run(...triple, JSON.stringify({ index }));
			if (index % DOC_EVERY === 0) {
				insertDocument.run(...triple, 2, index % DOC_OWED_EVERY === 0 ? 1 : 2);
			}
			if (index % BLOB_EVERY === 0) {
				const blobDigest = digest(index);
				insertBlob.run(
					...triple,
					blobDigest,
					index % BLOB_OWED_EVERY === 0 ? null : blobDigest,
				);
			}
		}
	});
	seed();
	insertConfirmed.finalize();
	insertDocument.finalize();
	insertBlob.finalize();
}

function timeRows(database: Database, sql: string): Measurement {
	const rawMs: number[] = [];
	let rows = 0;
	for (let sample = 0; sample < SAMPLES; sample += 1) {
		const statement = database.prepare(sql);
		const started = performance.now();
		rows = statement.all().length;
		rawMs.push(performance.now() - started);
		statement.finalize();
	}
	const sorted = [...rawMs].sort((left, right) => left - right);
	return { p50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0, rawMs, rows };
}

function timeSettlement(
	database: Database,
	statementSql: string,
	owedIndexes: number[],
): Measurement {
	const rawMs: number[] = [];
	let rows = 0;
	for (let sample = 0; sample < SAMPLES; sample += 1) {
		database.exec('SAVEPOINT measurement');
		const statement = database.prepare(statementSql);
		const started = performance.now();
		for (const index of owedIndexes) {
			statement.run(...address(index));
			rows += 1;
		}
		rawMs.push(performance.now() - started);
		statement.finalize();
		database.exec('ROLLBACK TO measurement');
		database.exec('RELEASE measurement');
	}
	const sorted = [...rawMs].sort((left, right) => left - right);
	return {
		p50Ms: sorted[Math.floor(sorted.length / 2)] ?? 0,
		rawMs,
		rows: rows / SAMPLES,
	};
}

function measure(candidate: Candidate) {
	const { database, path } = open(candidate);
	if (candidate === 'wide') seedWide(database);
	else seedSplit(database);
	database.exec('PRAGMA wal_checkpoint(TRUNCATE)');

	const recordTable = candidate === 'wide' ? 'records' : 'document_state';
	const blobTable = candidate === 'wide' ? 'records' : 'blob_state';
	const owedDocuments = Array.from(
		{ length: Math.ceil(RECORDS / DOC_OWED_EVERY) },
		(_, offset) => offset * DOC_OWED_EVERY,
	).slice(0, 64);
	const owedBlobs = Array.from(
		{ length: Math.ceil(RECORDS / BLOB_OWED_EVERY) },
		(_, offset) => offset * BLOB_OWED_EVERY,
	).slice(0, 64);

	const result = {
		fileBytes: statSync(path).size,
		schemaSha256: sha256(
			database
				.query<{ sql: string }, []>(
					`SELECT sql FROM sqlite_schema
					WHERE sql IS NOT NULL ORDER BY type, name`,
				)
				.all()
				.map((row) => row.sql)
				.join('\n'),
		),
		documentDrain: timeRows(
			database,
			`SELECT namespace, collection, record_key FROM ${recordTable}
			WHERE document_revision > document_accepted_revision
			ORDER BY namespace, collection, record_key`,
		),
		blobDrain: timeRows(
			database,
			`SELECT namespace, collection, record_key FROM ${blobTable}
			WHERE blob_sha256 IS NOT NULL AND
				(blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256)
			ORDER BY namespace, collection, record_key`,
		),
		documentSettlement: timeSettlement(
			database,
			`UPDATE ${recordTable}
			SET document_accepted_revision = document_revision
			WHERE namespace = ? AND collection = ? AND record_key = ?`,
			owedDocuments,
		),
		blobSettlement: timeSettlement(
			database,
			`UPDATE ${blobTable}
			SET blob_accepted_sha256 = blob_sha256
			WHERE namespace = ? AND collection = ? AND record_key = ?`,
			owedBlobs,
		),
	};
	database.close();
	return result;
}

const report = {
	probe: 'replica-watermark-layout-fairness',
	source: {
		commit: gitOutput('rev-parse', 'HEAD'),
		clean: gitOutput('status', '--porcelain').length === 0,
	},
	records: RECORDS,
	documentEvery: DOC_EVERY,
	documentOwedEvery: DOC_OWED_EVERY,
	blobEvery: BLOB_EVERY,
	blobOwedEvery: BLOB_OWED_EVERY,
	runtime: {
		bun: Bun.version,
		platform: platform(),
		release: release(),
		arch: arch(),
	},
	wide: measure('wide'),
	split: measure('split'),
};
const rendered = JSON.stringify(report, null, '\t');
console.log(rendered);
if (output !== undefined) {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${rendered}\n`);
}
rmSync(directory, { recursive: true, force: true });
