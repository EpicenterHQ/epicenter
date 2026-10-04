import {
	batchDigest,
	type Change,
	DATA_ADMISSION_LIMITS,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	type JsonObject,
	type JsonValue,
	parseExchangeRequest,
	type Receipt,
	type Record as SyncRecord,
	scalarAddressKey,
	scalarAddressOf,
} from '@epicenter/data/protocol';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import {
	initializeAuthoritySchema,
	mintAuthorityLifetimeId,
} from './authority-schema.js';

export const AUTHORITY_STORAGE_BYTE_CEILING = 10 * 1024 ** 3 - 64 * 1024 ** 2;

type MetadataRow = SqliteRow & { lifetime_id: string; next_sequence: number };
type ReplicaRow = SqliteRow & {
	accepted_batch: number;
	request_digest: string;
};
type StateRow = SqliteRow & {
	address_kind: string;
	namespace_key: string;
	member_key: string;
	row_id: string;
	status: string;
	json_payload: string | null;
	changed_sequence: number;
};

export type EpicenterSyncAuthority = {
	exchange(request: unknown): ExchangeResponse;
};

export type OpenAuthorityOptions = {
	database: SqliteDatabase;
	pageSize?: number;
	readDatabaseSize?: () => number;
	mintLifetimeId?: () => string;
};

function readMetadata(database: SqliteDatabase): MetadataRow {
	const metadata = database.all<MetadataRow>(
		'SELECT lifetime_id, next_sequence FROM metadata WHERE singleton = 1',
	)[0];
	if (metadata === undefined) throw new Error('Authority metadata is missing');
	return metadata;
}

function readReplica(
	database: SqliteDatabase,
	replicaId: string,
): ReplicaRow | undefined {
	return database.all<ReplicaRow>(
		`SELECT accepted_batch, request_digest
		FROM replicas WHERE replica_id = ?`,
		[replicaId],
	)[0];
}

function stateRowToRecord(row: StateRow): SyncRecord {
	if (row.address_kind === 'row') {
		return row.status === 'deleted'
			? {
					kind: 'row-deleted',
					namespace: row.namespace_key,
					table: row.member_key,
					rowId: row.row_id,
					changedSequence: row.changed_sequence,
				}
			: {
					kind: 'row',
					namespace: row.namespace_key,
					table: row.member_key,
					rowId: row.row_id,
					changedSequence: row.changed_sequence,
					fields: JSON.parse(row.json_payload ?? 'null') as JsonObject,
				};
	}
	return row.status === 'unset'
		? {
				kind: 'value-unset',
				namespace: row.namespace_key,
				value: row.member_key,
				changedSequence: row.changed_sequence,
			}
		: {
				kind: 'value',
				namespace: row.namespace_key,
				value: row.member_key,
				changedSequence: row.changed_sequence,
				payload: JSON.parse(row.json_payload ?? 'null') as JsonValue,
			};
}

function addressColumns(value: SyncRecord | Change): {
	kind: string;
	namespace: string;
	member: string;
	rowId: string;
} {
	return 'rowId' in value
		? {
				kind: 'row',
				namespace: value.namespace,
				member: value.table,
				rowId: value.rowId,
			}
		: {
				kind: 'value',
				namespace: value.namespace,
				member: value.value,
				rowId: '',
			};
}

function readRecord(
	database: SqliteDatabase,
	change: Change,
): SyncRecord | undefined {
	const address = addressColumns(change);
	const row = database.all<StateRow>(
		`SELECT address_kind, namespace_key, member_key, row_id, status, json_payload, changed_sequence
		FROM state
		WHERE address_kind = ? AND namespace_key = ? AND member_key = ? AND row_id = ?`,
		[address.kind, address.namespace, address.member, address.rowId],
	)[0];
	return row === undefined ? undefined : stateRowToRecord(row);
}

