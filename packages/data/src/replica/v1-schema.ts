import type { SqliteDatabase } from '@epicenter/sqlite';

export const REPLICA_V1_FORMAT_VERSION = 7;

/**
 * The scalar V1 replica file (ADR-0163, ADR-0164, ADR-0178).
 *
 * ## Confirmed facts are stored beneath local work, never instead of it
 *
 * The layout this replaces stored one row per address that was both the
 * confirmed authority fact and the optimistic local overlay, distinguished by an
 * `authority_sequence` of zero. That conflates two things ADR-0163 requires to
 * be separable: "Every learned authority fact is stored even when its address
 * has pending work", and a pending intent "cannot prevent confirmed progress
 * from advancing". With one merged row there is nowhere to put a learned fact
 * for an address that currently has local work, so the old install path skipped
 * such facts entirely and the replica silently lost authority truth, including a
 * terminal tombstone.
 *
 * So facts and intents are separate relations. The fact relations hold authority
 * truth only, which is why their `authority_sequence` is `>= 1` here rather than
 * `>= 0`: a local write no longer has anywhere to spell itself as sequence zero.
 * Visible state is the fold of a confirmed fact with the intents at its address,
 * computed on read.
 *
 * ## Intents carry a lifecycle, not a queue position
 *
 * `state` is the whole submission lifecycle for one address:
 *
 * - `pending` is ordinary local work, eligible to seal and free to compact with
 *   a later write at the same address.
 * - `sealed` belongs to the one in-flight numbered submission. It is immutable,
 *   because an exact retry must resend the same semantic intents (ADR-0163), so
 *   a later local write at that address creates new `pending` work beside it
 *   rather than editing it.
 * - `parked` is work the authority refused for this address alone, whose
 *   diagnostic lives in `_replica_v1_parked`. It stays a visible overlay but is
 *   not eligible to seal, because ADR-0163 says a parked intent "does not retry
 *   automatically"; a later local write compacts with it and makes it pending
 *   again.
 *
 * `UNIQUE(address, state)` is what makes compaction a fact about storage rather
 * than a discipline the sealer has to remember: at most one intent per address
 * per state. Folding the intents at an address in `local_sequence` order then
 * gives visible state with no ordering rule written anywhere else.
 *
 * ## Row and value laws stay in separate relations
 *
 * Carried over from ADR-0178 and unchanged: a row has a runtime-minted id, an
 * object payload, a terminal tombstone, and owns documents and blobs; a value
 * has no row id, holds any JSON, and its absence is a reversible unset. Two
 * relations let each law be a column constraint instead of a CHECK re-asserting
 * which combinations are legal, and only the row relations have a `row_id`.
 *
 * `presence` replaces the old `verb` column in the intent relations because
 * ADR-0163 lowers typed create, update, and delete into desired state: row
 * create and update are both a row-present field patch, and there is no wire
 * verb left to store.
 */
