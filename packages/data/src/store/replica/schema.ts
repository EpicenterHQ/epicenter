import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

export const REPLICA_STORE_FORMAT_VERSION = 4;

export const REPLICA_STORE_TABLES = [
	'meta',
	'record_documents',
	'records',
] as const;

export const REPLICA_STORE_INDEXES = [
	'records_address',
	'records_blob_owed',
	'records_document_owed',
	'records_pending',
	'records_sealed',
] as const;

const TABLE_SHAPES = {
	meta: [
		'singleton:INTEGER:0:1:0',
		'format_version:INTEGER:1:0:0',
		'replica_id:TEXT:1:0:0',
		'attached_deployment:TEXT:0:0:0',
		'attached_principal:TEXT:0:0:0',
		'authority_lifetime:TEXT:0:0:0',
		'erased_authority_lifetime:TEXT:0:0:0',
		'after_sequence:INTEGER:1:0:0',
		'sealed_submission:INTEGER:0:0:0',
		'sealed_request:TEXT:0:0:0',
		'sealed_request_hash:TEXT:0:0:0',
		'next_submission:INTEGER:1:0:0',
	],
	records: [
		'record_id:INTEGER:0:1:0',
		'namespace:TEXT:1:0:0',
		'collection:TEXT:1:0:0',
		'record_key:TEXT:1:0:0',
		'confirmed_state:TEXT:0:0:0',
		'confirmed_payload:TEXT:0:0:0',
		'confirmed_sequence:INTEGER:0:0:0',
		'sealed_op:TEXT:0:0:0',
		'sealed_args:TEXT:0:0:0',
		'pending_op:TEXT:0:0:0',
		'pending_args:TEXT:0:0:0',
		'parked_op:TEXT:0:0:0',
		'parked_args:TEXT:0:0:0',
		'parked_code:TEXT:0:0:0',
		'parked_measured:INTEGER:0:0:0',
		'parked_limit:INTEGER:0:0:0',
		'document_revision:INTEGER:1:0:0',
		'document_accepted_revision:INTEGER:1:0:0',
		'document_refused_revision:INTEGER:0:0:0',
		'document_refused_bytes:INTEGER:0:0:0',
		'document_refused_structs:INTEGER:0:0:0',
		'blob_sha256:TEXT:0:0:0',
		'blob_accepted_sha256:TEXT:0:0:0',
		'blob_parked_code:TEXT:0:0:0',
	],
	record_documents: [
		'chain_id:INTEGER:0:1:0',
		'record_id:INTEGER:1:0:0',
		'seq:INTEGER:1:0:0',
		'kind:TEXT:1:0:0',
		'bytes:BLOB:1:0:0',
	],
} as const;

const INDEX_SHAPES = {
	records_address: {
		unique: 1,
		partial: 0,
		columns: ['namespace', 'collection', 'record_key'],
	},
	records_pending: {
		unique: 0,
		partial: 1,
		columns: ['namespace', 'collection', 'record_key'],
	},
	records_sealed: {
		unique: 0,
		partial: 1,
		columns: ['namespace', 'collection', 'record_key'],
	},
	records_document_owed: {
		unique: 0,
		partial: 1,
		columns: ['namespace', 'collection', 'record_key'],
	},
	records_blob_owed: {
		unique: 0,
		partial: 1,
		columns: ['namespace', 'collection', 'record_key'],
	},
} as const;

type TableInfoRow = SqliteRow & {
	name: string;
	type: string;
	notnull: number;
	pk: number;
	hidden: number;
};

type IndexListRow = SqliteRow & {
	name: string;
	unique: number;
	partial: number;
};

type IndexInfoRow = SqliteRow & {
	seqno: number;
	cid: number;
	name: string | null;
	key: number;
};

function sameStrings(actual: readonly string[], expected: readonly string[]) {
	return (
		actual.length === expected.length &&
		actual.every((entry, index) => entry === expected[index])
	);
}

