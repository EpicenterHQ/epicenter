/**
 * The authority: an append-only log of opaque bytes, and no Yjs call at all.
 *
 * There are no Yjs imports in this file, and that is the design rather than an
 * accident of the current implementation. It never merges, never compacts,
 * never holds a document, never decodes, and never learns what a row is.
 * Catch-up is "everything after your cursor" and a live relay is the same
 * sentence with a cursor one behind the head, so there is one delivery path
 * rather than two that can disagree.
 *
 * ## Why it does not look at the bytes
 *
 * An earlier version made exactly one Yjs call before storing, `diffUpdateV2`
 * against an empty state vector, and kept only whether it threw. It was removed.
 * The reasons are written down here because "surely the server should check the
 * update is valid" is the obvious thing to propose, and every part of the bill
 * is invisible from the call site:
 *
 * - **It could not be a proof, only a filter.** Whether bytes throw depends on
 *   the structs the RECEIVER already holds, and the authority holds none by
 *   construction, so the receiver's predicate is not available to it at any
 *   price. Swept over every single-byte corruption of a real update, the call
 *   let through 44 poison pills on a full update and 4 on an increment;
 *   integrating into a throwaway `Y.Doc`, the most an authority could possibly
 *   do, still leaked 3 (`evidence/validation.test.ts`).
 * - **It was the most expensive thing here.** 283 MB rss and 45 ms on a 27.7 MB
 *   update, which is MORE than hydrating an entire `Y.Doc` (108 MB, 35 ms),
 *   because it decodes the whole stream and re-encodes a full copy before
 *   discarding it. The cheap-looking call was the ceiling on what one submission
 *   costs the object, and it is the measurement that removed it
 *   (`evidence/bench/validate.ts`).
 * - **It was the only thing coupling this file to Yjs's version.** With it gone,
 *   a Yjs format change cannot make the server refuse a valid client's writes.
 * - **It foreclosed end-to-end encryption**, which is possible exactly as long
 *   as the authority never reads the bytes. That is the reason not to reach for
 *   it again the next time it looks free.
 *
 * Recovery never needed it either. The log is append-only and every entry is
 * individually addressable, so a poison entry is repaired by overwriting that
 * one row's bytes with the 13-byte empty update, a valid no-op that keeps the
 * sequence contiguous and that every replica walks straight past. A replica that
 * cannot apply an entry says so and names the position
 * (`SyncClientError.Unapplyable`); both halves are pinned in
 * `sync/transport.test.ts`. What bounds the damage in the first place is that a
 * partition has one writer principal, so the only party who can author bytes
 * that brick it is the party that owns it.
 *
 * ## Why it refuses root-document compaction
 *
 * Four authority designs were built and withdrawn, all failing at one joint: a
 * A root-document rewrite must prove the replacement covers what it replaces,
 * and that proof needs semantics the authority was defined not to have. The
 * authority therefore does not own that product action. It does perform the
 * narrower automatic snapshot fold: a client offers its own state, and the
 * authority verifies only that the connection was sent through the offered
 * position. The application merge remains on the client, over bytes that
 * client owns.
 *
 * Do not reintroduce root-document compaction or baselines here. Snapshot
 * coverage is the separate automatic log-folding invariant.
 *
 * This authority describes exactly one generation of one database, and the
 * ADDRESS says which (ADR-0292). It holds no identity of its own and answers
 * no membership question, because a generation is created once and never
 * mutated in place, so a replica that reached this object was addressed at
 * this history. A whole-database rebuild is a new generation, which is a new
 * object; ADR-0276 named that action Rebuild rather than Compact, because it
 * retains what it rebuilt from.
 */
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, type Result, trySync } from 'wellcrafted/result';

import { copyBytes } from '../store/log.js';
import { CHUNK_BYTES, intoChunks } from './frames.js';

export const AuthorityError = defineErrors({
	/**
	 * The only way an append can fail, now that nothing inspects the bytes.
	 *
	 * The client hears it as a refusal naming its submission, which is the
	 * point: `workerd` swallows a throw in `webSocketMessage` without closing the
	 * socket, so silence and success are indistinguishable to a client.
	 */
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The authority could not commit to durable storage',
		cause,
	}),
	/**
	 * A snapshot was offered at a position it cannot stand for.
	 *
	 * The condition is COVERAGE, not currency, and the difference is the whole
	 * subtlety. A snapshot at P is used to forget every entry at or before P, so
	 * all it must do is account for those. It does NOT have to be at the head:
	 * requiring that lost a race every time an entry landed between the request
	 * and the offer, and refused a snapshot that was perfectly good.
	 *
	 * So a position is refused for exactly two reasons: it runs past the end of
	 * the log, which means it stands for entries nobody has written; or it is at
	 * or behind the snapshot already held, which would move history backwards.
	 */
	SnapshotRefused: ({
		offered,
		head,
		current,
	}: {
		offered: number;
		head: number;
		current: number;
	}) => ({
		message: `A snapshot at ${offered} is not usable: the log ends at ${head} and the snapshot already covers ${current}`,
		offered,
		head,
		current,
	}),
});
export type AuthorityError = InferErrors<typeof AuthorityError>;

