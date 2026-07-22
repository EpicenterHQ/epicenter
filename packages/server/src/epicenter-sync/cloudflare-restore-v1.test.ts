/**
 * Cloudflare Restore SQL Kernel Tests
 *
 * Verifies construction and atomic activation of a portable artifact inside
 * authority-owned SQLite across Bun and Durable Object adapter semantics.
 *
 * Key behaviors:
 * - Portable records become a fresh authority with exact monotone positions
 * - Activation is all-old or all-successor across every injected DDL failure
 * - Startup recovery drops exact staging tables and leaves unknown objects
 */
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import type { PortableArtifactRecord } from '@epicenter/data/portable';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

import {
	AUTHORITY_V1_CORE_SCHEMA_STATEMENTS,
	AUTHORITY_V1_FORMAT_VERSION,
	createAuthorityV1Schema,
	openAuthorityV1Schema,
} from './authority-v1-schema.js';
import {
	abandonCloudflareRestoreV1,
	activateCloudflareRestoreV1,
	appendCloudflareRestoreV1Page,
	initializeCloudflareRestoreV1,
	recoverCloudflareRestoreV1,
	sealCloudflareRestoreV1,
} from './cloudflare-restore-v1.js';

const OUTGOING = 'outgoing-lifetime';
const SUCCESSOR = 'successor-lifetime';

const FIRST: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	scalar: { state: 'live', payload: { title: 'First' } },
	documentUpdateV2: new Uint8Array([1, 2, 3]),
	blobSha256: null,
};

const SECOND: PortableArtifactRecord = {
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'notes',
		recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	},
	scalar: { state: 'unset' },
	documentUpdateV2: null,
	blobSha256: 'b'.repeat(64),
};

type Binding = {
	name: string;
	adapt(raw: Database): SqliteDatabase;
};

const bindings: readonly Binding[] = [
	{
		name: 'Bun SQLite',
		adapt: createBunSqliteAdapter,
	},
	{
		name: 'Durable Object SQLite adapter',
		adapt(raw) {
			const storage: DurableObjectSqliteStorage = {
				sql: {
					exec<TRow extends SqliteRow>(
						query: string,
						...bindings: SqliteValue[]
					) {
						const statement = raw.query(query);
						if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
							return {
								toArray: () =>
									statement.all(...(bindings as SQLQueryBindings[])) as TRow[],
							};
						}
						statement.run(...(bindings as SQLQueryBindings[]));
						return { toArray: () => [] as TRow[] };
					},
				},
				transactionSync<TResult>(run: () => TResult): TResult {
					return raw.transaction(run).immediate();
				},
			};
			return createDurableObjectSqliteAdapter(storage);
		},
	},
];

function setup(binding: Binding) {
	const raw = new Database(':memory:', { strict: true });
	const database = binding.adapt(raw);
	database.transaction(() => createAuthorityV1Schema(database, OUTGOING));
	database.run(
		`INSERT INTO records (
			record_id, namespace, collection, record_key, state, payload,
			sequence, capture_revision, accepted_blob_sha256
		) VALUES (1, 'old', 'old', 'old', 'live', '{}', 1, 1, NULL)`,
	);
	database.run(
		`UPDATE meta SET next_sequence = 2, next_capture_revision = 2
		WHERE singleton = 1`,
	);
	return { raw, database };
}

function setupSealed(binding: Binding) {
	const owned = setup(binding);
	initializeCloudflareRestoreV1({
		database: owned.database,
		successorAuthorityLifetime: SUCCESSOR,
	});
	appendCloudflareRestoreV1Page({
		database: owned.database,
		records: [FIRST, SECOND],
	});
	sealCloudflareRestoreV1({
		database: owned.database,
		expectedRecordCount: 2,
	});
	return owned;
}

