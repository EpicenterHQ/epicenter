/**
 * Reading and writing one application SQLite database, as this application
 * wants to hold it.
 *
 * `AppSqliteDatabase` answers with a `Result` on every call, which is right at
 * the seam: a storage owner can refuse and the application has to be told. It
 * is wrong INSIDE a store, where every statement is one step of an operation
 * that is already fallible as a whole. Both stores wrote the same three
 * unwrapping closures to get from one to the other, and neither wanted the
 * difference.
 *
 * So a refusal throws here and the store's caller catches it once. That is the
 * same bargain `syncMailbox` already makes with `SQLITE_BUSY`: a lock lost to a
 * concurrent writer is an outcome the pass reports, not a value every statement
 * has to thread.
 */

import type { AppSqliteDatabase } from '@epicenter/device';

/** What a statement may bind. Neither store stores a BLOB. */
export type Binding = string | number | null;

export type Statement = {
	sql: string;
	parameters?: readonly Binding[];
};

export type SqliteHandle = {
	all<TRow extends Record<string, unknown>>(
		sql: string,
		parameters?: readonly Binding[],
	): Promise<TRow[]>;
	run(sql: string, parameters?: readonly Binding[]): Promise<number>;
	/** All or nothing. An empty list is a no-op rather than an owner round trip. */
	batch(statements: readonly Statement[]): Promise<number[]>;
};

export function sqliteHandle(database: AppSqliteDatabase): SqliteHandle {
	return {
		async all<TRow extends Record<string, unknown>>(
			sql: string,
			parameters: readonly Binding[] = [],
		) {
			const rows = await database.all(sql, parameters);
			if (rows.error !== null) throw rows.error;
			return rows.data as unknown as TRow[];
		},
		async run(sql, parameters = []) {
			const result = await database.run(sql, parameters);
			if (result.error !== null) throw result.error;
			return result.data.changes;
		},
		async batch(statements) {
			if (statements.length === 0) return [];
			const result = await database.batch(statements);
			if (result.error !== null) throw result.error;
			return result.data.changes;
		},
	};
}
