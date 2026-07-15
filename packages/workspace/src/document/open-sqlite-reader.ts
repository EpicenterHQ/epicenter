/**
 * Read-only handle on an application's materialized SQLite mirror file.
 *
 * `attachBunSqliteMaterializer` runs in the owning application and writes the mirror
 * in WAL journal mode (one writer, many readers, MVCC snapshots). Script peers
 * open the same file via `openSqliteReader({ filePath })`, get a read-only
 * `Database` handle plus an FTS5 `search()` helper that uses the writer's
 * index, and skip the cold-start cost of computing the index themselves.
 *
 * Output handle:
 *   { db, search(table, query, opts?), [Symbol.dispose]() }
 *
 * `db` is a `bun:sqlite` `Database` opened with `{ readonly: true }` and
 * `PRAGMA query_only = ON`, so any errant write attempt fails fast at the
 * driver. Callers run raw SQL through `reader.db.query(...)`; this primitive
 * intentionally stays narrow.
 *
 * Named `open*` rather than `attach*` because it has no Y.Doc to attach to
 * and registers no listeners. The caller owns the lifecycle through `using`
 * or an explicit `[Symbol.dispose]()` call.
 *
 * The mirror does not observe schema changes or ydoc state. It is a thin
 * wrapper around an on-disk file the application owns; if the application has not
 * created the file yet, opening throws and the script can decide whether
 * to retry, fall back to the synced Y.Doc, or surface the error.
 */

import { Database } from 'bun:sqlite';
import { quoteIdentifier } from './materializer/sqlite/ddl.js';
import {
	buildFtsSearchSql,
	mapFtsSearchRows,
	type SearchOptions,
	type SearchResult,
} from './materializer/sqlite/fts.js';

/**
 * Options for {@link openSqliteReader}.
 */
export type OpenSqliteReaderOptions = {
	/**
	 * Absolute path to the application's mirror SQLite file.
	 */
	filePath: string;
};

/**
 * Open an application's SQLite mirror file read-only.
 *
 * The mirror is opened with `{ readonly: true }`; we additionally execute
 * `PRAGMA query_only = ON` so any unintentional write inside a
 * caller-supplied raw SQL string fails. Reads run against WAL snapshot
 * pages without blocking the owning application's writes. The returned handle is
 * disposable via the explicit-resource-management protocol: declare with
 * `using reader = openSqliteReader(...)` and the underlying database handle
 * closes on scope exit.
 *
 * @example
 * ```ts
 * using reader = openSqliteReader({
 *   filePath: '/absolute/path/to/fuji.sqlite',
 * });
 * const hits = reader.search('entries', 'hello world', { limit: 25 });
 * const rows = reader.db.query('SELECT * FROM entries').all();
 * ```
 */
export function openSqliteReader({ filePath }: OpenSqliteReaderOptions) {
	const db = openReadonlySqlite(filePath);

	let isDisposed = false;

	const ftsColumnsCache = new Map<string, string[]>();
	function ftsColumnsFor(tableName: string): string[] {
		const cached = ftsColumnsCache.get(tableName);
		if (cached !== undefined) return cached;
		// `PRAGMA table_info(<tablename>_fts)` exposes the FTS5 column list
		// in declaration order. Defaults to an empty list if the FTS table
		// does not exist (the search call below will then short-circuit).
		const rows = db
			.query(`PRAGMA table_info(${quoteIdentifier(`${tableName}_fts`)})`)
			.all() as Array<{ name: string }>;
		const columns = rows.map((row) => row.name);
		ftsColumnsCache.set(tableName, columns);
		return columns;
	}

	function search(
		tableName: string,
		query: string,
		{ limit = 50, snippetColumn }: SearchOptions = {},
	): SearchResult[] {
		if (isDisposed) return [];
		const trimmed = query.trim();
		if (!trimmed) return [];

		const ftsColumns = ftsColumnsFor(tableName);
		if (ftsColumns.length === 0) return [];

		const snippetColumnIndex = snippetColumn
			? Math.max(ftsColumns.indexOf(snippetColumn), 0)
			: 0;

		const rows = db
			.query(buildFtsSearchSql(tableName, snippetColumnIndex))
			.all(trimmed, limit);

		return mapFtsSearchRows(rows);
	}

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		db.close();
	}

	return {
		/**
		 * The opened SQLite database handle. Read-only; `query_only` PRAGMA is
		 * set so accidental writes fail at the driver layer.
		 */
		get db() {
			return db;
		},
		/**
		 * Run an FTS5 search against the materialized `<table>_fts` virtual
		 * table. Returns ranked results with snippets. Returns an empty array
		 * if the FTS table is missing or the query is empty.
		 */
		search,
		/** Close the database handle. Idempotent. */
		[Symbol.dispose]: dispose,
	};
}

export type SqliteReader = ReturnType<typeof openSqliteReader>;

/** @internal Shared read-only SQLite open preamble for local reader helpers. */
export function openReadonlySqlite(filePath: string): Database {
	const db = new Database(filePath, { readonly: true });
	db.run('PRAGMA query_only = ON');
	// Wait up to 5s on SQLITE_BUSY when a reader opens during a checkpoint
	// instead of surfacing the error to callers. The writer-side
	// `openWriterSqlite` setup sets the same value.
	db.run('PRAGMA busy_timeout = 5000');
	return db;
}
