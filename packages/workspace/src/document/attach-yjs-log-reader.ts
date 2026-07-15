/**
 * Read-only hydrator for an `attachYjsLog` file.
 *
 * Opens a file the writer (`attachYjsLog`) owns, replays every
 * `updates` row into the Y.Doc once, and stops there: no `updateV2`
 * listener, no compaction timer, no writes. The reader's Y.Doc can mutate
 * freely afterwards; mutations stay in memory and never flow back to disk.
 *
 * Use case: a read-only script opening the Yjs log written by an application.
 *
 * Missing files are a no-op: `fileExisted` is `false` with no replay
 * (the Y.Doc stays empty) so the caller falls through to cloud sync.
 * The writer is expected to have set WAL on the file so concurrent
 * readers get snapshot pages without `SQLITE_BUSY`.
 *
 * Construction is synchronous: `existsSync` + open + replay all run on
 * the calling tick. The Y.Doc is fully hydrated by the time this
 * function returns; no `whenLoaded` field.
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { createLogger, type Logger } from 'wellcrafted/logger';
import * as Y from 'yjs';

/**
 * Open the writer's file `{ readonly: true }` and replay every row into
 * the Y.Doc. Returns the open db handle so the caller can close it on
 * destroy. File-doesn't-exist is the cold path: caller short-circuits.
 */
function openAndReplay(filePath: string, ydoc: Y.Doc, log: Logger): Database {
	const db = new Database(filePath, { readonly: true });
	// File is owned by the writer. No CREATE TABLE, no journal_mode pragma
	// (the writer set WAL), no updateV2 listener, no compaction: pure
	// snapshot consumer. We do set `busy_timeout` so a reader opening
	// mid-checkpoint waits instead of surfacing SQLITE_BUSY.
	db.run('PRAGMA busy_timeout = 5000');
	// bun:sqlite returns BLOB columns as Uint8Array; Y.applyUpdateV2
	// accepts Uint8Array directly.
	const rows = db.query('SELECT data FROM updates ORDER BY id').all() as {
		data: Uint8Array;
	}[];
	for (const row of rows) {
		// Match the writer's replay guard: a corrupt BLOB makes applyUpdateV2
		// throw, which would otherwise abort this synchronous hydrate. Skip it
		// and log; the reader is read-only, so it cannot compact the bad row
		// away, but the writer heals the file on its next open and resync fills
		// the gap.
		try {
			Y.applyUpdateV2(ydoc, row.data);
		} catch (cause) {
			log.error(
				new Error(
					'Skipped a corrupt update row during replay; resync supplies it',
					{ cause },
				),
			);
		}
	}
	return db;
}

export function attachYjsLogReader(
	ydoc: Y.Doc,
	{
		filePath,
		log = createLogger('workspace/attach-yjs-log-reader'),
	}: { filePath: string; log?: Logger },
) {
	const fileExisted = existsSync(filePath);
	const db = fileExisted ? openAndReplay(filePath, ydoc, log) : undefined;

	ydoc.once('destroy', () => {
		db?.close();
	});

	return {
		/**
		 * `true` if the file existed at open time and rows were replayed;
		 * `false` if the owning application has not written here yet. Snapshot value,
		 * taken once at construction; the file is not re-checked later.
		 */
		fileExisted,
	};
}

export type YjsLogReaderAttachment = ReturnType<typeof attachYjsLogReader>;
