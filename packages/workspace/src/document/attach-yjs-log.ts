/**
 * Y.Doc durability via an append-log SQLite file.
 *
 * Owns one SQLite file (`updates` table, BLOB column, autoincrement id).
 * Every Y.Doc `updateV2` becomes a row; on construction the rows are
 * replayed in id order; periodically the log is compacted into a single
 * state-as-update row. Pairs with `openCollaboration` (workspace or content
 * doc) for cross-machine convergence; pairs with `attachYjsLogReader` for
 * read-only consumers in app-owned execution paths.
 *
 * Distinct from `attachBunSqliteMaterializer`, which writes a different file
 * with derived per-table rows for SQL queries. This module is the Y.Doc
 * update-log layer; that one is the projection layer.
 *
 * The on-disk format is shared with `attachYjsLogReader`. If you change
 * the schema or the replay invariants here, change them there too. WAL
 * is enabled so a readonly consumer can open the same file concurrently
 * and read snapshot pages without `SQLITE_BUSY`.
 *
 * Construction is synchronous: `mkdirSync` + open + replay all run on
 * the calling tick. The Y.Doc is fully hydrated by the time this
 * function returns, so the attachment carries no `whenLoaded` field.
 * Browser code uses `attachIndexedDb`, which is genuinely async and
 * does carry `whenLoaded`; that asymmetry is real, not vestigial.
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import { debounce } from '../shared/debounce.js';
import { openWriterSqlite } from './sqlite-writer.js';

/** Max compacted update size (2 MB). Matches the Cloudflare DO limit. */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Compact when accumulated incremental updates exceed this size.
 *
 * Targets the real problem: large row replacements (e.g. 30 KB autosaves)
 * accumulating over long desktop sessions. At 2 MB the log is guaranteed
 * to be 10-50x larger than the compact doc for typical workloads. Low
 * enough to prevent multi-MB logs; high enough to ignore thousands of
 * tiny keystroke updates that total only a few hundred KB.
 */
const COMPACTION_BYTE_THRESHOLD = 2 * 1024 * 1024;

/**
 * Debounce compaction by 5 s after the byte threshold is crossed.
 *
 * Prevents compacting during a burst of rapid writes (e.g. bulk import).
 * The compaction itself is fast (~16 ms for 10 K rows) but we don't want
 * to interrupt a hot write path.
 */
const COMPACTION_DEBOUNCE_MS = 5_000;

export function attachYjsLog(
	ydoc: Y.Doc,
	{
		filePath,
		log = createLogger('workspace/attach-yjs-log'),
	}: { filePath: string; log?: Logger },
) {
	const db = openWriterSqlite({ filePath, log });

	db.run(
		'CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)',
	);

	// `db.query()` caches the compiled prepared statement on the Database,
	// which matters on the hot `updateV2` path where every local Yjs
	// transaction appends one BLOB row.
	const countUpdates = db.query('SELECT COUNT(*) as count FROM updates');
	const selectUpdates = db.query('SELECT data FROM updates ORDER BY id');
	const insertUpdate = db.query('INSERT INTO updates (data) VALUES (?)');
	const deleteUpdates = db.query('DELETE FROM updates');
	const compactUpdateLogTx = db.transaction((compacted: Uint8Array) => {
		deleteUpdates.run();
		insertUpdate.run(compacted);
	});

	/**
	 * Compact the SQLite update log into a single row.
	 *
	 * Encodes the current doc state via `Y.encodeStateAsUpdateV2`, which
	 * produces smaller output than merging individual updates. No-ops if the
	 * compacted blob exceeds 2 MB, or if the log already has <= 1 row (unless
	 * `force` is set).
	 *
	 * @param force - Compact even at <= 1 row. The corrupt-row heal sets this
	 *   so a lone undecodable row is replaced, not left to re-throw on every
	 *   future open.
	 * @returns `true` if compaction ran, `false` if it no-oped.
	 */
	function compactUpdateLog({
		force = false,
	}: {
		force?: boolean;
	} = {}): boolean {
		const row = countUpdates.get() as { count: number };
		if (!force && row.count <= 1) return false;

		const compacted = Y.encodeStateAsUpdateV2(ydoc);
		if (compacted.byteLength > MAX_COMPACTED_BYTES) return false;

		compactUpdateLogTx(compacted);
		return true;
	}

	// bun:sqlite returns BLOB columns as Uint8Array; Y.applyUpdateV2
	// accepts Uint8Array directly.
	const rows = selectUpdates.all() as {
		data: Uint8Array;
	}[];
	let corruptRowsSkipped = 0;
	for (const row of rows) {
		// A corrupt BLOB (a half-written or truncated row) makes
		// Y.applyUpdateV2 throw mid-replay. Unguarded, that aborts construction
		// and the owning application cannot open the document. Skip the bad row: the
		// doc still hydrates from the good rows, and cloud resync supplies
		// whatever the skipped row carried (same contract as the y-indexeddb
		// load patch on the browser side).
		try {
			Y.applyUpdateV2(ydoc, row.data);
		} catch (cause) {
			corruptRowsSkipped++;
			log.error(
				new Error(
					'Skipped a corrupt update row during replay; resync supplies it',
					{ cause },
				),
			);
		}
	}

	// A skipped row stays on disk and would re-throw on every future open.
	// Compaction rewrites the whole log as one clean snapshot of the hydrated
	// doc, dropping the bad rows; force it past the usual <= 1-row no-op so a
	// lone corrupt row cannot linger.
	compactUpdateLog({ force: corruptRowsSkipped > 0 });

	let bytesSinceCompaction = 0;

	const compactAfterDebounce = debounce(() => {
		if (compactUpdateLog()) bytesSinceCompaction = 0;
	}, COMPACTION_DEBOUNCE_MS);

	const updateHandler = (update: Uint8Array) => {
		insertUpdate.run(update);

		bytesSinceCompaction += update.byteLength;
		if (bytesSinceCompaction > COMPACTION_BYTE_THRESHOLD) {
			compactAfterDebounce();
		}
	};

	ydoc.on('updateV2', updateHandler);

	// On destroy: timer is cleared and the updateV2 listener is detached
	// before db.close(), so neither the timer callback nor the listener
	// can fire after the handle is gone. No `isClosed` guard needed.
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			compactAfterDebounce.cancel();
			ydoc.off('updateV2', updateHandler);
			// Final compaction can throw on a corrupt write or a closed db.
			// Swallowing silently inside teardown leaves no trace for
			// debugging; log instead so the failure surfaces.
			try {
				compactUpdateLog();
			} catch (cause) {
				log.warn(
					new Error('Final compactUpdateLog failed during destroy', {
						cause,
					}),
				);
			}
			// `db.close()` can throw if the handle was already closed or if SQLite
			// refuses (e.g. unfinalized statements). Same rationale: log, don't let
			// it escape the destroy listener.
			try {
				db.close();
			} catch (cause) {
				log.warn(new Error('db.close() failed during destroy', { cause }));
			}
		} finally {
			resolveDisposed();
		}
	});

	return {
		/** Resolves after final compaction runs and the SQLite handle closes. */
		whenDisposed,
	};
}

export type YjsLogAttachment = ReturnType<typeof attachYjsLog>;
