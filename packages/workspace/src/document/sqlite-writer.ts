/**
 * Writer-side SQLite file factory.
 *
 * Both `attachYjsLog` (the Y.Doc update-log writer) and
 * `attachBunSqliteMaterializer` (the queryable projection writer) sit on the
 * same axis: one application-owned process writes the file, while scripts open it
 * `{ readonly: true }` and snapshot-read in parallel. This factory is the one
 * place that handles the writer-side preamble: ensure the parent dir exists,
 * open the database, and apply the standard concurrency PRAGMAs.
 *
 *   journal_mode = WAL    enables MVCC snapshot reads while we write.
 *   synchronous = NORMAL  the canonical durability tradeoff under WAL.
 *   busy_timeout = 5000   waits on SQLITE_BUSY instead of surfacing it.
 *
 * `:memory:` skips the mkdir and PRAGMAs (WAL is not honored on
 * `:memory:`; the companion pragmas are no-ops there too).
 *
 * Source-of-truth motivation: if we change the rule (add
 * `wal_autocheckpoint`, tune the busy timeout, harden the WAL
 * verification), every writer-side SQLite file in the project must
 * pick up the change in lockstep.
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { trySync } from 'wellcrafted/result';

/**
 * Errors surfaced by `openWriterSqlite`. Each pragma is best-effort:
 * `:memory:` is sidestepped entirely, and some test setups reject WAL
 * silently; the writer continues with driver defaults rather than
 * failing the open.
 */
const SqliteWriterError = defineErrors({
	/** A `PRAGMA` statement threw at execution time. */
	PragmaSetupFailed: ({
		pragma,
		cause,
	}: {
		pragma: string;
		cause: unknown;
	}) => ({
		message: `[sqlite-writer] PRAGMA ${pragma} failed: ${extractErrorMessage(cause)}`,
		pragma,
		cause,
	}),
	/**
	 * `PRAGMA journal_mode = WAL` did not throw, but SQLite responded
	 * with a different mode (silent fallback on filesystems that don't
	 * support WAL). Carry the actual mode so callers can distinguish
	 * "rejected" from "errored."
	 */
	WalSilentFallback: ({ actualMode }: { actualMode: string }) => ({
		message: `[sqlite-writer] PRAGMA journal_mode = WAL returned '${actualMode}', expected 'wal'`,
		actualMode,
	}),
});
type SqliteWriterError = InferErrors<typeof SqliteWriterError>;

/**
 * Open (or create) a writer-side SQLite file ready for an application's
 * many-readers + one-writer design.
 *
 * - Ensures the parent directory exists (`mkdirSync` recursive).
 * - Opens a `bun:sqlite` Database in read-write mode.
 * - Applies the standard concurrency PRAGMAs (skipped for `:memory:`).
 *
 * Pragma failures log to `log` but don't throw: a degraded WAL setup
 * on an exotic filesystem should still produce a usable handle.
 */
export function openWriterSqlite({
	filePath,
	log,
}: {
	filePath: ':memory:' | (string & {});
	log: Logger;
}): Database {
	if (filePath === ':memory:') return new Database(':memory:');

	mkdirSync(dirname(filePath), { recursive: true });
	const db = new Database(filePath);

	const walResult = trySync({
		try: () =>
			(db.query('PRAGMA journal_mode = WAL').get() as { journal_mode: string })
				.journal_mode,
		catch: (cause) =>
			SqliteWriterError.PragmaSetupFailed({
				pragma: 'journal_mode = WAL',
				cause,
			}),
	});
	if (walResult.error !== null) {
		log.warn(walResult.error);
	} else if (walResult.data !== 'wal') {
		log.warn(
			SqliteWriterError.WalSilentFallback({ actualMode: walResult.data }),
		);
	}

	const syncResult = trySync({
		try: () => db.run('PRAGMA synchronous = NORMAL'),
		catch: (cause) =>
			SqliteWriterError.PragmaSetupFailed({
				pragma: 'synchronous = NORMAL',
				cause,
			}),
	});
	if (syncResult.error !== null) log.warn(syncResult.error);

	const busyResult = trySync({
		try: () => db.run('PRAGMA busy_timeout = 5000'),
		catch: (cause) =>
			SqliteWriterError.PragmaSetupFailed({
				pragma: 'busy_timeout = 5000',
				cause,
			}),
	});
	if (busyResult.error !== null) log.warn(busyResult.error);

	return db;
}
