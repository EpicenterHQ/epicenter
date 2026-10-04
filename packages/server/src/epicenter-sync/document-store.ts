import {
	type DocumentAddress,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/document-sync';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

type StoredUpdate = SqliteRow & {
	update_sequence: number;
	update_bytes: Uint8Array | ArrayBuffer;
};

const hydrationOrigin = Symbol('epicenter-document-authority-hydration');

export type DocumentAppendResult =
	| 'appended'
	| 'not-live'
	| 'too-large'
	| 'invalid';

/** Open the disposable document persistence seam over one authority database. */
export function createEpicenterDocumentStore(database: SqliteDatabase) {
	function isRowLive({ namespace, table, rowId }: DocumentAddress): boolean {
		return (
			database.all<SqliteRow>(
				`SELECT 1 AS live FROM state
				 WHERE address_kind = 'row' AND namespace_key = ? AND member_key = ?
				   AND row_id = ?
				   AND status = 'live' LIMIT 1`,
				[namespace, table, rowId],
			).length === 1
		);
	}

	function readUpdates(address: DocumentAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT update_sequence, update_bytes FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?
			 ORDER BY update_sequence`,
			[address.namespace, address.table, address.rowId],
		);
	}

	function hydrate(updates: readonly StoredUpdate[]): Y.Doc {
		const document = new Y.Doc({ gc: true });
		try {
			for (const update of updates) {
				Y.applyUpdateV2(
					document,
					copyBytes(update.update_bytes),
					hydrationOrigin,
				);
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	return {
		/** Atomically recheck scalar liveness and load committed update bytes. */
		openIfLive(address: DocumentAddress): readonly Uint8Array[] | undefined {
			return database.transaction(() => {
				if (!isRowLive(address)) return undefined;
				return readUpdates(address).map((update) =>
					copyBytes(update.update_bytes),
				);
			});
		},
		/** Validate and append exact V2 bytes in the same transaction as liveness. */
		appendIfLive(
			address: DocumentAddress,
			update: Uint8Array,
		): DocumentAppendResult {
			try {
				return database.transaction(() => {
					if (!isRowLive(address)) return 'not-live';
					const document = hydrate(readUpdates(address));
					try {
						Y.applyUpdateV2(document, update, hydrationOrigin);
						const encoded = new Uint8Array(Y.encodeStateAsUpdateV2(document));
						if (exceedsDocumentBound(measureDocumentState(encoded))) {
							return 'too-large';
						}
						const nextSequence =
							database.all<SqliteRow & { sequence: number }>(
								`SELECT COALESCE(MAX(update_sequence), 0) + 1 AS sequence
								 FROM document_updates
								 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
								[address.namespace, address.table, address.rowId],
							)[0]?.sequence ?? 1;
						database.run(
							`INSERT INTO document_updates (
								namespace_key, table_key, row_id, update_sequence, update_bytes
							) VALUES (?, ?, ?, ?, ?)`,
							[
								address.namespace,
								address.table,
								address.rowId,
								nextSequence,
								new Uint8Array(update),
							],
						);
						return 'appended';
					} finally {
						document.destroy();
					}
				});
			} catch {
				return 'invalid';
			}
		},
	};
}

function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array
		? new Uint8Array(value)
		: new Uint8Array(value.slice(0));
}

export type EpicenterDocumentStore = ReturnType<
	typeof createEpicenterDocumentStore
>;