for (const binding of bindings) {
	describe(binding.name, () => {
		test('sealed staging activates as one fresh canonical authority', () => {
			const owned = setupSealed(binding);
			try {
				expect(
					activateCloudflareRestoreV1({
						database: owned.database,
						outgoingAuthorityLifetime: OUTGOING,
					}),
				).toEqual({ authorityLifetime: SUCCESSOR, recordCount: 2 });
				openAuthorityV1Schema(owned.database, undefined);
				expect(
					owned.raw
						.query(
							`SELECT format_version, authority_lifetime, next_sequence,
								next_capture_revision FROM meta`,
						)
						.get(),
				).toEqual({
					format_version: AUTHORITY_V1_FORMAT_VERSION,
					authority_lifetime: SUCCESSOR,
					next_sequence: 3,
					next_capture_revision: 3,
				});
				expect(
					owned.raw
						.query(
							`SELECT record_id, namespace, state, payload, sequence,
								capture_revision, accepted_blob_sha256
							FROM records ORDER BY record_id`,
						)
						.all(),
				).toEqual([
					{
						record_id: 1,
						namespace: 'so.epicenter.notes',
						state: 'live',
						payload: '{"title":"First"}',
						sequence: 1,
						capture_revision: 1,
						accepted_blob_sha256: null,
					},
					{
						record_id: 2,
						namespace: 'so.epicenter.notes',
						state: 'unset',
						payload: null,
						sequence: 2,
						capture_revision: 2,
						accepted_blob_sha256: 'b'.repeat(64),
					},
				]);
				expect(
					owned.raw
						.query(
							`SELECT record_id, seq, kind, bytes
							FROM record_documents`,
						)
						.get(),
				).toEqual({
					record_id: 1,
					seq: 1,
					kind: 'baseline',
					bytes: new Uint8Array([1, 2, 3]),
				});
				expect(
					owned.raw
						.query(
							`SELECT
								(SELECT count(*) FROM replica_witness) AS witnesses,
								(SELECT count(*) FROM capture_manifests) AS captures,
								(SELECT count(*) FROM capture_manifest_records)
									AS capture_records`,
						)
						.get(),
				).toEqual({ witnesses: 0, captures: 0, capture_records: 0 });
				expect(
					owned.raw
						.query<{ name: string }, []>(
							`SELECT name FROM sqlite_schema
							WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
							ORDER BY name`,
						)
						.all(),
				).toEqual([{ name: 'capture_manifests_one_active' }]);
				const insert = owned.raw.query(
					`INSERT INTO records (
						record_id, namespace, collection, record_key, state, payload,
						sequence, capture_revision, accepted_blob_sha256
					) VALUES (?, ?, 'notes', ?, 'unset', NULL, ?, ?, NULL)`,
				);
				expect(() =>
					insert.run(3, 'so.epicenter.notes', FIRST.address.recordKey, 3, 3),
				).toThrow();
				expect(() =>
					insert.run(3, 'unique', 'unique-sequence', 1, 3),
				).toThrow();
				expect(() =>
					insert.run(3, 'unique', 'unique-revision', 3, 1),
				).toThrow();
			} finally {
				owned.raw.close();
			}
		});

		test('stale outgoing lifetime refuses activation without changing either core', () => {
			const owned = setupSealed(binding);
			try {
				owned.database.run(
					`UPDATE meta SET authority_lifetime = 'new-incumbent'
					WHERE singleton = 1`,
				);
				expect(() =>
					activateCloudflareRestoreV1({
						database: owned.database,
						outgoingAuthorityLifetime: OUTGOING,
					}),
				).toThrow('outgoing lifetime is stale');
				expect(
					owned.raw.query('SELECT authority_lifetime FROM meta').get(),
				).toEqual({ authority_lifetime: 'new-incumbent' });
				expect(
					owned.raw
						.query(
							`SELECT authority_lifetime
							FROM _epicenter_restore_v1_meta`,
						)
						.get(),
				).toEqual({ authority_lifetime: SUCCESSOR });
			} finally {
				owned.raw.close();
			}
		});
	});
}

test('page and seal failures leave disposable building storage', () => {
	const owned = setup(bindings[0] as Binding);
	try {
		initializeCloudflareRestoreV1({
			database: owned.database,
			successorAuthorityLifetime: SUCCESSOR,
		});
		expect(() =>
			appendCloudflareRestoreV1Page({
				database: owned.database,
				records: [FIRST, FIRST],
			}),
		).toThrow();
		expect(() =>
			sealCloudflareRestoreV1({
				database: owned.database,
				expectedRecordCount: 1,
			}),
		).toThrow('membership is incomplete');
		expect(
			sealCloudflareRestoreV1({
				database: owned.database,
				expectedRecordCount: 0,
			}),
		).toEqual({ authorityLifetime: SUCCESSOR, recordCount: 0 });
		expect(() =>
			appendCloudflareRestoreV1Page({
				database: owned.database,
				records: [FIRST],
			}),
		).toThrow('not building');
	} finally {
		owned.raw.close();
	}
});

