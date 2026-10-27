/** The `bun:sqlite` driver. */
import { Database } from 'bun:sqlite';
import type { SqlDriver, SqlValue } from '../sql.js';

/** Open a database file, or an in-memory database by default. */
export function openBunSqlite(filename = ':memory:'): SqlDriver {
	const db = new Database(filename, { create: true, strict: true });
	if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
	return {
		exec(sql) {
			db.exec(sql);
		},
		all<TRow>(sql: string, params: SqlValue[] = []) {
			return db.query(sql).all(...params) as TRow[];
		},
		run(sql, params = []) {
			db.query(sql).run(...params);
		},
		transaction(fn) {
			return db.transaction(fn)();
		},
		close() {
			db.close();
		},
	};
}