const SCHEMA = [
	// `authority_lifetime` is NULL only before the first facts response binds it.
	// A replica that has learned anything must know which authority lifetime it
	// learned it from, or a delayed response from a superseded lifetime could
	// contaminate it after a Restore rebind, so the CHECK ties the two together.
	//
	// `sealed_submission_number` is NULL when nothing is in flight and otherwise
	// exactly one past the last completed number: the numbered stream is dense
	// and one replica has at most one sealed submission at a time.
	`CREATE TABLE main._replica_v1_metadata (
		singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL CHECK (
			length(replica_id) = 24 AND replica_id NOT GLOB '*[^a-z0-9]*'
		),
		attached_deployment TEXT,
		attached_principal TEXT,
		authority_lifetime TEXT,
		after_sequence INTEGER NOT NULL CHECK (after_sequence >= 0),
		last_submission_number INTEGER NOT NULL CHECK (last_submission_number >= 0),
		sealed_submission_number INTEGER,
		CHECK (
			(attached_deployment IS NULL AND attached_principal IS NULL) OR
			(attached_deployment IS NOT NULL AND attached_principal IS NOT NULL)
		),
		CHECK (after_sequence = 0 OR authority_lifetime IS NOT NULL),
		CHECK (
			sealed_submission_number IS NULL OR
			sealed_submission_number = last_submission_number + 1
		)
	) STRICT`,
	`CREATE TABLE main._replica_v1_row_facts (
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
	`CREATE TABLE main._replica_v1_value_facts (
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
	// Both intent relations share one strictly increasing `local_sequence` space
	// so the sealer has a stable order across address kinds, and so folding the
	// intents at one address needs no other ordering rule.
	`CREATE TABLE main._replica_v1_row_intents (
		local_sequence INTEGER PRIMARY KEY CHECK (local_sequence > 0),
		state TEXT NOT NULL CHECK (state IN ('pending', 'sealed', 'parked')),
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		set_fields TEXT,
		unset_keys TEXT,
		UNIQUE (namespace, table_name, row_id, state),
		CHECK (
			(presence = 'present' AND
				set_fields IS NOT NULL AND json_valid(set_fields) AND
				unset_keys IS NOT NULL AND json_valid(unset_keys)) OR
			(presence = 'absent' AND set_fields IS NULL AND unset_keys IS NULL)
		)
	) STRICT`,
	`CREATE TABLE main._replica_v1_value_intents (
		local_sequence INTEGER PRIMARY KEY CHECK (local_sequence > 0),
		state TEXT NOT NULL CHECK (state IN ('pending', 'sealed', 'parked')),
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		content TEXT,
		UNIQUE (namespace, value_name, state),
		CHECK (
			(presence = 'present' AND content IS NOT NULL AND json_valid(content)) OR
			(presence = 'absent' AND content IS NULL)
		)
	) STRICT`,
	// The materialized visible projection: the fold of confirmed facts with local
	// intents, kept current on every mutation.
	//
	// ADR-0163 permits exactly this and bounds it precisely: "A private
	// materialized visible table or pending-address shadow is permitted only as an
	// optimization of these invariants, never as the sole copy of authority
	// truth." It is derived state. The fact relations remain authority truth and
	// the intent relations remain local truth; nothing is read from here that
	// could not be recomputed by folding those two.
	//
	// It exists because two readers need visible state without folding: a table
	// scan, which would otherwise fold every candidate row, and the read-only
	// inspection host, which mounts SQL views and cannot call the kernel fold at
	// all. Without it, `SELECT * FROM notes` would show authority truth rather
	// than what the application sees, and a row the user just created would be
	// missing from its own table.
	`CREATE TABLE main._replica_v1_visible_rows (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		fields TEXT,
		PRIMARY KEY (namespace, table_name, row_id),
		CHECK (
			(presence = 'present' AND fields IS NOT NULL AND json_valid(fields)) OR
			(presence = 'absent' AND fields IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE main._replica_v1_visible_values (
		namespace TEXT NOT NULL,
		value_name TEXT NOT NULL,
		presence TEXT NOT NULL CHECK (presence IN ('present', 'absent')),
		content TEXT,
		PRIMARY KEY (namespace, value_name),
		CHECK (
			(presence = 'present' AND content IS NOT NULL AND json_valid(content)) OR
			(presence = 'absent' AND content IS NULL)
		)
	) WITHOUT ROWID, STRICT`,
	// The diagnostic beside a `parked` row intent. Only a row-present patch whose
	// fold over a different live base overflows the encoded-fact ceiling can be
	// parked (ADR-0163), so this relation is row-addressed and single-coded.
	`CREATE TABLE main._replica_v1_parked (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL CHECK (
			length(row_id) = 24 AND row_id NOT GLOB '*[^a-z0-9]*'
		),
		code TEXT NOT NULL CHECK (code = 'fact-too-large'),
		measured_bytes INTEGER NOT NULL CHECK (measured_bytes >= 0),
		limit_bytes INTEGER NOT NULL CHECK (limit_bytes >= 0),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
	// Documents and blobs are owned by a row address, so they key on the exact
	// row coordinates rather than on a second address vocabulary (ADR-0174).
	// Carried over unchanged: row documents are a separate synchronization plane
	// and the scalar cutover must not move them.
	`CREATE TABLE document_updates (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		update_sequence INTEGER NOT NULL CHECK (update_sequence > 0),
		update_bytes BLOB NOT NULL,
		PRIMARY KEY (namespace, table_name, row_id, update_sequence)
	) WITHOUT ROWID, STRICT`,
	`CREATE TABLE document_publication (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		revision INTEGER NOT NULL CHECK (revision > 0),
		accepted_revision INTEGER NOT NULL
			CHECK (accepted_revision >= 0 AND accepted_revision <= revision),
		sync_issue TEXT CHECK (sync_issue IN ('too-large')),
		PRIMARY KEY (namespace, table_name, row_id)
	) WITHOUT ROWID, STRICT`,
] as const;

/**
 * Every relation a current V1 replica file owns.
 *
 * The scalar relations sit behind the reserved `_replica_v1_` prefix so no Lens
 * table can name one: a table name must start with a letter (ADR-0178), so a
 * leading underscore is unrepresentable in an address. That is what makes it
 * safe for a trusted inspection host to install connection-local TEMP views
 * named after Lens tables without shadowing internal storage.
 *
 * The two `document_` relations are the exception, and deliberately so: the row
 * document subsystem is reworked separately, so its physical names stay put.
 * Until they move, the table-name grammar keeps a Lens from claiming them.
 */
export const REPLICA_V1_TABLES = [
	'_replica_v1_metadata',
	'_replica_v1_row_facts',
	'_replica_v1_value_facts',
	'_replica_v1_row_intents',
	'_replica_v1_value_intents',
	'_replica_v1_visible_rows',
	'_replica_v1_visible_values',
	'_replica_v1_parked',
	'document_updates',
	'document_publication',
] as const;

export function createReplicaV1Schema(
	database: SqliteDatabase,
	replicaId: string,
): void {
	for (const statement of SCHEMA) database.run(statement);
	database.run(
		`INSERT INTO main._replica_v1_metadata (
			singleton, format_version, replica_id, attached_deployment,
			attached_principal, authority_lifetime, after_sequence,
			last_submission_number, sealed_submission_number
		) VALUES (1, ?, ?, NULL, NULL, NULL, 0, 0, NULL)`,
		[REPLICA_V1_FORMAT_VERSION, replicaId],
	);
}
