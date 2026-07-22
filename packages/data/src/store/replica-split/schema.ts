import type { SqliteDatabase } from '@epicenter/sqlite';

export const SPLIT_REPLICA_STORE_FORMAT_VERSION = 2;

export const SPLIT_REPLICA_STORE_TABLES = [
	'blob_state',
	'confirmed_records',
	'document_chains',
	'document_inflight',
	'local_intents',
	'meta',
	'record_documents',
] as const;

export const SPLIT_REPLICA_STORE_INDEXES = [
	'record_documents_address',
] as const;

const SCHEMA = [
	`CREATE TABLE meta (
		singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version         INTEGER NOT NULL,
		replica_id             TEXT NOT NULL
			CHECK (length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'),
		attached_deployment    TEXT,
		attached_principal     TEXT,
		authority_lifetime     TEXT,
		erased_authority_lifetime TEXT,
		after_sequence         INTEGER NOT NULL DEFAULT 0
			CHECK (after_sequence BETWEEN 0 AND 9007199254740991),
		sealed_submission      INTEGER,
		sealed_request         TEXT,
		sealed_request_hash    TEXT,
		next_submission        INTEGER NOT NULL DEFAULT 1
			CHECK (next_submission BETWEEN 1 AND 9007199254740992),
		CHECK ((attached_deployment IS NULL) = (attached_principal IS NULL)),
		CHECK (erased_authority_lifetime IS NULL OR authority_lifetime IS NULL
			OR erased_authority_lifetime != authority_lifetime),
		CHECK ((sealed_submission IS NULL) = (sealed_request IS NULL)),
		CHECK ((sealed_submission IS NULL) = (sealed_request_hash IS NULL)),
		CHECK (sealed_submission IS NULL OR
			sealed_submission BETWEEN 1 AND 9007199254740991),
		CHECK (sealed_request_hash IS NULL OR
			(length(sealed_request_hash) = 64 AND sealed_request_hash NOT GLOB '*[^a-f0-9]*'))
	) STRICT`,
	`CREATE TABLE confirmed_records (
		namespace   TEXT NOT NULL,
		collection  TEXT NOT NULL,
		record_key  TEXT NOT NULL,
		state       TEXT NOT NULL CHECK (state IN ('live', 'tombstone', 'unset')),
		payload     TEXT,
		sequence    INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
		PRIMARY KEY (namespace, collection, record_key),
		CHECK ((state = 'live') = (payload IS NOT NULL)),
		CHECK (payload IS NULL OR json_valid(payload))
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE local_intents (
		namespace       TEXT NOT NULL,
		collection      TEXT NOT NULL,
		record_key      TEXT NOT NULL,
		sealed_op       TEXT,
		sealed_args     TEXT,
		pending_op      TEXT,
		pending_args    TEXT,
		parked_op       TEXT,
		parked_args     TEXT,
		parked_code     TEXT,
		parked_measured INTEGER,
		parked_limit    INTEGER,
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
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE record_documents (
		doc_id      INTEGER PRIMARY KEY,
		namespace   TEXT NOT NULL,
		collection  TEXT NOT NULL,
		record_key  TEXT NOT NULL,
		revision    INTEGER NOT NULL DEFAULT 0
			CHECK (revision BETWEEN 0 AND 9007199254740991),
		dirty       INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
	) STRICT`,
	`CREATE UNIQUE INDEX record_documents_address
		ON record_documents(namespace, collection, record_key)`,
	`CREATE TABLE document_chains (
		entry_id INTEGER PRIMARY KEY,
		doc_id   INTEGER NOT NULL,
		seq      INTEGER NOT NULL CHECK (seq >= 1),
		kind     TEXT NOT NULL CHECK (kind IN ('baseline', 'update')),
		bytes    BLOB NOT NULL CHECK (length(bytes) > 0),
		CHECK (kind = 'update' OR seq = 1),
		UNIQUE (doc_id, seq)
	) STRICT`,
	`CREATE TABLE document_inflight (
		doc_id             INTEGER PRIMARY KEY,
		payload            BLOB,
		digest             TEXT NOT NULL,
		captured_revision  INTEGER NOT NULL
			CHECK (captured_revision BETWEEN 0 AND 9007199254740991),
		parked_code        TEXT,
		measured_bytes     INTEGER,
		measured_structs   INTEGER,
		limit_bytes        INTEGER,
		limit_structs      INTEGER,
		CHECK (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*'),
		CHECK ((parked_code IS NULL AND payload IS NOT NULL
				AND length(payload) > 0 AND measured_bytes IS NULL
				AND measured_structs IS NULL AND limit_bytes IS NULL
				AND limit_structs IS NULL)
			OR (parked_code = 'document-bound' AND payload IS NULL
				AND measured_bytes IS NOT NULL AND measured_bytes >= 0
				AND measured_structs IS NOT NULL AND measured_structs >= 0
				AND limit_bytes IS NOT NULL AND limit_bytes >= 0
				AND limit_structs IS NOT NULL AND limit_structs >= 0))
	) STRICT`,
	`CREATE TABLE blob_state (
		namespace    TEXT NOT NULL,
		collection   TEXT NOT NULL,
		record_key   TEXT NOT NULL,
		sha256       TEXT NOT NULL
			CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
		pending      INTEGER NOT NULL CHECK (pending IN (0, 1)),
		parked_code  TEXT CHECK (parked_code IS NULL OR
			(pending = 1 AND parked_code IN ('blob-conflict', 'record-not-live'))),
		PRIMARY KEY (namespace, collection, record_key)
	) WITHOUT ROWID, STRICT`,
] as const;

export function createSplitReplicaStoreSchema(
	database: SqliteDatabase,
	fixture: { replicaId: string; authorityLifetime?: string },
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO meta (
			singleton, format_version, replica_id, authority_lifetime
		) VALUES (1, ?, ?, ?)`,
		[
			SPLIT_REPLICA_STORE_FORMAT_VERSION,
			fixture.replicaId,
			fixture.authorityLifetime ?? null,
		],
	);
}
