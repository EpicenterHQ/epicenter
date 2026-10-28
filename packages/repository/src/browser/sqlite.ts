/**
 * The SQLite driver for a browser worker: `@sqlite.org/sqlite-wasm` over the
 * `opfs-sahpool` VFS, which needs no cross-origin isolation. Each repository
 * gets its own pool (its own OPFS directory), because a pool is held by one
 * worker at a time and different repositories may be owned by different tabs.
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { SqlDriver, SqlValue } from '../sql.js';

export const BrowserStorageError = defineErrors({
	/** OPFS sync access handles are missing, or SQLite failed to load. */
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
 * handles belong to one worker at a time, and the worker of a tab that just
 * gave the repository up (or one that is frozen) may not have released them
 * yet, so this keeps trying until it lets go, calling `onWaiting` once, or
 * until `cancelled` says to stop. A failed attempt keeps the pool's files
 * (`preserveOnInitFailure`); without it the VFS deletes the whole pool when
 * it cannot acquire it. Closing the driver releases the handles at once.
 */
export async function openOpfsDatabase(
	name: string,
	{
		onWaiting = () => {},
		cancelled = () => false,
		maxDelayMs = 500,
	}: { onWaiting?: (reason: string) => void; cancelled?: () => boolean; maxDelayMs?: number } = {},
): Promise<Result<SqlDriver, BrowserStorageError>> {
	// Without sync access handles no wait helps.
	const handles =
		typeof FileSystemFileHandle === 'undefined'
			? undefined
			: (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown }).createSyncAccessHandle;
	if (typeof navigator.storage?.getDirectory !== 'function' || typeof handles !== 'function')
		return BrowserStorageError.Unavailable({ cause: new Error('this browser has no OPFS sync access handles') });
	const sqlite3 = await tryAsync({
		try: () => sqlite3InitModule(),
		catch: (cause) => BrowserStorageError.Unavailable({ cause }),
	});
	if (sqlite3.error !== null) return sqlite3;
	let delay = 25;
	for (let attempt = 0; ; attempt++) {
		if (cancelled()) return BrowserStorageError.Unavailable({ cause: new Error('the open was cancelled') });
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
		if (pool.error === null) {
			const util = pool.data;
			const driver = wasmDriver(new util.OpfsSAHPoolDb('/repository.sqlite3'));
			return Ok({
				...driver,
				close() {
					driver.close();
					// Release the access handles now rather than when the worker is collected.
					util.pauseVfs();
				},
			});
		}
		if (attempt === 0) onWaiting(String((pool.error.cause as Error | undefined)?.message ?? pool.error.cause));
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, maxDelayMs);
	}
}