/** One entry of the log, reassembled from however many chunks held it. */
export type LogEntry = { seq: number; bytes: Uint8Array };

/** The state everything after it is relative to. */
export type Snapshot = { position: number; bytes: Uint8Array };

export type SyncAuthority = {
	/**
	 * Give one whole update a position and store it, unread.
	 *
	 * The position is assigned here and returned, so nothing anywhere else has
	 * to guess it or agree about it in advance.
	 */
	append(update: Uint8Array): Result<number, AuthorityError>;
	/** Up to `limit` entries after `cursor`, oldest first. */
	since(cursor: number, limit?: number): Result<LogEntry[], AuthorityError>;
	/** The newest position, or zero for a log nothing has been written to. */
	head(): Result<number, AuthorityError>;
	/** The current snapshot, or undefined for a log nothing has replaced yet. */
	snapshot(): Result<Snapshot | undefined, AuthorityError>;
	/** The position the current snapshot was taken at. Zero when there is none. */
	snapshotPosition(): Result<number, AuthorityError>;
	/**
	 * Replace the snapshot and forget everything it covers.
	 *
	 * Accepted when the position lies inside the log and ahead of the snapshot
	 * already held. The caller owes the other half of the condition, which it
	 * alone can check: that this is a connection the authority has actually SENT
	 * everything through that position. Its own record of what it sent is not a
	 * claim the replica makes, which is the difference between this and the
	 * client-posted baseline that an earlier design died on.
	 */
	replaceSnapshot(
		position: number,
		bytes: Uint8Array,
	): Result<void, AuthorityError>;
	/**
	 * Whether the tail has outgrown the snapshot, and is worth replacing at all.
	 *
	 * Snapshotting often keeps storage small and makes every returning replica
	 * re-download the whole state; snapshotting rarely does the reverse.
	 * Triggering when the tail passes the snapshot is the balance point and
	 * bounds both at about twice the state.
	 *
	 * The floor is the honest asterisk on "no number to pick". The ratio is
	 * scale-free, so on a tiny document it fires on the very next update; a live
	 * run snapshotted on nearly every message and stalled. Below the floor there
	 * is nothing worth replacing.
	 */
	shouldSnapshot(): Result<boolean, AuthorityError>;
	/** Total stored bytes, snapshot and tail together. */
	storedBytes(): Result<number, AuthorityError>;
	/**
	 * Bring this log into being from one whole database state (ADR-0293).
	 *
	 * What an import writes, and the only write that is not a replica's. The
	 * state is stored as the log's first snapshot, so a device that bootstraps
	 * later is handed exactly these bytes at exactly the position they are
	 * current through, and the socket carries only what happened afterwards.
	 *
	 * Position 1 rather than 0, and the reason is that 0 already means "no
	 * snapshot": one transaction stores every chunk directly at position 1.
	 * The next append follows it at position 2.
	 *
	 * **Once, on an empty log.** A generation is created once and never mutated
	 * in place, so a second seed is a caller confusing import with sync and is
	 * refused rather than merged. Returns the position the state is current
	 * through.
	 */
	seed(bytes: Uint8Array): Result<number, AuthorityError>;
};

export function applyAuthoritySchema(sqlite: SqliteDatabase): void {
	// `(seq, chunk)` and nothing else. There is no `taken_at`, no client id, no
	// state vector and no baseline flag, because every one of those would be a
	// fact about the bytes and the authority holds none.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _log (
			seq   INTEGER NOT NULL,
			chunk INTEGER NOT NULL,
			bytes BLOB    NOT NULL,
			PRIMARY KEY (seq, chunk)
		)
	`);
	// Chunked for the same reason the log is: a snapshot is the largest single
	// value the authority ever stores, and it is the one guaranteed to exceed
	// the cap on any real vault.
	//
	// More than one position is kept on purpose. A snapshot replaces history, so
	// unlike a bad log entry it cannot be repaired by neutralising one row; the
	// previous one is the only way back from a replica that produced a bad one.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS _snapshot (
			position INTEGER NOT NULL,
			chunk    INTEGER NOT NULL,
			bytes    BLOB    NOT NULL,
			PRIMARY KEY (position, chunk)
		)
	`);
}

