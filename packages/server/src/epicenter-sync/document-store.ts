import type { RowAddress } from '@epicenter/data/protocol';
import {
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/document-sync';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

/**
 * The per-principal storage ceiling, in bytes.
 *
 * It moved here when the combined-exchange authority was deleted. The scalar V1
 * authority has no storage refusal of its own, so this relation is the only
 * remaining owner of the ceiling, and the constant belongs beside the one
 * operation that still enforces it.
 */
export const AUTHORITY_STORAGE_BYTE_CEILING = 10 * 1024 ** 3 - 64 * 1024 ** 2;

type StoredUpdate = SqliteRow & {
	update_sequence: number;
	update_bytes: Uint8Array | ArrayBuffer;
};

const hydrationOrigin = Symbol('epicenter-document-authority-hydration');
const COMPACTION_THRESHOLD = 64;

/**
 * The one authority acceptance outcome for a document candidate. `accepted`
 * means the bounded representation committed; `not-live` reports the row's
 * terminal absence; `too-large` is the terminal bound refusal; and
 * `invalid-update` means the candidate bytes are not a Yjs update the
 * authority can join. A refusal never mutates committed authority state, and
 * storage failure is thrown as an operational error rather than encoded as a
 * refusal (ADR-0174).
 */
export type DocumentAppendOutcome =
	| { outcome: 'accepted' }
	| { outcome: 'not-live' }
	| { outcome: 'too-large' }
	| { outcome: 'invalid-update' };

/**
 * One pull read of authority-accepted document state. `version` is an opaque
 * per-address acceptance counter: it advances with every accepted append, so
 * an unchanged version proves an unchanged document without hydrating it.
 * `state` is undefined while the row has never persisted document state.
 */
export type DocumentReadOutcome =
	| { kind: 'not-live' }
	| { kind: 'unchanged'; version: number }
	| { kind: 'state'; version: number; state: Uint8Array | undefined };

/** Open the disposable document persistence seam over one authority database. */
export function createEpicenterDocumentStore(
	database: SqliteDatabase,
	{
		readDatabaseSize,
	}: {
		/**
		 * When provided, document acceptance refuses to grow an authority past
		 * the same storage ceiling the scalar exchange enforces. The refusal is
		 * an operational error (thrown), never a deterministic outcome: clients
		 * keep the work durable and retry after the operator intervenes.
		 */
		readDatabaseSize?: () => number;
	} = {},
) {
	function isRowLive(address: RowAddress): boolean {
		return (
			database.all<SqliteRow>(
				`SELECT 1 AS live FROM main._authority_row_facts
				 WHERE namespace = ? AND table_name = ? AND row_id = ?
				   AND presence = 'present' LIMIT 1`,
				[address.namespace, address.tableName, address.rowId],
			).length === 1
		);
	}

	function readUpdates(address: RowAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT update_sequence, update_bytes FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ? ORDER BY update_sequence`,
			[address.namespace, address.tableName, address.rowId],
		);
	}

	function readVersion(address: RowAddress): number {
		return (
			database.all<SqliteRow & { version: number }>(
				`SELECT version FROM document_versions
				 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[address.namespace, address.tableName, address.rowId],
			)[0]?.version ?? 0
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
		/**
		 * The one authority acceptance operation: recheck row liveness, join
		 * the candidate through a trusted Yjs hydration, enforce the canonical
		 * post-candidate bounds, commit the bounded representation, and advance
		 * the acceptance version, all in one transaction (ADR-0174). Repeated
		 * submission of the same semantic state is idempotent for the document
		 * while still advancing the version counter.
		 */
		appendIfLive(
			address: RowAddress,
			update: Uint8Array,
		): DocumentAppendOutcome {
			if (
				readDatabaseSize !== undefined &&
				readDatabaseSize() >= AUTHORITY_STORAGE_BYTE_CEILING
			) {
				throw new Error('Epicenter authority storage is at its ceiling');
			}
			return database.transaction((): DocumentAppendOutcome => {
				if (!isRowLive(address)) return { outcome: 'not-live' };
				const document = hydrate(readUpdates(address));
				try {
					try {
						Y.applyUpdateV2(document, update, hydrationOrigin);
					} catch {
						// The narrowest try this transaction can hold: it covers the
						// untrusted candidate and nothing else, so hydration of
						// committed history and every storage write stay operational
						// errors that throw. Yjs is the validator here, so anything
						// it rejects is treated as bad input.
						return { outcome: 'invalid-update' };
					}
					const encoded = new Uint8Array(Y.encodeStateAsUpdateV2(document));
					if (exceedsDocumentBound(measureDocumentState(encoded))) {
						return { outcome: 'too-large' };
					}
					const nextSequence =
						database.all<SqliteRow & { sequence: number }>(
							`SELECT COALESCE(MAX(update_sequence), 0) + 1 AS sequence
							 FROM document_updates
							 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
							[address.namespace, address.tableName, address.rowId],
						)[0]?.sequence ?? 1;
					if (nextSequence >= COMPACTION_THRESHOLD) {
						// Bounded baseline-plus-tail law (ADR-0146/0174): the covered
						// chain atomically becomes one compact baseline that already
						// includes the accepted candidate.
						database.run(
							'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
							[address.namespace, address.tableName, address.rowId],
						);
						database.run(
							`INSERT INTO document_updates (
								namespace, table_name, row_id, update_sequence, update_bytes
							) VALUES (?, ?, ?, 1, ?)`,
							[address.namespace, address.tableName, address.rowId, encoded],
						);
					} else {
						database.run(
							`INSERT INTO document_updates (
								namespace, table_name, row_id, update_sequence, update_bytes
							) VALUES (?, ?, ?, ?, ?)`,
							[
								address.namespace,
								address.tableName,
								address.rowId,
								nextSequence,
								new Uint8Array(update),
							],
						);
					}
					database.run(
						`INSERT INTO document_versions (
							namespace, table_name, row_id, version
						) VALUES (?, ?, ?, 1)
						ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
							version = version + 1`,
						[address.namespace, address.tableName, address.rowId],
					);
					return { outcome: 'accepted' };
				} finally {
					document.destroy();
				}
			});
		},
		/**
		 * Read accepted document state for one explicit pull. When the caller's
		 * version still matches, the answer proves nothing changed without
		 * hydrating or transferring the document body.
		 */
		read(
			address: RowAddress,
			sinceVersion: number | undefined,
		): DocumentReadOutcome {
			return database.transaction((): DocumentReadOutcome => {
				if (!isRowLive(address)) return { kind: 'not-live' };
				const version = readVersion(address);
				if (sinceVersion !== undefined && sinceVersion === version) {
					return { kind: 'unchanged', version };
				}
				const updates = readUpdates(address);
				if (updates.length === 0) {
					return { kind: 'state', version, state: undefined };
				}
				const document = hydrate(updates);
				try {
					return {
						kind: 'state',
						version,
						state: new Uint8Array(Y.encodeStateAsUpdateV2(document)),
					};
				} finally {
					document.destroy();
				}
			});
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
