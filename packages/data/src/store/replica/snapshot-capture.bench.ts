import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { openReplicaStore } from './replica-store.js';

const RECORD_COUNT = 100_000;
const directory = await mkdtemp(join(tmpdir(), 'epicenter-snapshot-probe-'));
const sourcePath = join(directory, 'source.sqlite3');
const source = new Database(sourcePath, { create: true, strict: true });
const writer = new Database(sourcePath, { strict: true });
const target = new Database(':memory:', { strict: true });

try {
	source.run('PRAGMA journal_mode = WAL');
	writer.run('PRAGMA journal_mode = WAL');
	const replica = openReplicaStore({
		database: createBunSqliteAdapter(source),
		limits: makeLimits(),
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'snapshot-probe-lifetime',
		},
	});
	const insert = source.prepare<void, [string, string, string, string, number]>(
		`INSERT INTO records (
			namespace, collection, record_key,
			confirmed_state, confirmed_payload, confirmed_sequence
		) VALUES (?, ?, ?, 'live', ?, ?)`,
	);
	source
		.transaction(() => {
			for (let index = 0; index < RECORD_COUNT; index += 1) {
				insert.run(
					'so.epicenter.snapshotprobe',
					'rows',
					index.toString(36).padStart(24, '0'),
					`{"generation":0,"index":${index}}`,
					index + 1,
				);
			}
			source.run('UPDATE meta SET after_sequence = ?', [RECORD_COUNT]);
		})
		.immediate();

	const targetAdapter = createBunSqliteAdapter(target);
	let raced = false;
	const racingTarget: SqliteDatabase = {
		run(sql, parameters) {
			targetAdapter.run(sql, parameters);
			if (raced || !sql.startsWith('INSERT INTO _epicenter_records')) return;
			raced = true;
			writer
				.transaction(() => {
					writer.run(
						`UPDATE records SET
						confirmed_payload = json_set(confirmed_payload, '$.generation', 1)`,
					);
					writer.run('UPDATE meta SET after_sequence = ?', [RECORD_COUNT + 1]);
				})
				.immediate();
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			return targetAdapter.all<TRow>(sql, parameters);
		},
		readTransaction<TResult>(run: () => TResult): TResult {
			return targetAdapter.readTransaction(run);
		},
		transaction<TResult>(run: () => TResult): TResult {
			return targetAdapter.transaction(run);
		},
	};

	const startedAt = performance.now();
	const metadata = replica.captureSnapshot({ database: racingTarget });
	const elapsedMs = performance.now() - startedAt;
	const captured = target
		.query<{ count: number; generation_sum: number }, []>(
			`SELECT count(*) AS count,
				sum(json_extract(payload_json, '$.generation')) AS generation_sum
			FROM _epicenter_records`,
		)
		.get();
	if (!raced) throw new Error('snapshot consistency race did not execute');
	if (
		metadata.recordCount !== RECORD_COUNT ||
		metadata.sourceAuthorityAfterSequence !== RECORD_COUNT ||
		captured?.count !== RECORD_COUNT ||
		captured.generation_sum !== 0
	) {
		throw new Error('snapshot did not preserve one coherent 100k read cut');
	}
	const sourceGeneration = writer
		.query<{ generation: number }, []>(
			`SELECT json_extract(confirmed_payload, '$.generation') AS generation
			FROM records LIMIT 1`,
		)
		.get()?.generation;
	if (sourceGeneration !== 1) {
		throw new Error('snapshot race did not commit the concurrent source write');
	}
	console.log(
		JSON.stringify({
			records: RECORD_COUNT,
			elapsedMs: Math.round(elapsedMs),
			rowsPerSecond: Math.round(RECORD_COUNT / (elapsedMs / 1_000)),
			oneReadCut: true,
		}),
	);
} finally {
	target.close();
	writer.close();
	source.close();
	await rm(directory, { recursive: true, force: true });
}
