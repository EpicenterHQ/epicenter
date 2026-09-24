/**
 * The CRDT's durable bytes over SQLite: the append log, the fold, and the
 * vocabulary both ports share.
 *
 * One relation answers every question. What is owed is the rows where
 * `authoritySeq` is NULL, the cursor is `MAX(authoritySeq)`, and the next id
 * is `MAX(id)`; none of the three is stored beside the bytes it describes,
 * because two copies of one fact can disagree and a derived one cannot
 * (ADR-0298). `../README.md` has the table that makes that column readable.
 *
 * Everything else, an index or an export, is a follower an application
 * composes over the document rather than a relation kept here.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';

export type { OutboxEntry } from './persistence.js';

/**
 * How many rows gather before they collapse, on either side of the column.
 *
 * One number, two collapses (ADR-0301): acknowledged rows fold into one
 * baseline by whole-document re-encode, and owed rows merge into one
 * resendable row. Neither is a prefix rule; both are questions about the row.
 *
 * ## Why 64, and why not more
 *
 * The instinct is that folding is the expensive part, so a bigger number
 * means less work. Measured against the real IndexedDB port, that is backwards
 * (`evidence/browser/port-cost`):
 *
 * ```txt
 *   the commit that folds        a cold open
 *    160 KB doc     4.1 ms         64 rows      1.8 ms
 *   1554 KB doc     6.6 ms       1000 rows     55.6 ms
 *   6381 KB doc    15.8 ms       4000 rows    558.4 ms
 * ```
 *
 * Folding is cheap even on a large document. A long chain is not, and almost
 * all of that cost is the Yjs replay rather than storage, so it is charged on
 * every launch. Raising this number trades a handful of cheap folds for a
 * slower open every single time the application starts.
 *
 * The floor is real too. `transport.test.ts` drives a thousand sends with no
 * idle gap: threshold 64 finishes in about 7.5 seconds, threshold 1 takes
 * about 20 and times out one case, because re-encoding the whole document per
 * acknowledgement is the cost the number exists to amortize.
 */
export const SNAPSHOT_FOLD_THRESHOLD = 64;

type StoredUpdate = SqliteRow & {
	seq: number;
	bytes: Uint8Array | ArrayBuffer;
};

/**
 * The durable record: the update log, and the outbox and the cursor that are
 * read off it. One relation, because the generation is in the ADDRESS
 * (ADR-0292): what used to sit beside the chain was the document identity, the
 * membership fact a replica stamped at first entanglement, and a record at
 * this address can only belong to one generation.
 */
