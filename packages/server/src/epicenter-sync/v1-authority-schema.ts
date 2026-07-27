import {
	type SqliteDatabase,
	type SqliteRow,
	StorageUpgradeRequiredError,
} from '@epicenter/sqlite';

export const AUTHORITY_V1_FORMAT_VERSION = 1;

const AUTHORITY_V1_TABLES = [
	'_authority_v1_metadata',
	'_authority_v1_replicas',
	'_authority_v1_row_facts',
	'_authority_v1_value_facts',
	'document_updates',
	'document_versions',
] as const;

const SCHEMA = [
	`CREATE TABLE main._authority_v1_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		authority_lifetime TEXT NOT NULL,
		next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1)
	) STRICT`,
	`CREATE TABLE main._authority_v1_replicas (
		replica_id TEXT PRIMARY KEY CHECK (
			length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'
		),
		last_submission_number INTEGER NOT NULL CHECK (last_submission_number >= 0),
		last_request_hash TEXT,
		touched_addresses TEXT,
		parked TEXT,
		CHECK (
			(last_submission_number = 0 AND
				last_request_hash IS NULL AND
				touched_addresses IS NULL AND
				parked IS NULL) OR
			(last_submission_number > 0 AND
				last_request_hash IS NOT NULL AND
				length(last_request_hash) = 64 AND
				last_request_hash NOT GLOB '*[^a-f0-9]*' AND
				touched_addresses IS NOT NULL AND
				CASE WHEN json_valid(touched_addresses)
					THEN json_type(touched_addresses) = 'array'
					ELSE 0
				END AND
				parked IS NOT NULL AND
				CASE WHEN json_valid(parked)
					THEN json_type(parked) = 'array'
					ELSE 0
				END)
		)
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE main._authority_v1_row_facts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		fields TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 1),
		PRIMARY KEY (namespace, table_name, row_id),
		CHECK (
			(presence = 'present' AND fields IS NOT NULL AND json_valid(fields)) OR
			(presence = 'absent' AND fields IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE UNIQUE INDEX main._authority_v1_row_facts_authority_sequence ON _authority_v1_row_facts(authority_sequence)',
	`CREATE TABLE main._authority_v1_value_facts (
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		content TEXT,
		authority_sequence INTEGER NOT NULL CHECK (authority_sequence >= 1),
		PRIMARY KEY (namespace, value_name),
		CHECK (
			(presence = 'present' AND content IS NOT NULL AND json_valid(content)) OR
			(presence = 'absent' AND content IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE UNIQUE INDEX main._authority_v1_value_facts_authority_sequence ON _authority_v1_value_facts(authority_sequence)',
	`CREATE TABLE document_updates (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (namespace, table_name, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
	// The per-address acceptance counter behind conditional pulls: it advances
	// with every accepted append, so an unchanged value proves an unchanged
	// document without hydrating or transferring it (ADR-0174).
	`CREATE TABLE document_versions (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		version INTEGER NOT NULL CHECK (version > 0),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

type MetadataRow = SqliteRow & { format_version: number };

/**
 * Initialize only an empty store so an older physical format is never hidden
 * beside a newly created V1 schema.
 */
export function initializeV1AuthoritySchema(
	database: SqliteDatabase,
	{ mintLifetime }: { mintLifetime: () => string },
): void {
	const present = database
		.all<SqliteRow & { name: string }>(
			`SELECT name FROM main.sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
		)
		.map((row) => row.name);
	if (present.length === 0) {
		database.transaction(() => {
			for (const statement of SCHEMA) database.run(statement);
			database.run(
				`INSERT INTO main._authority_v1_metadata (
					singleton, format_version, authority_lifetime, next_sequence
				) VALUES (1, ?, ?, 1)`,
				[AUTHORITY_V1_FORMAT_VERSION, mintLifetime()],
			);
		});
		return;
	}

	const expected = new Set<string>(AUTHORITY_V1_TABLES);
	if (
		present.length !== expected.size ||
		!present.every((name) => expected.has(name))
	) {
		throw new StorageUpgradeRequiredError(
			'Epicenter sync V1 authority',
			'authority schema is not the current format',
		);
	}
	const metadata = database.all<MetadataRow>(
		`SELECT format_version
		FROM main._authority_v1_metadata WHERE singleton = 1`,
	)[0];
	if (metadata?.format_version !== AUTHORITY_V1_FORMAT_VERSION) {
		throw new StorageUpgradeRequiredError(
			'Epicenter sync V1 authority',
			metadata === undefined
				? 'metadata singleton is missing'
				: `format ${metadata.format_version} is not supported`,
		);
	}
}