function storeRecord(database: SqliteDatabase, record: SyncRecord): void {
	const address = addressColumns(record);
	const status =
		record.kind === 'row-deleted'
			? 'deleted'
			: record.kind === 'value-unset'
				? 'unset'
				: 'live';
	const payload =
		record.kind === 'row'
			? JSON.stringify(record.fields)
			: record.kind === 'value'
				? JSON.stringify(record.payload)
				: null;
	database.run(
		`INSERT INTO state (
			address_kind, namespace_key, member_key, row_id, status, json_payload, changed_sequence
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (address_kind, namespace_key, member_key, row_id) DO UPDATE SET
			status = excluded.status,
			json_payload = excluded.json_payload,
			changed_sequence = excluded.changed_sequence`,
		[
			address.kind,
			address.namespace,
			address.member,
			address.rowId,
			status,
			payload,
			record.changedSequence,
		],
	);
	if (record.kind === 'row-deleted') {
		database.run(
			`DELETE FROM document_updates
			WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
			[record.namespace, record.table, record.rowId],
		);
	}
}

/**
 * Fold one whole batch against a staged overlay without touching storage.
 * Either every change folds admissibly and the staged records commit as one
 * transaction, or the first inadmissible change refuses the entire envelope
 * before any mutation, so an exact retry recomputes the same answer.
 *
 * A benign noop whose address holds a current record touches that record with
 * a fresh changed sequence (at most once per address per batch), so ordinary
 * scanning re-delivers authority truth to the replica whose pending optimism
 * suppressed it.
 */
function stageBatch(
	database: SqliteDatabase,
	changes: readonly Change[],
	startSequence: number,
):
	| { staged: Map<string, SyncRecord>; nextSequence: number }
	| { refusedIndex: number; reason: 'record-bound' } {
	const staged = new Map<string, SyncRecord>();
	let nextSequence = startSequence;
	for (const [index, change] of changes.entries()) {
		const key = scalarAddressKey(scalarAddressOf(change));
		const current = staged.get(key) ?? readRecord(database, change);
		const folded = foldChange(current, change, nextSequence);
		switch (folded.kind) {
			case 'inadmissible':
				return { refusedIndex: index, reason: folded.reason };
			case 'applied':
				staged.set(key, folded.record);
				nextSequence += 1;
				break;
			case 'noop':
				if (folded.current !== undefined && !staged.has(key)) {
					staged.set(key, {
						...folded.current,
						changedSequence: nextSequence,
					});
					nextSequence += 1;
				}
				break;
			default:
				folded satisfies never;
		}
	}
	return { staged, nextSequence };
}

function readPage(
	database: SqliteDatabase,
	after: number,
	through: number,
	pageSize: number,
	base: { lifetimeId: string; receipt?: Receipt },
): { records: SyncRecord[]; more: boolean } {
	const available = database.all<StateRow>(
		`SELECT address_kind, namespace_key, member_key, row_id, status, json_payload, changed_sequence
		FROM state
		WHERE changed_sequence > ? AND changed_sequence <= ?
		ORDER BY changed_sequence
		LIMIT ?`,
		[after, through, pageSize + 1],
	);
	let records = available.slice(0, pageSize).map(stateRowToRecord);
	while (
		records.length > 1 &&
		encodedJsonBytes({ ...base, through, records, more: false }) >
			DATA_ADMISSION_LIMITS.encodedPageBytes
	) {
		records = records.slice(0, -1);
	}
	const lastSequence = records.at(-1)?.changedSequence ?? after;
	const more =
		available.length > records.length ||
		database.all<SqliteRow>(
			`SELECT 1 AS present FROM state
			WHERE changed_sequence > ? AND changed_sequence <= ? LIMIT 1`,
			[lastSequence, through],
		).length > 0;
	return { records, more };
}

/** Open one principal-owned scalar sync authority over caller-owned SQLite. */
export function openEpicenterSyncAuthority({
	database,
	pageSize = DATA_ADMISSION_LIMITS.recordsPerPage,
	readDatabaseSize,
	mintLifetimeId = mintAuthorityLifetimeId,
}: OpenAuthorityOptions): EpicenterSyncAuthority {
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > DATA_ADMISSION_LIMITS.recordsPerPage
	) {
		throw new RangeError('Authority page size is outside protocol limits');
	}
	initializeAuthoritySchema(database, mintLifetimeId);

	return {
		exchange(rawRequest): ExchangeResponse {
			return database.transaction(() => {
				const parsed = parseExchangeRequest(rawRequest);
				if (parsed.error !== null) throw new TypeError(parsed.error.message);
				const request = parsed.data;
				let metadata = readMetadata(database);
				const lifetimeId = metadata.lifetime_id;

				// A fresh replica sends null and binds the returned lifetime; a
				// bound replica must present the exact active lifetime. Mismatch is
				// an actionable refusal, never malformed input.
				if (request.lifetimeId !== null && request.lifetimeId !== lifetimeId) {
					return { refusal: 'lifetime-mismatch', lifetimeId };
				}

				// Same-lifetime progress beyond the authority head is a terminal
				// corruption diagnostic, distinct from lifetime replacement.
				const head = metadata.next_sequence - 1;
				if (
					request.after > head ||
					(request.through !== undefined && request.through > head)
				) {
					return { refusal: 'checkpoint-ahead', lifetimeId };
				}

				let receipt: Receipt | undefined;
				if (request.batch !== undefined) {
					if (request.batch.digest !== batchDigest(request.batch.changes)) {
						throw new TypeError('Batch digest does not match its changes');
					}
					const stored = readReplica(database, request.replicaId);
					const acceptedBatch = stored?.accepted_batch ?? 0;
					if (request.batch.seq === acceptedBatch) {
						if (
							stored === undefined ||
							stored.request_digest !== request.batch.digest
						) {
							return { refusal: 'batch-conflict', lifetimeId };
						}
						receipt = {
							seq: stored.accepted_batch,
							digest: stored.request_digest,
						};
					} else if (request.batch.seq !== acceptedBatch + 1) {
						return { refusal: 'batch-conflict', lifetimeId };
					} else {
						if (
							readDatabaseSize !== undefined &&
							readDatabaseSize() >= AUTHORITY_STORAGE_BYTE_CEILING
						) {
							return { refusal: 'storage-limit', lifetimeId };
						}
						const outcome = stageBatch(
							database,
							request.batch.changes,
							metadata.next_sequence,
						);
						if ('refusedIndex' in outcome) {
							return {
								refusal: 'change-inadmissible',
								lifetimeId,
								seq: request.batch.seq,
								digest: request.batch.digest,
								changeIndex: outcome.refusedIndex,
								reason: outcome.reason,
							};
						}
						for (const record of outcome.staged.values()) {
							storeRecord(database, record);
						}
						database.run(
							'UPDATE metadata SET next_sequence = ? WHERE singleton = 1',
							[outcome.nextSequence],
						);
						database.run(
							`INSERT INTO replicas (replica_id, accepted_batch, request_digest)
							VALUES (?, ?, ?)
							ON CONFLICT (replica_id) DO UPDATE SET
								accepted_batch = excluded.accepted_batch,
								request_digest = excluded.request_digest`,
							[request.replicaId, request.batch.seq, request.batch.digest],
						);
						receipt = { seq: request.batch.seq, digest: request.batch.digest };
						metadata = { ...metadata, next_sequence: outcome.nextSequence };
					}
				}

				const through = request.through ?? metadata.next_sequence - 1;
				return {
					lifetimeId,
					...(receipt === undefined ? {} : { receipt }),
					through,
					...readPage(database, request.after, through, pageSize, {
						lifetimeId,
						...(receipt === undefined ? {} : { receipt }),
					}),
				};
			});
		},
	};
}