test('startup recovery removes exact staging tables but preserves unknown objects', () => {
	const owned = setup(bindings[0] as Binding);
	try {
		initializeCloudflareRestoreV1({
			database: owned.database,
			successorAuthorityLifetime: SUCCESSOR,
		});
		owned.database.run(
			`CREATE INDEX unknown_restore_index
			ON _epicenter_restore_v1_records(state)`,
		);
		expect(() => recoverCloudflareRestoreV1(owned.database)).toThrow(
			'unknown attached schema objects',
		);
		expect(
			owned.raw
				.query(
					`SELECT name FROM sqlite_schema
					WHERE name = 'unknown_restore_index'`,
				)
				.get(),
		).toEqual({ name: 'unknown_restore_index' });
		owned.database.run('DROP INDEX unknown_restore_index');
		owned.database.run(
			'CREATE TABLE _epicenter_restore_v2_unknown (id INTEGER)',
		);
		recoverCloudflareRestoreV1(owned.database);
		expect(
			owned.raw
				.query(
					`SELECT name FROM sqlite_schema
					WHERE name LIKE '_epicenter_restore_v1_%'`,
				)
				.all(),
		).toEqual([]);
		expect(
			owned.raw
				.query(
					`SELECT name FROM sqlite_schema
					WHERE name = '_epicenter_restore_v2_unknown'`,
				)
				.get(),
		).toEqual({ name: '_epicenter_restore_v2_unknown' });
		expect(() => openAuthorityV1Schema(owned.database, undefined)).toThrow();
		owned.database.run('DROP TABLE _epicenter_restore_v2_unknown');
		owned.database.run(
			'CREATE VIEW _epicenter_restore_v2_unknown AS SELECT 1 AS id',
		);
		expect(() => openAuthorityV1Schema(owned.database, undefined)).toThrow();
		owned.database.run('DROP VIEW _epicenter_restore_v2_unknown');
		openAuthorityV1Schema(owned.database, undefined);
		abandonCloudflareRestoreV1(owned.database);
	} finally {
		owned.raw.close();
	}
});

test('format-5 opener refuses records without all three inline UNIQUE constraints', () => {
	const raw = new Database(':memory:', { strict: true });
	try {
		const database = createBunSqliteAdapter(raw);
		database.transaction(() => createAuthorityV1Schema(database, OUTGOING));
		database.run('DROP TABLE records');
		const canonicalRecords = AUTHORITY_V1_CORE_SCHEMA_STATEMENTS[1];
		if (canonicalRecords === undefined)
			throw new Error('records DDL is missing');
		const malformed = canonicalRecords
			.replace('\n\t\tUNIQUE (namespace, collection, record_key),', '')
			.replace('\n\t\tUNIQUE (sequence),', '')
			.replace('\n\t\tUNIQUE (capture_revision),', '');
		database.run(malformed);
		expect(() => openAuthorityV1Schema(database, undefined)).toThrow(
			'records uniqueness does not match format 5',
		);
	} finally {
		raw.close();
	}
});

test('every activation statement failure rolls back to the complete outgoing authority', () => {
	const counted = setupSealed(bindings[0] as Binding);
	let statementCount = 0;
	try {
		const countingDatabase: SqliteDatabase = {
			...counted.database,
			run(sql, parameters) {
				statementCount += 1;
				counted.database.run(sql, parameters);
			},
		};
		activateCloudflareRestoreV1({
			database: countingDatabase,
			outgoingAuthorityLifetime: OUTGOING,
		});
	} finally {
		counted.raw.close();
	}
	expect(statementCount).toBeGreaterThan(0);

	for (let failAt = 1; failAt <= statementCount; failAt += 1) {
		const owned = setupSealed(bindings[0] as Binding);
		let current = 0;
		try {
			const failingDatabase: SqliteDatabase = {
				...owned.database,
				run(sql, parameters) {
					current += 1;
					if (current === failAt) throw new Error(`crash-${failAt}`);
					owned.database.run(sql, parameters);
				},
			};
			expect(() =>
				activateCloudflareRestoreV1({
					database: failingDatabase,
					outgoingAuthorityLifetime: OUTGOING,
				}),
			).toThrow(`crash-${failAt}`);
			expect(
				owned.raw.query('SELECT authority_lifetime FROM meta').get(),
			).toEqual({ authority_lifetime: OUTGOING });
			expect(owned.raw.query('SELECT namespace FROM records').all()).toEqual([
				{ namespace: 'old' },
			]);
			expect(
				owned.raw
					.query(
						`SELECT authority_lifetime
						FROM _epicenter_restore_v1_meta`,
					)
					.get(),
			).toEqual({ authority_lifetime: SUCCESSOR });
		} finally {
			owned.raw.close();
		}
	}
});
