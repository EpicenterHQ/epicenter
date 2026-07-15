/**
 * `queryBooks`: read-only SQL over the local QuickBooks mirror. The `query` CLI
 * verb is a thin adapter over this; an off-the-shelf coding agent pointed at
 * `books.db` is the other consumer. The data leaves the machine only as the rows
 * this returns, the egress ADR-0033 already accepts.
 *
 * Read-only is enforced by the connection, not a string check:
 * `new Database(path, { readonly: true })` makes SQLite reject every write
 * statement, so even arbitrary SQL cannot mutate the mirror. Results are
 * row-capped so a broad query cannot flood a caller (or a model's context).
 *
 * This core is shared by the CLI and the app-owned MCP server without changing
 * the read-only database boundary.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const BooksQueryError = defineErrors({
	NoMirror: ({ path }: { path: string }) => ({
		message: `No QuickBooks mirror at ${path}. Run "local-books sync --full" first.`,
	}),
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read-only query failed (the mirror rejects writes): ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BooksQueryError = InferErrors<typeof BooksQueryError>;

/** Cap returned rows so a broad query cannot flood the caller. */
const MAX_ROWS = 1000;

export type BooksQueryResult = {
	rows: Record<string, unknown>[];
	/** Rows returned (at most MAX_ROWS); `truncated` flags that more matched. */
	rowCount: number;
	truncated: boolean;
};

/**
 * Run a read-only SQL query against the mirror at `dbPath`. The handle is opened
 * read-only per call (cheap, and it sidesteps holding a lock while a sync
 * writes), so a query can run while `local-books sync` runs.
 *
 * Rows are pulled lazily and the read STOPS at the cap: a query reads at most
 * `MAX_ROWS + 1` rows, never the full result set. This is what makes the cap a
 * real bound rather than cosmetic, since the caller is often an untrusted model:
 * a recursive CTE, a cartesian product, or any huge result set cannot
 * materialize an unbounded array and exhaust memory. The read-only connection
 * still rejects every write statement (the integrity boundary). A single
 * enormous value or a pure-CPU query is out of scope of the row cap.
 */
export function queryBooks({
	dbPath,
	sql,
}: {
	dbPath: string;
	sql: string;
}): Result<BooksQueryResult, BooksQueryError> {
	if (!existsSync(dbPath)) return BooksQueryError.NoMirror({ path: dbPath });
	// The open is inside the try so a corrupt or unreadable db surfaces as a
	// Result error, not an uncaught throw.
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows: Record<string, unknown>[] = [];
			let truncated = false;
			for (const row of db.query(sql).iterate()) {
				if (rows.length === MAX_ROWS) {
					truncated = true;
					break;
				}
				rows.push(row as Record<string, unknown>);
			}
			return Ok({ rows, rowCount: rows.length, truncated });
		} finally {
			db.close();
		}
	} catch (cause) {
		return BooksQueryError.QueryFailed({ cause });
	}
}
