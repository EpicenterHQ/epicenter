import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { assertRowAddress, type RowAddress } from './persistence.js';

const LOG_TABLE = 'workspace_document_updates';
const DEFAULT_COMPACTION_THRESHOLD = 64;

/**
 * Error name stamped on an append refused because its row is no longer live.
 * The refusal is address-scoped: it fails that document's durability tail
 * without poisoning the log, and the name survives Worker and HTTP carriers.
 */
export const DOCUMENT_ROW_ABSENT_ERROR_NAME = 'DocumentRowAbsentError';

/** True when an error means one append lost its race with row deletion. */
export function isDocumentRowAbsentError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.name === DOCUMENT_ROW_ABSENT_ERROR_NAME
	);
}

type StoredUpdate = {
	sequence: number;
	update: Uint8Array | ArrayBuffer;
};

function asError(cause: unknown, fallback: string): Error {
	return cause instanceof Error ? cause : new Error(fallback, { cause });
}

function updateBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/**
 * Own one workspace's durable Yjs 14 update log inside its SQLite store.
 *
 * This is the owner side of row-document persistence: it runs where the
 * workspace's SQLite file lives (records Worker, Bun host, or in-process
 * runtime) and owns schema, append admission, liveness enforcement,
 * compaction, capture, and durable deletion. Live `Y.Doc` objects never live
 * here; renderer-facing code reaches this log through an asynchronous
 * load/append seam.
 */
export function createSqliteDocumentLog({
	database,
	isRowLive,
	compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
}: {
	database: SqliteDatabase;
	/**
	 * Row liveness read inside every append transaction. Returning false
	 * refuses the append with the named address-scoped absence error, so a
	 * late append can never resurrect a deleted row's durable content.
	 */
	isRowLive(address: RowAddress): boolean;
	compactionThreshold?: number;
}) {
	if (!Number.isSafeInteger(compactionThreshold) || compactionThreshold < 2) {
		throw new TypeError('Document compaction threshold must be at least two');
	}

	database.transaction(() => {
		database.run(
			`CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_bytes BLOB NOT NULL
			)`,
		);
		database.run(
			`CREATE INDEX IF NOT EXISTS workspace_document_updates_address
			 ON ${LOG_TABLE}(table_name, row_id, sequence)`,
		);
	});

	let failure: Error | undefined;

	function requireHealthy(): void {
		if (failure !== undefined) throw failure;
	}

	function poison(cause: unknown): Error {
		failure ??= asError(cause, 'Workspace document log failed');
		return failure;
	}

	function readUpdates(address: RowAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT sequence, update_bytes AS "update"
			 FROM ${LOG_TABLE}
			 WHERE table_name = ? AND row_id = ?
			 ORDER BY sequence`,
			[address.table, address.rowId],
		);
	}

	/** Replay stored updates into one fresh gc-enabled document. */
	function replay(updates: readonly StoredUpdate[]): Y.Doc {
		const document = new Y.Doc({ gc: true });
		try {
			for (const stored of updates) {
				Y.applyUpdateV2(document, updateBytes(stored.update));
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	return {
		/** Read one document's ordered durable updates for hydration. */
		load(address: RowAddress): Uint8Array[] {
			requireHealthy();
			assertRowAddress(address);
			try {
				return readUpdates(address).map((stored) =>
					updateBytes(stored.update),
				);
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Append one locally observed updateV2 and compact at the bounded
		 * threshold. Liveness, insertion, and compaction share one transaction:
		 * a row deleted concurrently refuses the append explicitly instead of
		 * committing durable state for a dead address.
		 */
		append(address: RowAddress, update: Uint8Array): void {
			requireHealthy();
			assertRowAddress(address);
			try {
				database.transaction(() => {
					if (!isRowLive({ table: address.table, rowId: address.rowId })) {
						const absent = new Error(
							`Cannot append document update for absent row '${address.table}.${address.rowId}'`,
						);
						absent.name = DOCUMENT_ROW_ABSENT_ERROR_NAME;
						throw absent;
					}
					database.run(
						`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
						 VALUES (?, ?, ?)`,
						[address.table, address.rowId, update],
					);
					const covered = readUpdates(address);
					if (covered.length < compactionThreshold) return;

					// Compact through a fresh gc-enabled document: merging update
					// blocks alone never garbage-collects, so only full replay plus
					// re-encoding shrinks replaced content back to a compact state.
					const lastCovered = covered.at(-1);
					if (lastCovered === undefined) {
						throw new Error('Document compaction read an empty covered set');
					}
					const compacted = replay(covered);
					try {
						const baseline = new Uint8Array(
							Y.encodeStateAsUpdateV2(compacted),
						);
						database.run(
							`DELETE FROM ${LOG_TABLE}
							 WHERE table_name = ? AND row_id = ? AND sequence <= ?`,
							[address.table, address.rowId, lastCovered.sequence],
						);
						database.run(
							`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
							 VALUES (?, ?, ?)`,
							[address.table, address.rowId, baseline],
						);
					} finally {
						compacted.destroy();
					}
				});
			} catch (cause) {
				if (isDocumentRowAbsentError(cause)) throw cause;
				throw poison(cause);
			}
		},
		/**
		 * Capture one row's compact document state, or undefined when the log
		 * holds nothing for its address. Callers own the durability barrier:
		 * capture reads whatever has committed when it runs.
		 */
		capture(address: RowAddress): Uint8Array | undefined {
			requireHealthy();
			assertRowAddress(address);
			try {
				const updates = readUpdates(address);
				if (updates.length === 0) return undefined;
				const captured = replay(updates);
				try {
					return new Uint8Array(Y.encodeStateAsUpdateV2(captured));
				} finally {
					captured.destroy();
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Delete the durable update logs of rows whose scalar life ended. Runs
		 * bare statements: the caller invokes this inside the same transaction
		 * that removes the row, so scalar death and document death commit
		 * together.
		 */
		deleteRows(addresses: readonly RowAddress[]): void {
			requireHealthy();
			try {
				for (const address of addresses) {
					assertRowAddress(address);
					database.run(
						`DELETE FROM ${LOG_TABLE}
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		/**
		 * Delete every durable update log. Runs one bare statement inside the
		 * caller's workspace-reset or workspace-delete transaction.
		 */
		deleteAllRows(): void {
			requireHealthy();
			try {
				database.run(`DELETE FROM ${LOG_TABLE}`);
			} catch (cause) {
				throw poison(cause);
			}
		},
	};
}

export type SqliteDocumentLog = ReturnType<typeof createSqliteDocumentLog>;
