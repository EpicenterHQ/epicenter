import { createBrowserSqliteAdapter } from '@epicenter/sqlite/browser';
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { Ok, tryAsync } from 'wellcrafted/result';
import { createBrowserQuery } from './browser-query.js';
import { type AppSqliteDatabase, DeviceError } from './index.js';

/**
 * One connection as the owner contract states it.
 *
 * `createBrowserSqliteAdapter` already drives OO1's `exec` and `transaction`,
 * so what is left here is the two things it does not carry: a change count,
 * which OO1 answers on the connection rather than the statement, and the
 * `Result` wrapper the application surface is stated in.
 */
export function sqliteOver(
	database: Database,
	module: Sqlite3Static,
): AppSqliteDatabase {
	const query = createBrowserQuery(module, database);
	const sqlite = createBrowserSqliteAdapter(database);
	const attempt = <T>(run: () => T) => {
		try {
			return Ok(run());
		} catch (cause) {
			return DeviceError.StorageFailed({ cause });
		}
	};
	return {
		query: (sql, options) =>
			tryAsync({
				try: () => query(sql, options),
				catch: (cause) => DeviceError.StorageFailed({ cause }),
			}),
		run: async (sql, parameters) =>
			attempt(() => {
				sqlite.run(sql, parameters);
				return { changes: database.changes() };
			}),
		all: async (sql, parameters) => attempt(() => sqlite.all(sql, parameters)),
		batch: async (statements) =>
			attempt(() =>
				sqlite.transaction(() => ({
					changes: statements.map((statement) => {
						sqlite.run(statement.sql, statement.parameters);
						return database.changes();
					}),
				})),
			),
	};
}
