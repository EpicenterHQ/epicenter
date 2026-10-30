/**
 * SQLite in a browser worker: `@sqlite.org/sqlite-wasm` over the
 * `opfs-sahpool` VFS, which needs no cross-origin isolation. Each replica
 * gets its own pool in its own `sqlite/` directory, because a pool is held
 * by one worker at a time and different replicas may be owned by different
 * tabs.
 *
 * Opening waits only on real contention: another worker (an old owner tab's,
 * or a frozen one's) still holding the pool's sync access handles, which
 * Chromium and Firefox report as `NoModificationAllowedError` and WebKit as
 * `InvalidStateError`. Any other failure is final, and reported.
 *
 * The VFS turns a storage failure into SQLITE_IOERR and keeps the cause to
 * itself, logging it through sqlite's configured error logger. That logger is
 * this module's, so a failed write can tell a full disk (`QuotaExceededError`)
 * from any other failure.
 */
import sqlite3InitModule, {
	type Database,
	type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import { isQuotaExceeded } from '../../client/blobs.js';
import type { SqlDriver, SqlValue } from '../../sql.js';
import { sqliteDirectory } from './layout.js';

const log = createLogger('repository/browser-sqlite');

export const ReplicaStorageError = defineErrors({
	/** This browser has no OPFS sync access handles, or SQLite failed to load. */
	Unsupported: ({ cause }: { cause: unknown }) => ({
		message: `This browser cannot keep a replica in its private storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The replica's database could not be opened, for a reason other than another worker holding it. */
	Unavailable: ({ cause }: { cause: unknown }) => ({
		message: `The replica's database could not be opened: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The open was given up before it finished. */
	Cancelled: () => ({ message: 'The open was cancelled' }),
	/** Something SQLite reported, kept as a diagnostic. */
	Reported: ({ text }: { text: string }) => ({
		message: `SQLite: ${text}`,
		text,
	}),
});
export type ReplicaStorageError = InferErrors<typeof ReplicaStorageError>;

/** The names browsers give the error of a sync access handle another worker holds. */
const CONTENDED = new Set(['NoModificationAllowedError', 'InvalidStateError']);
const isContended = (cause: unknown) =>
	cause instanceof DOMException && CONTENDED.has(cause.name);

/** The last storage failure the VFS reported, since `clearReported`. */
let reported: unknown = null;

/** sqlite's loggers, as this module's: the VFS's causes are kept, and everything goes to the logger. */
const apiConfig = {
	error(...args: unknown[]) {
		const cause = args.find(
			(arg) => arg instanceof Error || arg instanceof DOMException,
		);
		if (cause !== undefined) reported = cause;
		log.warn(
			ReplicaStorageError.Reported({ text: args.map(String).join(' ') }).error,
		);
	},
	warn: (...args: unknown[]) => log.debug('SQLite warned', args.map(String)),
	log: (...args: unknown[]) => log.trace('SQLite logged', args.map(String)),
};

let sqlite: Promise<Sqlite3Static> | null = null;
/** sqlite's module, loaded once per worker with this module's loggers. */
function loadSqlite() {
	if (sqlite === null) {
		(globalThis as { sqlite3ApiConfig?: object }).sqlite3ApiConfig = apiConfig;
		sqlite = sqlite3InitModule();
	}
	return sqlite;
}

/** Whether the last storage failure since `clearReported` was a full disk. */
export const storageWasFull = () => isQuotaExceeded(reported);
export const clearReported = () => {
	reported = null;
};

/**
 * A driver over one open `oo1` database. A read is checked by SQLite
 * itself: the text is split into statements as SQLite parses it, exactly
 * one must be there, `sqlite3_stmt_readonly` must hold for it, and while it
 * compiles and runs an authorizer allows only reading tables and views and
 * calling functions. That refuses what `stmt_readonly` lets through: a
 * transaction or savepoint, ATTACH and DETACH, and every PRAGMA.
 */
export function wasmDriver(sqlite3: Sqlite3Static, db: Database): SqlDriver {
	const { capi, wasm } = sqlite3;
	let depth = 0;
	const bind = (params: SqlValue[]) =>
		params.length === 0 ? {} : { bind: params };
	/** Whether a read is compiling or running, so the authorizer refuses all but reading. */
	let reading = false;
	const READ_ACTIONS = new Set<number>([
		capi.SQLITE_SELECT,
		capi.SQLITE_READ,
		capi.SQLITE_FUNCTION,
		capi.SQLITE_RECURSIVE,
	]);
	capi.sqlite3_set_authorizer(
		db,
		(_context, action) =>
			!reading || READ_ACTIONS.has(action) ? capi.SQLITE_OK : capi.SQLITE_DENY,
		0,
	);

	/** Each statement `sql` holds, as SQLite splits it, compiled to be checked and finalized at once. */
	function statementsIn(sql: string): { sql: string; readonly: boolean }[] {
		const [text, length] = wasm.allocCString(sql, true);
		const stack = wasm.pstack.pointer;
		try {
			// Room for a pointer of either width, as `oo1`'s own `prepare` allocates.
			const statement = wasm.pstack.alloc(8);
			const tail = wasm.pstack.alloc(8);
			const end = text + length;
			const found: { sql: string; readonly: boolean }[] = [];
			for (let at = text; at < end; ) {
				wasm.pokePtr(statement, 0);
				if (
					capi.sqlite3_prepare_v2(db, at, end - at, statement, tail) !==
					capi.SQLITE_OK
				)
					throw new Error(capi.sqlite3_errmsg(db));
				const compiled = wasm.peekPtr(statement);
				at = wasm.peekPtr(tail);
				// Space and comments compile to no statement.
				if (compiled === 0) continue;
				found.push({
					sql: capi.sqlite3_sql(compiled),
					readonly: capi.sqlite3_stmt_readonly(compiled) !== 0,
				});
				capi.sqlite3_finalize(compiled);
			}
			return found;
		} finally {
			wasm.pstack.restore(stack);
			wasm.dealloc(text);
		}
	}

	return {
		exec(sql) {
			db.exec(sql);
		},
		all<TRow>(sql: string, params: SqlValue[] = []) {
			return db.exec({
				sql,
				...bind(params),
				rowMode: 'object',
				returnValue: 'resultRows',
			}) as TRow[];
		},
		run(sql, params = []) {
			db.exec({ sql, ...bind(params) });
		},
		read<TRow>(sql: string, params: SqlValue[] = []) {
			reading = true;
			try {
				const statements = statementsIn(sql);
				const [only] = statements;
				if (only === undefined || statements.length > 1)
					throw new Error('A read is one statement');
				if (!only.readonly)
					throw new Error('A read cannot change the database');
				return db.exec({
					sql: only.sql,
					...bind(params),
					rowMode: 'object',
					returnValue: 'resultRows',
				}) as TRow[];
			} finally {
				reading = false;
			}
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
				// An I/O error (storage full) may have rolled the transaction back already; then ROLLBACK would throw over the cause.
				if (capi.sqlite3_get_autocommit(db) === 0) db.exec('ROLLBACK');
				throw cause;
			} finally {
				depth--;
			}
		},
		registerFunction(name, fn) {
			db.createFunction({
				name,
				arity: 1,
				deterministic: true,
				xFunc: (_context, value) => fn(value as SqlValue),
			});
		},
		close() {
			db.close();
		},
	};
}

/**
 * Open a replica's database. The pool's sync access handles belong to one
 * worker at a time, and the worker of a tab that just gave the replica up
 * (or one that is frozen) may not have released them yet, so on contention
 * this keeps trying until it lets go, calling `onWaiting` once, or until
 * `cancelled` says to stop. A failed attempt keeps the pool's files
 * (`preserveOnInitFailure`); without it the VFS deletes the whole pool when
 * it cannot acquire it. Closing the driver releases the handles at once.
 */
export async function openReplicaDatabase(
	replica: string,
	{
		onWaiting = () => {},
		cancelled = () => false,
		maxDelayMs = 500,
	}: {
		onWaiting?: (reason: string) => void;
		cancelled?: () => boolean;
		maxDelayMs?: number;
	} = {},
): Promise<Result<SqlDriver, ReplicaStorageError>> {
	const handles =
		typeof FileSystemFileHandle === 'undefined'
			? undefined
			: (FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown })
					.createSyncAccessHandle;
	if (
		typeof navigator.storage?.getDirectory !== 'function' ||
		typeof handles !== 'function'
	)
		return ReplicaStorageError.Unsupported({
			cause: new Error('this browser has no OPFS sync access handles'),
		});
	const sqlite3 = await tryAsync({
		try: loadSqlite,
		catch: (cause) => ReplicaStorageError.Unsupported({ cause }),
	});
	if (sqlite3.error !== null) return sqlite3;
	let delay = 25;
	for (let attempt = 0; ; attempt++) {
		if (cancelled()) return ReplicaStorageError.Cancelled();
		const pool = await tryAsync({
			try: () =>
				sqlite3.data.installOpfsSAHPoolVfs({
					name: `epicenter-replica-${replica}`,
					directory: sqliteDirectory(replica),
					preserveOnInitFailure: true,
					// Retrying needs this too; the runtime takes it, the declarations omit it.
					...({ forceReinitIfPreviouslyFailed: true } as object),
				}),
			catch: (cause) => ReplicaStorageError.Unavailable({ cause }),
		});
		if (pool.error === null) {
			const util = pool.data;
			const driver = wasmDriver(
				sqlite3.data,
				new util.OpfsSAHPoolDb('/replica.sqlite3'),
			);
			return Ok({
				...driver,
				close() {
					driver.close();
					// Release the access handles now rather than when the worker is collected.
					util.pauseVfs();
				},
			});
		}
		// Only another worker holding the pool is worth waiting for.
		if (!isContended(pool.error.cause)) return pool;
		if (attempt === 0) onWaiting(extractErrorMessage(pool.error.cause));
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, maxDelayMs);
	}
}