/** Recognize the current physical shape without comparing SQLite DDL text. */
export function replicaStoreSchemaMatches(database: SqliteDatabase): boolean {
	try {
		for (const [table, expected] of Object.entries(TABLE_SHAPES)) {
			const actual = database
				.all<TableInfoRow>(`PRAGMA table_xinfo("${table}")`)
				.map(
					({ name, type, notnull, pk, hidden }) =>
						`${name}:${type.toUpperCase()}:${notnull}:${pk}:${hidden}`,
				);
			if (!sameStrings(actual, expected)) return false;
		}

		const indexes = database.all<IndexListRow>('PRAGMA index_list("records")');
		for (const [name, expected] of Object.entries(INDEX_SHAPES)) {
			const index = indexes.find((candidate) => candidate.name === name);
			if (
				index === undefined ||
				index.unique !== expected.unique ||
				index.partial !== expected.partial
			) {
				return false;
			}
			const columns = database
				.all<IndexInfoRow>(`PRAGMA index_xinfo("${name}")`)
				.filter((column) => column.key === 1 && column.cid >= 0)
				.sort((left, right) => left.seqno - right.seqno)
				.map((column) => column.name)
				.filter((column): column is string => column !== null);
			if (!sameStrings(columns, expected.columns)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

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

		document_revision           INTEGER NOT NULL DEFAULT 0
			CHECK (document_revision BETWEEN 0 AND 9007199254740991),
		document_accepted_revision  INTEGER NOT NULL DEFAULT 0
			CHECK (document_accepted_revision BETWEEN 0 AND 9007199254740991),
		document_refused_revision   INTEGER,
		document_refused_bytes      INTEGER,
		document_refused_structs    INTEGER,
		blob_sha256                 TEXT,
		blob_accepted_sha256        TEXT,
		blob_parked_code            TEXT,

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
		CHECK (document_accepted_revision <= document_revision),
		CHECK ((document_refused_revision IS NULL AND document_refused_bytes IS NULL
				AND document_refused_structs IS NULL)
			OR (document_refused_revision = document_revision
				AND document_revision > document_accepted_revision
				AND document_refused_bytes IS NOT NULL AND document_refused_bytes >= 0
				AND document_refused_structs IS NOT NULL
				AND document_refused_structs >= 0)),
		CHECK (blob_sha256 IS NULL OR
			(length(blob_sha256) = 64 AND blob_sha256 NOT GLOB '*[^a-f0-9]*')),
		CHECK (blob_accepted_sha256 IS NULL OR
			(blob_sha256 IS NOT NULL AND blob_accepted_sha256 = blob_sha256)),
		CHECK (blob_parked_code IS NULL OR
			(blob_parked_code IN ('blob-conflict', 'record-not-live')
				AND blob_sha256 IS NOT NULL AND blob_accepted_sha256 IS NULL)),
		CHECK (confirmed_state IS NOT NULL OR pending_op IS NOT NULL
			OR sealed_op IS NOT NULL OR parked_op IS NOT NULL)
	) STRICT`,
	`CREATE UNIQUE INDEX records_address
		ON records(namespace, collection, record_key)`,
	`CREATE INDEX records_pending
		ON records(namespace, collection, record_key) WHERE pending_op IS NOT NULL`,
	`CREATE INDEX records_sealed
		ON records(namespace, collection, record_key) WHERE sealed_op IS NOT NULL`,
		`CREATE INDEX records_document_owed
			ON records(namespace, collection, record_key)
			WHERE document_revision > document_accepted_revision
				AND document_refused_revision IS NULL`,
		`CREATE INDEX records_blob_owed
			ON records(namespace, collection, record_key)
			WHERE blob_sha256 IS NOT NULL AND
				(blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256)
				AND blob_parked_code IS NULL`,
	`CREATE TABLE record_documents (
		chain_id   INTEGER PRIMARY KEY,
		record_id  INTEGER NOT NULL,
		seq        INTEGER NOT NULL CHECK (seq >= 1),
		kind       TEXT NOT NULL CHECK (kind IN ('baseline', 'update')),
		bytes      BLOB NOT NULL CHECK (length(bytes) > 0),
		CHECK (kind = 'update' OR seq = 1),
		UNIQUE (record_id, seq)
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
