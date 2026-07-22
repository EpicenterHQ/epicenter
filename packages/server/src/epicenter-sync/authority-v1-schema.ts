import {
	type SqliteDatabase,
	type SqliteRow,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

export const AUTHORITY_V1_FORMAT_VERSION = 2;

export const AUTHORITY_V1_TABLES = [
	'meta',
	'record_documents',
	'records',
	'replica_witness',
] as const;

export const AUTHORITY_V1_INDEXES = [
	'records_address',
	'records_sequence',
] as const;

export const AUTHORITY_V1_SCHEMA_STATEMENTS = [
	`CREATE TABLE meta (
		singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version     INTEGER NOT NULL,
		authority_lifetime TEXT NOT NULL,
		next_sequence      INTEGER NOT NULL
			CHECK (next_sequence BETWEEN 1 AND 9007199254740992)
	) STRICT`,
	`CREATE TABLE records (
		record_id            INTEGER PRIMARY KEY,
		namespace            TEXT NOT NULL,
		collection           TEXT NOT NULL,
		record_key           TEXT NOT NULL,
		state                TEXT NOT NULL,
		payload              TEXT,
		sequence             INTEGER NOT NULL
			CHECK (sequence BETWEEN 1 AND 9007199254740991),
		accepted_blob_sha256 TEXT,
		CHECK ((state = 'live' AND payload IS NOT NULL AND json_valid(payload))
			OR (state IN ('tombstone', 'unset') AND payload IS NULL)),
		CHECK (accepted_blob_sha256 IS NULL OR
			(length(accepted_blob_sha256) = 64 AND
			accepted_blob_sha256 NOT GLOB '*[^a-f0-9]*'))
	) STRICT`,
	`CREATE UNIQUE INDEX records_address
		ON records(namespace, collection, record_key)`,
	`CREATE UNIQUE INDEX records_sequence ON records(sequence)`,
	`CREATE TABLE record_documents (
		chain_id   INTEGER PRIMARY KEY,
		record_id  INTEGER NOT NULL,
		seq        INTEGER NOT NULL CHECK (seq >= 1),
		kind       TEXT NOT NULL CHECK (kind IN ('baseline', 'update')),
		bytes      BLOB NOT NULL CHECK (length(bytes) > 0),
		CHECK (kind = 'update' OR seq = 1),
		UNIQUE (record_id, seq)
	) STRICT`,
	`CREATE TABLE replica_witness (
		replica_id        TEXT PRIMARY KEY
			CHECK (length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'),
		submission_number INTEGER NOT NULL
			CHECK (submission_number BETWEEN 1 AND 9007199254740991),
		request_hash      TEXT NOT NULL
			CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
		parked            TEXT NOT NULL CHECK (json_valid(parked))
	) STRICT`,
] as const;

export function createAuthorityV1Schema(
	database: SqliteDatabase,
	authorityLifetime: string,
): void {
	for (const statement of AUTHORITY_V1_SCHEMA_STATEMENTS) {
		database.run(statement);
	}
	database.run(
		`INSERT INTO meta (
			singleton, format_version, authority_lifetime, next_sequence
		) VALUES (1, ?, ?, 1)`,
		[AUTHORITY_V1_FORMAT_VERSION, authorityLifetime],
	);
}

export function openAuthorityV1Schema(
	database: SqliteDatabase,
	initialize: { authorityLifetime: string } | undefined,
): void {
	// Cloudflare documents `__cf_kv`; the repository's pinned workerd exposes
	// `_cf_KV`. Both are exact platform-owned identities, not a reserved prefix.
	const objects = database.all<SqliteRow & { name: string; type: string }>(
		`SELECT type, name FROM sqlite_schema
		WHERE type IN ('table', 'index')
			AND name NOT LIKE 'sqlite_%'
			AND NOT (
				type = 'table' AND name IN ('__cf_kv', '_cf_KV')
			)
		ORDER BY type, name`,
	);
	if (objects.length === 0) {
		if (initialize === undefined) {
			throw new Error('scalar V1 authority store does not exist');
		}
		database.transaction(() =>
			createAuthorityV1Schema(database, initialize.authorityLifetime),
		);
		return;
	}

	const actual = objects.map(({ type, name }) => `${type}:${name}`);
	const expected = [
		...AUTHORITY_V1_INDEXES.map((name) => `index:${name}`),
		...AUTHORITY_V1_TABLES.map((name) => `table:${name}`),
	].sort();
	if (
		actual.length !== expected.length ||
		actual.some((entry, index) => entry !== expected[index])
	) {
		throw new StorageUpgradeRequiredError(
			'scalar V1 authority',
			`schema does not match format ${AUTHORITY_V1_FORMAT_VERSION}`,
		);
	}

	const meta = database.all<SqliteRow & { format_version: number }>(
		'SELECT format_version FROM meta WHERE singleton = 1',
	)[0];
	if (meta?.format_version !== AUTHORITY_V1_FORMAT_VERSION) {
		throw new StorageUpgradeRequiredError(
			'scalar V1 authority',
			meta === undefined
				? 'metadata singleton is missing'
				: `format ${meta.format_version} is not supported`,
		);
	}
}
