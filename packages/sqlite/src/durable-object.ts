import type { SqliteDatabase, SqliteRow, SqliteValue } from './index.js';

export type DurableObjectSqliteStorage = {
	sql: {
		exec<TRow extends SqliteRow>(
			query: string,
			...bindings: SqliteValue[]
		): { toArray(): TRow[] };
	};
	transactionSync<TResult>(run: () => TResult): TResult;
};

/** Adapt a SQLite-backed Durable Object's synchronous storage API. */
export function createDurableObjectSqliteAdapter(
	storage: DurableObjectSqliteStorage,
): SqliteDatabase {
	return {
		run(sql, parameters = []): void {
			storage.sql.exec(sql, ...parameters);
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			return storage.sql.exec<TRow>(sql, ...parameters).toArray();
		},
		readTransaction<TResult>(run: () => TResult): TResult {
			return storage.transactionSync(run);
		},
		transaction<TResult>(run: () => TResult): TResult {
			return storage.transactionSync(run);
		},
	};
}
