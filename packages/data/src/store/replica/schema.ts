import type { SqliteDatabase } from '@epicenter/sqlite';

export const REPLICA_STORE_FORMAT_VERSION = 1;

export const REPLICA_STORE_TABLES = [
	'document_inflight',
	'meta',
	'record_documents',
	'records',
] as const;

export const REPLICA_STORE_INDEXES = [
	'records_address',
	'records_blob_pending',
	'records_doc_dirty',
	'records_pending',
	'records_sealed',
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
	`CREATE TABLE records (
		record_id           INTEGER PRIMARY KEY,
		namespace           TEXT NOT NULL,
		collection          TEXT NOT NULL,
		record_key          TEXT NOT NULL,

		confirmed_state     TEXT,
		confirmed_payload   TEXT,
		confirmed_sequence  INTEGER,

		sealed_op           TEXT,
		sealed_args         TEXT,

		pending_op          TEXT,
		pending_args        TEXT,

		parked_op           TEXT,
		parked_args         TEXT,
		parked_code         TEXT,
		parked_measured     INTEGER,
		parked_limit        INTEGER,

		doc_revision        INTEGER NOT NULL DEFAULT 0 CHECK (doc_revision >= 0),
		doc_dirty           INTEGER NOT NULL DEFAULT 0 CHECK (doc_dirty IN (0, 1)),
		blob_sha256         TEXT,
		blob_pending        INTEGER NOT NULL DEFAULT 0 CHECK (blob_pending IN (0, 1)),

		CHECK ((confirmed_state IS NULL AND confirmed_payload IS NULL
				AND confirmed_sequence IS NULL)
			OR (confirmed_state = 'live' AND confirmed_payload IS NOT NULL
				AND json_valid(confirmed_payload)
				AND confirmed_sequence IS NOT NULL
				AND confirmed_sequence BETWEEN 1 AND 9007199254740991)
			OR (confirmed_state IN ('tombstone', 'unset') AND confirmed_payload IS NULL
				AND confirmed_sequence IS NOT NULL
				AND confirmed_sequence BETWEEN 1 AND 9007199254740991)),
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
		CHECK (blob_sha256 IS NULL OR
			(length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^a-f0-9]*')),
		CHECK (blob_pending = 0 OR blob_sha256 IS NOT NULL),
		CHECK (confirmed_state IS NOT NULL OR pending_op IS NOT NULL
			OR sealed_op IS NOT NULL OR parked_op IS NOT NULL)
	) STRICT`,
	`CREATE UNIQUE INDEX records_address
		ON records(namespace, collection, record_key)`,
	`CREATE INDEX records_pending
		ON records(namespace, collection, record_key) WHERE pending_op IS NOT NULL`,
	`CREATE INDEX records_sealed
		ON records(namespace, collection, record_key) WHERE sealed_op IS NOT NULL`,
	`CREATE INDEX records_doc_dirty
		ON records(record_id) WHERE doc_dirty = 1`,
	`CREATE INDEX records_blob_pending
		ON records(record_id) WHERE blob_pending = 1`,
	`CREATE TABLE record_documents (
		chain_id   INTEGER PRIMARY KEY,
		record_id  INTEGER NOT NULL,
		seq        INTEGER NOT NULL,
		kind       TEXT NOT NULL CHECK (kind IN ('baseline', 'update')),
		bytes      BLOB NOT NULL,
		UNIQUE (record_id, seq)
	) STRICT`,
	`CREATE TABLE document_inflight (
		record_id          INTEGER PRIMARY KEY,
		payload            BLOB NOT NULL,
		digest             TEXT NOT NULL,
		captured_revision  INTEGER NOT NULL CHECK (captured_revision >= 0)
	) STRICT`,
] as const;

export function createReplicaStoreSchema(
	database: SqliteDatabase,
	fixture: { replicaId: string; authorityLifetime?: string },
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO meta (
			singleton, format_version, replica_id, authority_lifetime
		) VALUES (1, ?, ?, ?)`,
		[
			REPLICA_STORE_FORMAT_VERSION,
			fixture.replicaId,
			fixture.authorityLifetime ?? null,
		],
	);
}
