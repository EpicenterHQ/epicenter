import type { SqliteDatabase } from '@epicenter/sqlite';

/**
 * Format 2 is the structured-address, lifetime-bound replica store. Format 1
 * stored flat qualified keys and a cursor pair; it is refused, never migrated,
 * because the scalar clean break ships with no legacy user data.
 */
export const REPLICA_FORMAT_VERSION = 2;

export const REPLICA_TABLES = [
	'metadata',
	'state',
	'outbox',
	'document_updates',
] as const;

const NAMESPACE_CHARSET = "NOT GLOB '*[^a-z0-9.-]*'";
const MEMBER_CHARSET = "NOT GLOB '*[^a-z0-9.-]*'";
const ROW_ID_EXACT =
	"length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'";

const SCHEMA = [
	`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL CHECK (
			length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'
		),
		attached_deployment TEXT,
		attached_principal TEXT,
		authority_lifetime TEXT CHECK (
			authority_lifetime IS NULL OR (
				length(authority_lifetime) = 24 AND
				authority_lifetime NOT GLOB '*[^a-z0-9]*'
			)
		),
		last_applied_authority_sequence INTEGER NOT NULL
			CHECK (last_applied_authority_sequence >= 0),
		last_batch_sequence INTEGER NOT NULL CHECK (last_batch_sequence >= 0),
		CHECK (
			(attached_deployment IS NULL AND attached_principal IS NULL) OR
			(attached_deployment IS NOT NULL AND attached_principal IS NOT NULL)
		)
	) STRICT`,
	`CREATE TABLE state (
		address_kind TEXT NOT NULL CHECK (address_kind IN ('row', 'value')),
		namespace_key TEXT NOT NULL CHECK (
			namespace_key <> '' AND namespace_key ${NAMESPACE_CHARSET}
		),
		member_key TEXT NOT NULL CHECK (
			member_key <> '' AND member_key ${MEMBER_CHARSET}
		),
		row_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('live', 'deleted', 'unset')),
		json_payload TEXT,
		changed_sequence INTEGER NOT NULL CHECK (changed_sequence >= 0),
		PRIMARY KEY (address_kind, namespace_key, member_key, row_id),
		CHECK (
			(address_kind = 'row' AND ${ROW_ID_EXACT} AND
				status IN ('live', 'deleted')) OR
			(address_kind = 'value' AND row_id = '' AND status IN ('live', 'unset'))
		),
		CHECK (
			(status = 'live' AND json_payload IS NOT NULL AND json_valid(json_payload)) OR
			(status IN ('deleted', 'unset') AND json_payload IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	'CREATE INDEX state_changed_sequence ON state(changed_sequence)',
	`CREATE TABLE outbox (
		local_sequence INTEGER PRIMARY KEY,
		address_kind TEXT NOT NULL CHECK (address_kind IN ('row', 'value')),
		namespace_key TEXT NOT NULL CHECK (
			namespace_key <> '' AND namespace_key ${NAMESPACE_CHARSET}
		),
		member_key TEXT NOT NULL CHECK (
			member_key <> '' AND member_key ${MEMBER_CHARSET}
		),
		row_id TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('live', 'deleted', 'unset')),
		json_payload TEXT,
		batch_sequence INTEGER CHECK (batch_sequence IS NULL OR batch_sequence >= 1),
		parked_reason TEXT CHECK (parked_reason IS NULL OR parked_reason = 'record-bound'),
		CHECK (parked_reason IS NULL OR batch_sequence IS NULL),
		CHECK (
			(address_kind = 'row' AND ${ROW_ID_EXACT} AND
				status IN ('live', 'deleted')) OR
			(address_kind = 'value' AND row_id = '' AND status IN ('live', 'unset'))
		),
		CHECK (
			(status = 'live' AND json_payload IS NOT NULL AND json_valid(json_payload)) OR
			(status IN ('deleted', 'unset') AND json_payload IS NULL)
		)
	) STRICT`,
	`CREATE TABLE document_updates (
		namespace_key TEXT NOT NULL CHECK (
			namespace_key <> '' AND namespace_key ${NAMESPACE_CHARSET}
		),
		table_key TEXT NOT NULL CHECK (
			table_key <> '' AND table_key ${MEMBER_CHARSET}
		),
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (namespace_key, table_key, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
] as const;

export function createReplicaSchema(
	database: SqliteDatabase,
	replicaId: string,
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO metadata (
			singleton, format_version, replica_id, attached_deployment,
			attached_principal, authority_lifetime,
			last_applied_authority_sequence, last_batch_sequence
		) VALUES (1, ?, ?, NULL, NULL, NULL, 0, 0)`,
		[REPLICA_FORMAT_VERSION, replicaId],
	);
}