/** How many snapshots are kept: the live one, and one to fall back to. */
const SNAPSHOTS_KEPT = 2;

/**
 * The tail has to be worth replacing before a snapshot is asked for.
 *
 * The one tuned number in the policy, and it exists because "the tail outgrew
 * the snapshot" is scale-free and therefore true almost immediately when
 * everything is tiny. A document of one note has a snapshot of a few hundred
 * bytes, so the very next update outgrows it, and a live run against Cloudflare
 * snapshotted on nearly every message and ground to a halt around the two
 * hundredth. Below this floor the whole log is trivial and replacing it buys
 * nothing.
 */
const SNAPSHOT_FLOOR_BYTES = 64 * 1024;

export function openSyncAuthority({
	sqlite,
	/** Injected so a test can reach the snapshot path without a real vault. */
	snapshotFloorBytes = SNAPSHOT_FLOOR_BYTES,
}: {
	sqlite: SqliteDatabase;
	snapshotFloorBytes?: number;
}): SyncAuthority {
	applyAuthoritySchema(sqlite);

	function read<TValue>(run: () => TValue): Result<TValue, AuthorityError> {
		return trySync({
			try: run,
			catch: (cause) => AuthorityError.StorageFailed({ cause }),
		});
	}

	/**
	 * The newest position, whether it is an entry or the snapshot.
	 *
	 * Both, because a snapshot DELETES the entries it covers, so the log alone
	 * would report a head of zero straight after one and the next append would
	 * reuse positions the replicas have already read.
	 */
	function headSeq(): number {
		const newestEntry =
			sqlite.all<SqliteRow & { seq: number }>(
				'SELECT COALESCE(MAX(seq), 0) AS seq FROM _log',
			)[0]?.seq ?? 0;
		return Math.max(newestEntry, snapshotPositionOf());
	}

	return Object.freeze({
		append(update: Uint8Array): Result<number, AuthorityError> {
			return read(() =>
				sqlite.transaction(() => {
					const seq = headSeq() + 1;
					// Chunking happens at the storage boundary rather than on the wire's
					// terms, so a client that framed its message differently, or an
					// authority whose cap moves, cannot make the stored form wrong.
					const chunks = intoChunks(update, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						sqlite.run(
							'INSERT INTO _log (seq, chunk, bytes) VALUES (?, ?, ?)',
							[seq, index, new Uint8Array(chunk)],
						);
					}
					return seq;
				}),
			);
		},

		since(cursor: number, limit = 64): Result<LogEntry[], AuthorityError> {
			return read(() => {
				// The positions first, so `limit` bounds ENTRIES rather than rows. A
				// limit on rows would return a fraction of a chunked entry and the
				// caller would have no way to know it had been cut.
				const positions = sqlite.all<SqliteRow & { seq: number }>(
					'SELECT DISTINCT seq FROM _log WHERE seq > ? ORDER BY seq LIMIT ?',
					[cursor, limit],
				);
				const newest = positions.at(-1)?.seq;
				if (newest === undefined) return [];

				const rows = sqlite.all<
					SqliteRow & {
						seq: number;
						chunk: number;
						bytes: Uint8Array | ArrayBuffer;
					}
				>(
					'SELECT seq, chunk, bytes FROM _log WHERE seq > ? AND seq <= ? ORDER BY seq, chunk',
					[cursor, newest],
				);
				const entries: LogEntry[] = [];
				let holding: { seq: number; chunks: Uint8Array[] } | undefined;
				for (const row of rows) {
					if (holding === undefined || holding.seq !== row.seq) {
						if (holding !== undefined) entries.push(flush(holding));
						holding = { seq: row.seq, chunks: [] };
					}
					holding.chunks.push(copyBytes(row.bytes));
				}
				if (holding !== undefined) entries.push(flush(holding));
				return entries;
			});

			function flush(held: { seq: number; chunks: Uint8Array[] }): LogEntry {
				let total = 0;
				for (const chunk of held.chunks) total += chunk.length;
				const bytes = new Uint8Array(total);
				let at = 0;
				for (const chunk of held.chunks) {
					bytes.set(chunk, at);
					at += chunk.length;
				}
				return { seq: held.seq, bytes };
			}
		},

		head: () => read(headSeq),

		snapshotPosition: () => read(snapshotPositionOf),

		snapshot(): Result<Snapshot | undefined, AuthorityError> {
			return read(() => {
				const position = snapshotPositionOf();
				if (position === 0) return undefined;
				const rows = sqlite.all<
					SqliteRow & { bytes: Uint8Array | ArrayBuffer }
				>('SELECT bytes FROM _snapshot WHERE position = ? ORDER BY chunk', [
					position,
				]);
				return {
					position,
					bytes: join(rows.map((row) => copyBytes(row.bytes))),
				};
			});
		},

		seed(bytes: Uint8Array): Result<number, AuthorityError> {
			const { data: head, error } = read(headSeq);
			if (error !== null) return Err(error);
			if (head !== 0) {
				// Not empty, so this is not a birth. `head` is nonzero for a log
				// with entries and for one whose entries a snapshot replaced, which
				// is exactly the pair of states a second seed must not overwrite.
				return AuthorityError.SnapshotRefused({
					offered: 1,
					head,
					current: head,
				});
			}
			// Birth needs only the snapshot. Writing a temporary log entry first
			// split one durable fact across two commits and made a failed seed
			// impossible to retry. Every chunk commits in this one transaction.
			return read(() =>
				sqlite.transaction(() => {
					for (const [index, chunk] of intoChunks(
						bytes,
						CHUNK_BYTES,
					).entries()) {
						sqlite.run(
							'INSERT INTO _snapshot (position, chunk, bytes) VALUES (?, ?, ?)',
							[1, index, new Uint8Array(chunk)],
						);
					}
					return 1;
				}),
			);
		},

		replaceSnapshot(position, bytes): Result<void, AuthorityError> {
			const { data: head, error } = read(headSeq);
			if (error !== null) return Err(error);
			const { data: current, error: currentError } = read(snapshotPositionOf);
			if (currentError !== null) return Err(currentError);
			// Coverage, not currency. The snapshot is about to stand for every
			// entry at or before `position`, so it must not run past what exists,
			// and it must not walk history backwards.
			if (position > head || position <= current) {
				return AuthorityError.SnapshotRefused({
					offered: position,
					head,
					current,
				});
			}
			return read(() =>
				sqlite.transaction(() => {
					const chunks = intoChunks(bytes, CHUNK_BYTES);
					for (const [index, chunk] of chunks.entries()) {
						sqlite.run(
							'INSERT OR REPLACE INTO _snapshot (position, chunk, bytes) VALUES (?, ?, ?)',
							[position, index, new Uint8Array(chunk)],
						);
					}
					// Everything the snapshot covers is forgotten. This is the line
					// that makes storage constant instead of growing, and it is also
					// what makes a deletion real: a snapshot is current state, so it
					// carries no trace of what was deleted before it.
					sqlite.run('DELETE FROM _log WHERE seq <= ?', [position]);
					const kept = sqlite
						.all<SqliteRow & { position: number }>(
							'SELECT DISTINCT position FROM _snapshot ORDER BY position DESC LIMIT ?',
							[SNAPSHOTS_KEPT],
						)
						.map((row) => row.position);
					const oldest = kept.at(-1);
					if (oldest !== undefined) {
						sqlite.run('DELETE FROM _snapshot WHERE position < ?', [oldest]);
					}
				}),
			);
		},

		shouldSnapshot(): Result<boolean, AuthorityError> {
			return read(() => {
				const tail = sumBytes('_log');
				if (tail < snapshotFloorBytes) return false;
				return tail > sumBytes('_snapshot');
			});
		},

		/**
		 * The one number to instrument.
		 *
		 * Automatic snapshot folding remains the maintenance path. This number is
		 * instrumentation for deciding whether a future explicit Compact store
		 * action has earned its place; the authority does not trigger that action.
		 */
		storedBytes: () => read(() => sumBytes('_log') + sumBytes('_snapshot')),
	});

	function sumBytes(relation: '_log' | '_snapshot'): number {
		return (
			sqlite.all<SqliteRow & { bytes: number }>(
				`SELECT COALESCE(SUM(length(bytes)), 0) AS bytes FROM ${relation}`,
			)[0]?.bytes ?? 0
		);
	}

	function snapshotPositionOf(): number {
		return (
			sqlite.all<SqliteRow & { position: number }>(
				'SELECT COALESCE(MAX(position), 0) AS position FROM _snapshot',
			)[0]?.position ?? 0
		);
	}
}

/** Concatenate chunks back into the value they were cut from. */
function join(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}
