import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import type {
	DocumentPersistenceLease,
	RowAddress,
} from './persistence.js';

const UPDATES_TABLE = 'workspace_document_updates';
const DEFAULT_COMPACTION_THRESHOLD = 64;

type StoredUpdate = {
	update: Uint8Array | ArrayBuffer;
};

type ActiveLease = DocumentPersistenceLease & {
	fail(cause: unknown): void;
};

function asError(cause: unknown, fallback: string): Error {
	return cause instanceof Error ? cause : new Error(fallback, { cause });
}

function validateAddress(address: RowAddress): void {
	if (
		typeof address.table !== 'string' ||
		address.table.length === 0 ||
		typeof address.rowId !== 'string' ||
		address.rowId.length === 0
	) {
		throw new TypeError('Document row address must contain a table and row id');
	}
}

function addressKey(address: RowAddress): string {
	validateAddress(address);
	return JSON.stringify([address.table, address.rowId]);
}

function updateBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

/**
 * Attach the Yjs 14 document-store contract to caller-owned native SQLite.
 *
 * SQLite owns durable update logs and synchronous transactions. The returned
 * promises preserve the runtime-independent lease API and fixed-cut semantics.
 */
export function createNativeSqliteDocumentStore({
	database,
	compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
}: {
	database: SqliteDatabase;
	compactionThreshold?: number;
}) {
	if (!Number.isSafeInteger(compactionThreshold) || compactionThreshold < 2) {
		throw new TypeError('Document compaction threshold must be at least two');
	}

	database.transaction(() => {
		database.run(
			`CREATE TABLE IF NOT EXISTS ${UPDATES_TABLE} (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				update_bytes BLOB NOT NULL
			)`,
		);
		database.run(
			`CREATE INDEX IF NOT EXISTS workspace_document_updates_address
			 ON ${UPDATES_TABLE}(table_name, row_id, sequence)`,
		);
	});

	const active = new Map<string, ActiveLease>();
	const hydrationOrigin = Object.freeze({ kind: 'sqlite-hydration' });
	let failure: Error | undefined;

	function requireHealthy(): void {
		if (failure !== undefined) throw failure;
	}

	function poison(cause: unknown): Error {
		failure ??= asError(cause, 'Native document store failed');
		for (const lease of [...active.values()]) lease.fail(failure);
		return failure;
	}

	function readUpdates(address: RowAddress): Uint8Array[] {
		requireHealthy();
		try {
			return database
				.all<StoredUpdate>(
					`SELECT update_bytes AS "update"
					 FROM ${UPDATES_TABLE}
					 WHERE table_name = ? AND row_id = ?
					 ORDER BY sequence`,
					[address.table, address.rowId],
				)
				.map((entry) => updateBytes(entry.update));
		} catch (cause) {
			throw poison(cause);
		}
	}

	function appendAndCompact(address: RowAddress, update: Uint8Array): void {
		requireHealthy();
		try {
			database.transaction(() => {
				database.run(
					`INSERT INTO ${UPDATES_TABLE}(
						table_name, row_id, update_bytes
					) VALUES (?, ?, ?)`,
					[address.table, address.rowId, update],
				);
				const count = database.all<{ count: number }>(
					`SELECT COUNT(*) AS count FROM ${UPDATES_TABLE}
					 WHERE table_name = ? AND row_id = ?`,
					[address.table, address.rowId],
				)[0]?.count;
				if (count === undefined) {
					throw new Error('Document update count query returned no row');
				}
				if (count < compactionThreshold) return;

				const compacted = new Y.Doc();
				try {
					for (const part of readUpdates(address)) {
						Y.applyUpdateV2(compacted, part);
					}
					const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
					database.run(
						`DELETE FROM ${UPDATES_TABLE}
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
					database.run(
						`INSERT INTO ${UPDATES_TABLE}(
							table_name, row_id, update_bytes
						) VALUES (?, ?, ?)`,
						[address.table, address.rowId, baseline],
					);
				} finally {
					compacted.destroy();
				}
			});
		} catch (cause) {
			throw poison(cause);
		}
	}

	function attach(
		address: RowAddress,
		document: Y.Doc,
	): DocumentPersistenceLease {
		requireHealthy();
		const key = addressKey(address);
		if (active.has(key)) {
			throw new Error('Document persistence is already attached for this row');
		}

		const stableAddress = { table: address.table, rowId: address.rowId };
		const hydration = Promise.withResolvers<void>();
		let durabilityTail = hydration.promise;
		let stopped = false;
		let disposePromise: Promise<void> | undefined;

		const handleUpdate = (update: Uint8Array<ArrayBuffer>, origin: unknown) => {
			if (stopped || origin === hydrationOrigin) return;
			const durableBytes = new Uint8Array(update);
			try {
				appendAndCompact(stableAddress, durableBytes);
				durabilityTail = Promise.resolve();
			} catch (cause) {
				const rejected = Promise.reject(poison(cause));
				void rejected.catch(() => undefined);
				durabilityTail = rejected;
			}
		};

		function stopWrites(): void {
			if (stopped) return;
			stopped = true;
			document.off('updateV2', handleUpdate);
		}

		const lease: ActiveLease = {
			whenLoaded: hydration.promise,
			whenDurable() {
				return durabilityTail;
			},
			dispose() {
				if (disposePromise !== undefined) return disposePromise;
				stopWrites();
				const cut = durabilityTail;
				disposePromise = cut.finally(() => {
					active.delete(key);
				});
				return disposePromise;
			},
			fail(cause) {
				stopWrites();
				const rejected = Promise.reject(cause);
				void rejected.catch(() => undefined);
				durabilityTail = rejected;
			},
		};

		active.set(key, lease);
		document.on('updateV2', handleUpdate);
		try {
			for (const update of readUpdates(stableAddress)) {
				Y.applyUpdateV2(document, update, hydrationOrigin);
			}
			if (!document.isLoaded) document.emit('load', [document]);
			hydration.resolve();
		} catch (cause) {
			const poisoned = poison(cause);
			hydration.reject(poisoned);
		}
		void hydration.promise.catch(() => undefined);
		return lease;
	}

	return {
		attach,
		async capture(address: RowAddress) {
			requireHealthy();
			validateAddress(address);
			const activeCut = active.get(addressKey(address))?.whenDurable();
			if (activeCut !== undefined) await activeCut;
			try {
				const updates = readUpdates(address);
				if (updates.length === 0) return undefined;
				const captured = new Y.Doc();
				try {
					for (const update of updates) Y.applyUpdateV2(captured, update);
					return new Uint8Array(Y.encodeStateAsUpdateV2(captured));
				} finally {
					captured.destroy();
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		async delete(address: RowAddress) {
			requireHealthy();
			const key = addressKey(address);
			if (active.has(key)) {
				throw new Error(
					'Cannot delete document storage while its lease is active',
				);
			}
			try {
				database.transaction(() => {
					database.run(
						`DELETE FROM ${UPDATES_TABLE}
						 WHERE table_name = ? AND row_id = ?`,
						[address.table, address.rowId],
					);
				});
			} catch (cause) {
				throw poison(cause);
			}
		},
		async deleteAll() {
			requireHealthy();
			if (active.size !== 0) {
				throw new Error(
					'Cannot delete document storage while leases are active',
				);
			}
			try {
				database.transaction(() => {
					database.run(`DELETE FROM ${UPDATES_TABLE}`);
				});
			} catch (cause) {
				throw poison(cause);
			}
		},
	};
}

export type NativeSqliteDocumentStore = ReturnType<
	typeof createNativeSqliteDocumentStore
>;
