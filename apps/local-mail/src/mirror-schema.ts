import { fingerprintDeclaration } from './fingerprint.ts';
import { STORED_PROJECTIONS } from './message-fields.ts';

/**
 * What the mirror stores, the SQL that creates it, and the fingerprint that
 * identifies that shape.
 *
 * `MIRROR_DECLARATION` is the one rebuild-relevant description: the column set
 * per table, each column's SQL type, the `json_extract` projections SQLite
 * computes itself, and a token for each column filled by imperative TypeScript.
 * `openMailDb` runs `CREATE_TABLES_SQL`, which is generated from that same
 * value, so a shape change cannot reach the file without moving the
 * fingerprint. That is what let the hand-stamped `SCHEMA_VERSION` go: the old
 * constant was a promise a reviewer had to remember to keep.
 *
 * Indexes are deliberately outside the declaration. An index holds no mirror
 * facts and is re-applied idempotently on every open, so adding one to fix a
 * slow query must never cost a full mailbox re-download. Mirror paths, the
 * account email, sync cursors, credentials, and Gmail's network behaviour are
 * outside it for the same reason: none of them change what a row holds.
 */

type MirrorColumn = {
	name: string;
	/** SQL type plus any inline constraints, verbatim as the DDL emits them. */
	type: string;
	/** A projection over `raw` that SQLite computes; no ingest code involved. */
	generated?: { expression: string; storage: 'VIRTUAL' | 'STORED' };
	/**
	 * This column is written by imperative TypeScript at ingest, so the fields
	 * above cannot see a change in what that code returns. The token carries
	 * that change; it is owned by `STORED_PROJECTIONS` in `message-fields.ts`,
	 * next to the projections themselves.
	 */
	derivation?: number;
};

const MESSAGE_COLUMNS: readonly MirrorColumn[] = [
	{ name: 'id', type: 'TEXT PRIMARY KEY' },
	{ name: 'raw', type: 'TEXT NOT NULL' },
	{
		name: 'thread_id',
		type: 'TEXT',
		generated: {
			expression: `json_extract(raw, '$.threadId')`,
			storage: 'VIRTUAL',
		},
	},
	{
		name: 'snippet',
		type: 'TEXT',
		generated: {
			expression: `json_extract(raw, '$.snippet')`,
			storage: 'STORED',
		},
	},
	{
		name: 'label_ids',
		type: 'TEXT',
		generated: {
			expression: `json_extract(raw, '$.labelIds')`,
			storage: 'VIRTUAL',
		},
	},
	{
		name: 'internal_date',
		type: 'INTEGER',
		generated: {
			expression: `CAST(json_extract(raw, '$.internalDate') AS INTEGER)`,
			storage: 'STORED',
		},
	},
	{ name: 'subject', type: 'TEXT', derivation: STORED_PROJECTIONS.subject },
	{ name: 'sender', type: 'TEXT', derivation: STORED_PROJECTIONS.sender },
	{ name: 'body_text', type: 'TEXT', derivation: STORED_PROJECTIONS.bodyText },
	{ name: 'synced_at', type: 'TEXT NOT NULL' },
];

const LABEL_COLUMNS: readonly MirrorColumn[] = [
	{ name: 'id', type: 'TEXT PRIMARY KEY' },
	{ name: 'raw', type: 'TEXT NOT NULL' },
	{
		name: 'name',
		type: 'TEXT',
		generated: {
			expression: `json_extract(raw, '$.name')`,
			storage: 'VIRTUAL',
		},
	},
	{
		name: 'type',
		type: 'TEXT',
		generated: {
			expression: `json_extract(raw, '$.type')`,
			storage: 'VIRTUAL',
		},
	},
	{ name: 'synced_at', type: 'TEXT NOT NULL' },
];

/**
 * The rebuild-relevant declaration. Column order within a table is preserved
 * (it is the physical row shape), but table key order is not: the canonical
 * serializer sorts object keys, so reordering or reformatting this literal
 * cannot force a re-pull.
 */
export const MIRROR_DECLARATION = {
	tables: {
		messages: MESSAGE_COLUMNS,
		labels: LABEL_COLUMNS,
	},
};

export const MIRROR_FINGERPRINT = fingerprintDeclaration(
	'epicenter.local-mail.mirror/v1',
	MIRROR_DECLARATION,
);

function columnDdl({ name, type, generated }: MirrorColumn): string {
	if (!generated) return `${name} ${type}`;
	return `${name} ${type} GENERATED ALWAYS AS (${generated.expression}) ${generated.storage}`;
}

/**
 * The mirror's tables, generated from the declaration so the two cannot drift.
 * `IF NOT EXISTS` because a matching fingerprint means the tables are already
 * there; a mismatching one deleted the file before this runs.
 */
export const CREATE_TABLES_SQL = Object.entries(MIRROR_DECLARATION.tables)
	.map(
		([table, columns]) =>
			`CREATE TABLE IF NOT EXISTS ${table} (\n${columns
				.map((column) => `\t${columnDdl(column)}`)
				.join(',\n')}\n);`,
	)
	.join('\n\n');

/**
 * Query optimizations, applied unconditionally on every open and intentionally
 * absent from `MIRROR_DECLARATION`. Adding one here is the whole migration: no
 * fingerprint change, no data loss, no Gmail re-download.
 */
export const CREATE_INDEXES_SQL = [
	`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, internal_date);`,
	`CREATE INDEX IF NOT EXISTS idx_messages_internal_date ON messages(internal_date);`,
].join('\n');