export function applyStoreSchema(sqlite: SqliteDatabase): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _updates (
			id           INTEGER NOT NULL CHECK (id > 0),
			bytes        BLOB    NOT NULL,
			authoritySeq INTEGER CHECK (authoritySeq IS NULL OR authoritySeq >= 0),
			PRIMARY KEY (id)
		) WITHOUT ROWID, STRICT
	`);
	// Owed work is read off the chain, so the query that answers "what do I
	// still owe" has to be an index seek rather than a scan of every update.
	sqlite.run(`
		CREATE INDEX IF NOT EXISTS _updates_owed
			ON _updates (id) WHERE authoritySeq IS NULL
	`);
}

/**
 * The position before the authority's first, for bytes it will never place.
 *
 * Not a sentinel squeezed into a value space. The authority numbers entries
 * `COALESCE(MAX(seq), 0) + 1`, so its first position is 1 and 0 is unreachable
 * by construction (`sync/authority.ts`). What 0 means here is exactly what it
 * reads as: held, and from before anything the authority has.
 *
 * ```txt
 *   NULL          owed. an account replica's edit, waiting for a position.
 *   NO_AUTHORITY  held, and never owed. received bytes whose position is not
 *                 known, and a fold baseline on a store that does not sync.
 *   >= 1          the position the authority's log gave it.
 * ```
 *
 * The distinction that matters is NULL against everything else, because that
 * is the one the sender reads. Re-offering received bytes "would grow the log
 * with nothing new in it", so bytes that arrived must never read as owed.
 */
export const NO_AUTHORITY = 0;

/**
 * Every append the authority has no position for, oldest first.
 *
 * The outbox, as a query. It used to be a relation, because the fold
 * renumbered a document's chain from 1 and any position recorded against it
 * silently came to mean a different update. Ids are stable now, so owed work
 * is a property of an append rather than a copy of one, and the same bytes
 * stop being written twice on every local edit.
 */
export function readOutbox(sqlite: SqliteDatabase): OutboxEntry[] {
	// A store with no authority owes nobody, and it says so in the column
	// rather than in a constructor argument: its own appends record
	// `NO_AUTHORITY`, so NULL means owed on every store kind (ADR-0301).
	return sqlite
		.all<SqliteRow & { id: number; bytes: Uint8Array }>(
			'SELECT id, bytes FROM _updates WHERE authoritySeq IS NULL ORDER BY id',
		)
		.map((row) => ({ id: row.id, bytes: copyBytes(row.bytes) }));
}

/**
 * How far through the authority's log this replica has read.
 *
 * Derived, and that is the point: a cursor computed from the bytes it accounts
 * for cannot run ahead of them. The rule that used to need one atomic batch to
 * enforce ("with the bytes, never after them") is now unrepresentable.
 *
 * Zero means nothing has been read, which is also what a fresh replica and a
 * local store both report.
 */
export function readCursor(sqlite: SqliteDatabase): number {
	return (
		sqlite.all<SqliteRow & { seq: number | null }>(
			'SELECT MAX(authoritySeq) AS seq FROM _updates',
		)[0]?.seq ?? 0
	);
}

/** The highest id any append carries, so the store mints from here. */
export function readLastId(sqlite: SqliteDatabase): number {
	return (
		sqlite.all<SqliteRow & { id: number | null }>(
			'SELECT MAX(id) AS id FROM _updates',
		)[0]?.id ?? 0
	);
}

/**
 * Record that the authority took responsibility through `throughId`, at the
 * position it put those bytes.
 *
 * One statement for what used to be two ops. `dropOutbox` deleted rows from a
 * relation and `cursor` wrote a number; both were reporting that the same
 * bytes reached the same log entry. Only rows still owed are stamped, so a
 * repeated ack is a no-op rather than a rewrite.
 */
export function acknowledge(
	sqlite: SqliteDatabase,
	throughId: number,
	authoritySeq: number,
): void {
	sqlite.run(
		'UPDATE _updates SET authoritySeq = ? WHERE id <= ? AND authoritySeq IS NULL',
		[authoritySeq, throughId],
	);
}

export function readUpdates(sqlite: SqliteDatabase): StoredUpdate[] {
	return sqlite.all<StoredUpdate>(
		'SELECT id AS seq, bytes FROM _updates ORDER BY id',
	);
}

export function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/** Replay one stored chain into a fresh document. */
export function replay(updates: readonly StoredUpdate[]): Y.Doc {
	const document = new Y.Doc({ gc: true });
	try {
		for (const update of updates) {
			Y.applyUpdateV2(document, copyBytes(update.bytes));
		}
		return document;
	} catch (cause) {
		document.destroy();
		throw cause;
	}
}

/**
 * How many rows a fold would collapse, asked without reading one of them.
 *
 * The distinction this exists to make is the whole cost of the fold's gate.
 * `foldable` below selects `bytes`, and the row it always selects is the
 * BASELINE, which is the whole document. Asking "is the chain long enough
 * yet?" with that list in hand read a document-sized blob for every append
 * that was not the sixty-fourth, which is to say for almost every append. A
 * count answers the same question and touches no blob, so the gate stops
 * scaling with the document and the threshold stops being a number you cannot
 * afford to raise.
 */
function foldableCount(sqlite: SqliteDatabase): number {
	return (
		sqlite.all<SqliteRow & { rows: number }>(
			'SELECT COUNT(*) AS rows FROM _updates WHERE authoritySeq IS NOT NULL',
		)[0]?.rows ?? 0
	);
}

/**
 * Collapse a document's chain into one baseline.
 *
 * The fold used to replace the WHOLE chain and renumber it from 1, and that
 * renumbering is what forced owed work into a relation of its own: a position
 * recorded against a chain that restarts means a different update afterwards.
 * Ids are stable now, so what it collapses is a question of what still has to
 * be addressable.
 *
 * What it collapses is a question about the ROW, not about the store
 * (ADR-0301). An acknowledged row can be replaced by a whole-document
 * re-encode, which is the strongest compaction available and the only one that
 * realizes `gc: true`. An owed row cannot: the authority has not seen those
 * bytes, and a whole document is not a delta it could be offered. Owed rows
 * collapse by merging instead, which `mergeOwed` does.
 *
 * The store's kind used to be the question, as a constructor argument
 * (ADR-0239). It stopped being one when a local store started recording
 * `NO_AUTHORITY` on its own appends: a store with no authority then holds no
 * owed rows at all, so it folds everything here without being told to, and
 * NULL means owed and nothing else.
 */
function fold(sqlite: SqliteDatabase): void {
	if (foldableCount(sqlite) < SNAPSHOT_FOLD_THRESHOLD) return;
	const foldable = sqlite.all<StoredUpdate>(
		'SELECT id AS seq, bytes FROM _updates WHERE authoritySeq IS NOT NULL ORDER BY id',
	);

	const through = foldable.at(-1)?.seq;
	if (through === undefined) return;
	// Read before the delete, because the rows carrying it are the rows about
	// to go. The baseline inherits the highest position it replaced, so it is
	// never owed and never offered back. On a store with no authority every
	// row already carries `NO_AUTHORITY`, so the maximum IS `NO_AUTHORITY` and
	// nothing has to special-case it.
	const position =
		sqlite.all<SqliteRow & { seq: number | null }>(
			'SELECT MAX(authoritySeq) AS seq FROM _updates',
		)[0]?.seq ?? NO_AUTHORITY;
	const compacted = replay(foldable);
	try {
		const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
		sqlite.run('DELETE FROM _updates WHERE authoritySeq IS NOT NULL');
		sqlite.run(
			'INSERT INTO _updates (id, bytes, authoritySeq) VALUES (?, ?, ?)',
			[through, baseline, position],
		);
	} finally {
		compacted.destroy();
	}
}

/**
 * Everything this file durably held at open, materialized once.
 *
 * The store hydrates its one document from `updates`, seeds its durable mirror
 * from the rest, and never reads this file again outside a flush (ADR-0238).
 */
export function loadDurableSnapshot(sqlite: SqliteDatabase): DurableSnapshot {
	return {
		updates: readUpdates(sqlite).map((stored) => copyBytes(stored.bytes)),
		outbox: readOutbox(sqlite),
		cursor: readCursor(sqlite),
		lastId: readLastId(sqlite),
	};
}

/**
 * The SQLite durable engine: one batch, one transaction, in order.
 *
 * Synchronous, which is what lets a verb on a Durable Object return with its
 * write already durable. Opening applies the schema and enforces the format
 * certificate (ADR-0231's cutover), exactly as every open always has.
 */
export function createSqliteDurablePort({
	sqlite,
}: {
	sqlite: SqliteDatabase;
}): DurablePort & { load(): DurableSnapshot } {
	applyStoreSchema(sqlite);
	return {
		load: () => loadDurableSnapshot(sqlite),
		commit(ops: readonly DurableOp[]): void {
			sqlite.transaction(() => {
				for (const op of ops) {
					switch (op.kind) {
						case 'append':
							sqlite.run(
								'INSERT INTO _updates (id, bytes, authoritySeq) VALUES (?, ?, ?)',
								[op.id, new Uint8Array(op.bytes), op.authoritySeq ?? null],
							);
							break;
						case 'ack':
							acknowledge(sqlite, op.throughId, op.authoritySeq);
							break;
						case 'mergeOwed':
							for (const replaced of op.replaces) {
								sqlite.run('DELETE FROM _updates WHERE id = ?', [replaced]);
							}
							sqlite.run(
								'INSERT INTO _updates (id, bytes, authoritySeq) VALUES (?, ?, NULL)',
								[op.id, new Uint8Array(op.bytes)],
							);
							break;
					}
				}
				// Once, after the whole batch, which is what the IndexedDB port has
				// always done and what this one only appeared to do. Folding per
				// append made a 25-append flush ask the same question 25 times and
				// answer it 24 times with "not yet". Folding after the acks also
				// means a batch that acknowledges work can collapse it in the same
				// transaction, rather than leaving it for whatever writes next.
				fold(sqlite);
			});
		},
	};
}
