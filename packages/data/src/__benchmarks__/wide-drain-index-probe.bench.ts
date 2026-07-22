#!/usr/bin/env bun

/**
 * ADR-0177 decision-support probe: do the complete benchmark's wide-layout
 * drain-scan losses come from the physical wide layout, or only from the
 * production partial indexes covering record_id instead of the address?
 *
 * The probe builds the production wide schema at the full-fixture row count,
 * measures both publication drain scans against the production indexes, then
 * amends ONLY the two partial drain indexes to cover the address triple and
 * measures again. The amended shape is not production; it exists to attribute
 * the drain-scan gap to indexes versus layout.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { createReplicaStoreSchema } from '../store/replica/schema.js';

const RECORDS = 1_000_000;
const DOC_EVERY = 20;
const DOC_DIRTY_EVERY = 400;
const BLOB_EVERY = 25;
const PAYLOAD = JSON.stringify({ body: 'x'.repeat(420) });

const output = process.argv.includes('--output')
	? process.argv[process.argv.indexOf('--output') + 1]
	: undefined;

const directory = join(tmpdir(), `epicenter-wide-drain-probe-${process.pid}`);
mkdirSync(directory, { recursive: true });
const path = join(directory, 'wide.sqlite');
const database = new Database(path, { create: true, strict: true });
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA synchronous = NORMAL');
createReplicaStoreSchema(createBunSqliteAdapter(database), {
	replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
	authorityLifetime: 'lifetime-one',
});

const insert = database.prepare(
	`INSERT INTO records (
		namespace, collection, record_key,
		confirmed_state, confirmed_payload, confirmed_sequence,
		doc_revision, doc_dirty, blob_sha256, blob_pending
	) VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?)`,
);
const seed = database.transaction(() => {
	for (let index = 0; index < RECORDS; index += 1) {
		const hasDocument = index % DOC_EVERY === 0;
		const dirty = hasDocument && index % DOC_DIRTY_EVERY === 0 ? 1 : 0;
		const hasBlob = index % BLOB_EVERY === 0;
		insert.run(
			`so.epicenter.fixture${String(index % 25).padStart(2, '0')}`,
			`records${String(Math.floor(index / 25) % 40).padStart(2, '0')}`,
			index.toString(36).padStart(24, '0'),
			PAYLOAD,
			index + 1,
			hasDocument ? 1 : 0,
			dirty,
			hasBlob ? index.toString(16).padStart(64, '0') : null,
			hasBlob && index % (BLOB_EVERY * 2) === 0 ? 1 : 0,
		);
	}
});
seed();

const DOC_SCAN = `SELECT namespace, collection, record_key, doc_revision
	FROM records WHERE doc_dirty = 1
	ORDER BY namespace, collection, record_key`;
const BLOB_SCAN = `SELECT namespace, collection, record_key, blob_sha256
	FROM records WHERE blob_pending = 1
	ORDER BY namespace, collection, record_key`;

function timeScan(sql: string): { p50: number; raw: number[]; rows: number } {
	const raw: number[] = [];
	let rows = 0;
	for (let sample = 0; sample < 9; sample += 1) {
		const statement = database.prepare(sql);
		const started = performance.now();
		rows = statement.all().length;
		raw.push(performance.now() - started);
		statement.finalize();
	}
	const sorted = [...raw].sort((left, right) => left - right);
	return { p50: sorted[Math.floor(sorted.length / 2)] ?? 0, raw, rows };
}

function plan(sql: string): string {
	const statement = database.prepare(`EXPLAIN QUERY PLAN ${sql}`);
	const details = (statement.all() as { detail: string }[])
		.map((row) => row.detail)
		.join(' | ');
	statement.finalize();
	return details;
}

const before = {
	docDrain: timeScan(DOC_SCAN),
	blobDrain: timeScan(BLOB_SCAN),
	docPlan: plan(DOC_SCAN),
	blobPlan: plan(BLOB_SCAN),
};

database.exec('DROP INDEX records_doc_dirty');
database.exec('DROP INDEX records_blob_pending');
database.exec(`CREATE INDEX records_doc_dirty
	ON records(namespace, collection, record_key) WHERE doc_dirty = 1`);
database.exec(`CREATE INDEX records_blob_pending
	ON records(namespace, collection, record_key) WHERE blob_pending = 1`);

const after = {
	docDrain: timeScan(DOC_SCAN),
	blobDrain: timeScan(BLOB_SCAN),
	docPlan: plan(DOC_SCAN),
	blobPlan: plan(BLOB_SCAN),
};

const report = {
	probe: 'wide-drain-index-attribution',
	records: RECORDS,
	fileBytes: statSync(path).size,
	runtime: { bun: Bun.version },
	productionIndexes: before,
	amendedAddressIndexes: after,
};
const rendered = JSON.stringify(report, null, '\t');
console.log(rendered);
if (output !== undefined) {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${rendered}\n`);
}
database.close();
rmSync(directory, { recursive: true, force: true });
