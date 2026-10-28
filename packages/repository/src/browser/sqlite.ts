/**
 * The SQLite driver for a browser worker: `@sqlite.org/sqlite-wasm` over the
 * `opfs-sahpool` VFS, which needs no cross-origin isolation. Each repository
 * gets its own pool (its own OPFS directory), because a pool is held by one
 * worker at a time and different repositories may be led from different tabs.
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { SqlDriver, SqlValue } from '../sql.js';

export const BrowserStorageError = defineErrors({
	/** OPFS is missing, or the previous leader never released the pool. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: 'This browser could not open the repository in its private storage',
		cause,
	}),
});
export type BrowserStorageError = InferErrors<typeof BrowserStorageError>;

/** A driver over one open `oo1` database. */
export function wasmDriver(db: Database): SqlDriver {
	let depth = 0;
	const bind = (params: SqlValue[]) => (params.length === 0 ? {} : { bind: params });
	return {
		exec(sql) {
			db.exec(sql);
		},
		all<TRow>(sql: string, params: SqlValue[] = []) {
			return db.exec({ sql, ...bind(params), rowMode: 'object', returnValue: 'resultRows' }) as TRow[];
		},
		run(sql, params = []) {
			db.exec({ sql, ...bind(params) });
		},
		transaction(fn) {
			// A nested call joins the outer transaction: its throw reaches the outer catch.
			if (depth > 0) return fn();
			depth++;
			db.exec('BEGIN');
			try {
				const result = fn();
				db.exec('COMMIT');
				return result;
			} catch (cause) {
				db.exec('ROLLBACK');
				throw cause;
			} finally {
				depth--;
			}
		},
		registerFunction(name, fn) {
			db.createFunction({ name, arity: 1, deterministic: true, xFunc: (_context, value) => fn(value as SqlValue) });
		},
		close() {
			db.close();
		},
	};
}

/**
 * Open the repository's database in its own pool. The pool's sync access
 * handles belong to one worker at a time, so right after a leader tab closes
 * they may not be released yet: this retries for a few seconds. A failed
 * attempt keeps the pool's files (`preserveOnInitFailure`); without it the
 * VFS deletes the whole pool when it cannot acquire it.
 */
export async function openOpfsDatabase(
	name: string,
	{ attempts = 100, delayMs = 50 } = {},
): Promise<Result<SqlDriver, BrowserStorageError>> {
	const sqlite3 = await tryAsync({
		try: () => sqlite3InitModule(),
		catch: (cause) => BrowserStorageError.Unavailable({ cause }),
	});
	if (sqlite3.error !== null) return sqlite3;
	let last: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const pool = await tryAsync({
			try: () =>
				sqlite3.data.installOpfsSAHPoolVfs({
					name: `epicenter-${name}`,
					directory: `.epicenter/${name}`,
					preserveOnInitFailure: true,
					// Retrying needs this too; the runtime takes it, the declarations omit it.
					...({ forceReinitIfPreviouslyFailed: true } as object),
				}),
			catch: (cause) => BrowserStorageError.Unavailable({ cause }),
		});
		if (pool.error === null) return Ok(wasmDriver(new pool.data.OpfsSAHPoolDb('/repository.sqlite3')));
		last = pool.error.cause;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	return BrowserStorageError.Unavailable({ cause: last });
}
