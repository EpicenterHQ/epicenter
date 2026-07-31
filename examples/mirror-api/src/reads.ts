/**
 * The read surface both handles share.
 *
 * Nothing here is compiled against today's column set at open time. A reader
 * may be pointed at a mirror written by an older declaration, and inspecting a
 * stale mirror is a legitimate thing to do, so every statement is built at call
 * time and a missing table is an empty answer rather than an error.
 */

import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { sqlIdent } from './declaration.ts';

/** `_meta` keys this API owns. Everything else in `_meta` belongs to the app. */
export const DECLARATION_KEY = 'mirror_declaration';
export const CURSOR_KEYS = [
	'cursor',
	'last_full_pull_at',
	'last_synced_at',
] as const;

/**
 * Where the app's pull left off. The mirror stores this, rather than the app,
 * for exactly one reason: a rebuild has to invalidate it, and an invalidation
 * that lives somewhere else is an invalidation someone forgets. Choosing FULL
 * versus INCREMENTAL, talking to the authority, and backing off a rate limit
 * all stay in the app.
 *
 * `cursor` is opaque: a QuickBooks CDC timestamp and a Gmail `historyId` are
 * both just the token the next pass hands back.
 */
export type MirrorState = {
	cursor: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
};

export type MirrorReads = {
	/** Where the last pull left off, all nulls before the first one. */
	state(): MirrorState;
	/**
	 * Whether this table has been created. Both mirrors use table existence as
	 * the per-table "has this had its first full pull?" latch, so this is a
	 * load-bearing read and not a diagnostic.
	 */
	exists(table: string): boolean;
	/** Row count, or 0 when the table has never been created. */
	count(table: string): number;
	/** Arbitrary read-only SQL: the app's own read models and query verbs. */
	all<TRow extends SqliteRow>(
		sql: string,
		parameters?: readonly (string | number | null)[],
	): TRow[];
};

export function tableExists(database: SqliteDatabase, table: string): boolean {
	const rows = database.all<{ n: number }>(
		`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`,
		[table],
	);
	return (rows[0]?.n ?? 0) > 0;
}

export function readMeta(database: SqliteDatabase, key: string): string | null {
	if (!tableExists(database, '_meta')) return null;
	const rows = database.all<{ value: string | null }>(
		`SELECT value FROM _meta WHERE key = ?`,
		[key],
	);
	return rows[0]?.value ?? null;
}

export function createReads(database: SqliteDatabase): MirrorReads {
	return {
		state(): MirrorState {
			return {
				cursor: readMeta(database, 'cursor'),
				lastFullPullAt: readMeta(database, 'last_full_pull_at'),
				lastSyncedAt: readMeta(database, 'last_synced_at'),
			};
		},

		exists(table: string): boolean {
			return tableExists(database, sqlIdent(table));
		},

		count(table: string): number {
			const name = sqlIdent(table);
			if (!tableExists(database, name)) return 0;
			return (
				database.all<{ n: number }>(`SELECT count(*) AS n FROM ${name}`)[0]
					?.n ?? 0
			);
		},

		all<TRow extends SqliteRow>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		): TRow[] {
			return database.all<TRow>(sql, parameters);
		},
	};
}
