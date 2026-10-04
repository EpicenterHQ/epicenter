import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result, trySync } from 'wellcrafted/result';

import {
	batchDigest,
	type Change,
	DATA_ADMISSION_LIMITS,
	type ExchangeRequest,
	type ExchangeResponse,
	encodedJsonBytes,
	foldChange,
	type JsonObject,
	type JsonValue,
	type LifetimeId,
	parseChange,
	parseExchangeResponse,
	parseMemberKey,
	parseNamespaceKey,
	parseReplicaId,
	parseRowId,
	type RowAddress,
	type ScalarAddress,
	type Record as SyncRecord,
	scalarAddressKey,
	scalarAddressOf,
	type ValueAddress,
} from '../protocol/index.js';
import { createReplicaSchema, REPLICA_FORMAT_VERSION } from './schema.js';

const mintRuntimeId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

export const ReplicaError = defineErrors({
	StorageFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Replica storage failed during ${operation}: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	UnsupportedFormat: ({ found }: { found: number | null }) => ({
		message: `Replica format ${found === null ? 'is incomplete' : found} is not supported`,
		found,
	}),
	WrongAttachment: ({
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}: {
		expectedDeploymentId: string;
		expectedPrincipalId: string;
		deploymentId: string;
		principalId: string;
	}) => ({
		message:
			'This replica is permanently attached to another deployment or principal',
		expectedDeploymentId,
		expectedPrincipalId,
		deploymentId,
		principalId,
	}),
	NotAttached: () => ({ message: 'Attach the replica before synchronizing' }),
	InvalidInput: ({ boundary }: { boundary: string }) => ({
		message: `Invalid replica ${boundary}`,
		boundary,
	}),
	RecordTooLarge: () => ({
		message: 'The merged latest-state record exceeds the record bound',
	}),
	InvalidExchange: ({ reason }: { reason: string }) => ({
		message: `Invalid exchange response: ${reason}`,
		reason,
	}),
	StorageLimit: () => ({ message: 'The authority storage limit was reached' }),
	CheckpointAhead: () => ({
		message:
			'This replica claims authority progress the active lifetime never issued; its local store is corrupt and needs manual repair',
	}),
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Replica exchange failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Replica change subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ReplicaError = InferErrors<typeof ReplicaError>;

type MetadataRow = SqliteRow & {
	format_version: number;
	replica_id: string;
	attached_deployment: string | null;
	attached_principal: string | null;
	authority_lifetime: string | null;
	last_applied_authority_sequence: number;
	last_batch_sequence: number;
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

type OutboxRow = SqliteRow & {
	local_sequence: number;
	address_kind: string;
	namespace_key: string;
	member_key: string;
	row_id: string;
	status: string;
	json_payload: string | null;
	parked_reason: string | null;
};

export type ReplicaMetadata = {
	formatVersion: number;
	replicaId: string;
	attachment: { deploymentId: string; principalId: string } | undefined;
	authorityLifetime: LifetimeId | null;
	lastAppliedAuthoritySequence: number;
	lastBatchSequence: number;
};

/** One refused local obligation, visibly parked at its address. */
export type ParkedObligation = {
	address: ScalarAddress;
	reason: 'record-bound';
};

export type Exchange = (
	request: ExchangeRequest,
) => ExchangeResponse | Promise<ExchangeResponse>;

export type OpenReplicaOptions = {
	database: SqliteDatabase;
	mintReplicaId?: () => string;
	log?: Logger;
};

export type ReplicaChange = ScalarAddress;

function storageResult<T>(
	operation: string,
	run: () => T,
): Result<T, ReplicaError> {
	return trySync({
		try: run,
		catch: (cause) => ReplicaError.StorageFailed({ operation, cause }),
	});
}

function readMetadata(database: SqliteDatabase): MetadataRow | undefined {
	return database.all<MetadataRow>(
		`SELECT format_version, replica_id, attached_deployment,
			attached_principal, authority_lifetime,
			last_applied_authority_sequence, last_batch_sequence
		FROM metadata WHERE singleton = 1`,
	)[0];
}

function toMetadata(row: MetadataRow): ReplicaMetadata {
	return {
		formatVersion: row.format_version,
		replicaId: row.replica_id,
		attachment:
			row.attached_deployment === null || row.attached_principal === null
				? undefined
				: {
						deploymentId: row.attached_deployment,
						principalId: row.attached_principal,
					},
		authorityLifetime: row.authority_lifetime,
		lastAppliedAuthoritySequence: row.last_applied_authority_sequence,
		lastBatchSequence: row.last_batch_sequence,
	};
}

function addressColumns(address: ScalarAddress): {
	kind: 'row' | 'value';
	namespace: string;
	member: string;
	rowId: string;
} {
	return address.kind === 'row'
		? {
				kind: 'row',
				namespace: address.namespace,
				member: address.table,
				rowId: address.rowId,
			}
		: {
				kind: 'value',
				namespace: address.namespace,
				member: address.value,
				rowId: '',
			};
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

function readStateRow(
	database: SqliteDatabase,
	address: ScalarAddress,
): StateRow | undefined {
	const columns = addressColumns(address);
	return database.all<StateRow>(
		`SELECT address_kind, namespace_key, member_key, row_id, status, json_payload, changed_sequence
		FROM state
		WHERE address_kind = ? AND namespace_key = ? AND member_key = ? AND row_id = ?`,
		[columns.kind, columns.namespace, columns.member, columns.rowId],
	)[0];
}

function readState(
	database: SqliteDatabase,
	change: Change,
): SyncRecord | undefined {
	const row = readStateRow(database, scalarAddressOf(change));
	return row === undefined ? undefined : stateRowToRecord(row);
}

function storeRecord(database: SqliteDatabase, record: SyncRecord): void {
	const columns = addressColumns(scalarAddressOf(record));
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
			columns.kind,
			columns.namespace,
			columns.member,
			columns.rowId,
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

function encodeOutboxChange(change: Change): {
	status: string;
	payload: string | null;
} {
	switch (change.kind) {
		case 'create':
		case 'update':
			return {
				status: 'live',
				payload: JSON.stringify({ kind: change.kind, fields: change.fields }),
			};
		case 'delete':
			return { status: 'deleted', payload: null };
		case 'set':
			return { status: 'live', payload: JSON.stringify(change.payload) };
		case 'unset':
			return { status: 'unset', payload: null };
		default:
			return change satisfies never;
	}
}

function outboxRowToChange(row: OutboxRow): Change {
	if (row.address_kind === 'row') {
		if (row.status === 'deleted') {
			return {
				kind: 'delete',
				namespace: row.namespace_key,
				table: row.member_key,
				rowId: row.row_id,
			};
		}
		const payload = JSON.parse(row.json_payload ?? 'null') as {
			kind: 'create' | 'update';
			fields: JsonObject | { set: JsonObject; unset: string[] };
		};
		return payload.kind === 'create'
			? {
					kind: 'create',
					namespace: row.namespace_key,
					table: row.member_key,
					rowId: row.row_id,
					fields: payload.fields as JsonObject,
				}
			: {
					kind: 'update',
					namespace: row.namespace_key,
					table: row.member_key,
					rowId: row.row_id,
					fields: payload.fields as { set: JsonObject; unset: string[] },
				};
	}
	return row.status === 'unset'
		? { kind: 'unset', namespace: row.namespace_key, value: row.member_key }
		: {
				kind: 'set',
				namespace: row.namespace_key,
				value: row.member_key,
				payload: JSON.parse(row.json_payload ?? 'null') as JsonValue,
			};
}

/**
 * Only unparked pending work suppresses an incoming authority record. Parked
 * obligations stay visible for diagnostics but never block authoritative
 * truth from installing.
 */
function hasPendingAddress(
	database: SqliteDatabase,
	record: SyncRecord,
): boolean {
	const columns = addressColumns(scalarAddressOf(record));
	return (
		database.all<SqliteRow>(
			`SELECT 1 AS pending FROM outbox
			WHERE parked_reason IS NULL
				AND address_kind = ? AND namespace_key = ? AND member_key = ? AND row_id = ?
			LIMIT 1`,
			[columns.kind, columns.namespace, columns.member, columns.rowId],
		).length > 0
	);
}

function installRecord(database: SqliteDatabase, record: SyncRecord): boolean {
	if (hasPendingAddress(database, record)) return false;
	const existing = readStateRow(database, scalarAddressOf(record));
	if (
		existing !== undefined &&
		existing.changed_sequence >= record.changedSequence
	)
		return false;
	storeRecord(database, record);
	return true;
}

function pendingOutboxRows(database: SqliteDatabase): OutboxRow[] {
	return database.all<OutboxRow>(
		`SELECT local_sequence, address_kind, namespace_key, member_key, row_id,
			status, json_payload, parked_reason
		FROM outbox WHERE parked_reason IS NULL
		ORDER BY local_sequence LIMIT ?`,
		[DATA_ADMISSION_LIMITS.changesPerBatch],
	);
}

function sealBatch(database: SqliteDatabase, metadata: MetadataRow) {
	const rows = pendingOutboxRows(database);
	if (rows.length === 0) return undefined;
	const seq = metadata.last_batch_sequence + 1;
	const selected: OutboxRow[] = [];
	const changes: Change[] = [];
	for (const row of rows) {
		if (changes.length === DATA_ADMISSION_LIMITS.changesPerBatch) break;
		const change = outboxRowToChange(row);
		const candidate = [...changes, change];
		if (
			encodedJsonBytes({ seq, digest: '0'.repeat(64), changes: candidate }) >
			DATA_ADMISSION_LIMITS.encodedBatchBytes
		) {
			break;
		}
		selected.push(row);
		changes.push(change);
	}
	if (changes.length === 0)
		throw new Error('One outbox change exceeds the batch admission limit');
	return {
		batch: { seq, digest: batchDigest(changes), changes },
		localSequences: selected.map((row) => row.local_sequence),
	};
}

function createReplica(
	database: SqliteDatabase,
	mintReplica: () => string,
	log: Logger,
) {
	let nextLocalSequence =
		(database.all<SqliteRow & { sequence: number }>(
			'SELECT COALESCE(MAX(local_sequence), 0) AS sequence FROM outbox',
		)[0]?.sequence ?? 0) + 1;
	const changeListeners = new Set<
		(changes: readonly ReplicaChange[]) => void
	>();
	const resetListeners = new Set<() => void>();
	const outboxListeners = new Set<() => void>();

	function notify(changes: readonly ReplicaChange[]): void {
		if (changes.length === 0) return;
		for (const listener of changeListeners) {
			try {
				listener(changes);
			} catch (cause) {
				log.error(ReplicaError.SubscriberThrew({ cause }));
			}
		}
	}

	function notifyReset(): void {
		for (const listener of resetListeners) {
			try {
				listener();
			} catch (cause) {
				log.error(ReplicaError.SubscriberThrew({ cause }));
			}
		}
	}

	function metadata(): Result<ReplicaMetadata, ReplicaError> {
		return storageResult('read metadata', () => {
			const row = readMetadata(database);
			if (row === undefined) throw new Error('metadata singleton is missing');
			return toMetadata(row);
		});
	}

	function attach({
		deploymentId,
		principalId,
	}: {
		deploymentId: string;
		principalId: string;
	}): Result<void, ReplicaError> {
		if (deploymentId.length === 0 || principalId.length === 0) {
			return ReplicaError.InvalidInput({ boundary: 'attachment' });
		}
		try {
			if (new URL(deploymentId).href !== deploymentId) {
				return ReplicaError.InvalidInput({
					boundary: 'canonical deployment URL',
				});
			}
		} catch {
			return ReplicaError.InvalidInput({
				boundary: 'canonical deployment URL',
			});
		}
		try {
			database.transaction(() => {
				const row = readMetadata(database);
				if (row === undefined) throw new Error('metadata singleton is missing');
				if (
					row.attached_deployment === null &&
					row.attached_principal === null
				) {
					database.run(
						'UPDATE metadata SET attached_deployment = ?, attached_principal = ? WHERE singleton = 1',
						[deploymentId, principalId],
					);
					return;
				}
				if (
					row.attached_deployment === deploymentId &&
					row.attached_principal === principalId
				)
					return;
				throw new AttachmentMismatch({
					expectedDeploymentId: row.attached_deployment ?? '',
					expectedPrincipalId: row.attached_principal ?? '',
					deploymentId,
					principalId,
				});
			});
			return Ok(undefined);
		} catch (cause) {
			if (cause instanceof AttachmentMismatch) {
				return ReplicaError.WrongAttachment(cause.attachment);
			}
			return ReplicaError.StorageFailed({ operation: 'attach', cause });
		}
	}

	function write(change: Change): Result<{ applied: boolean }, ReplicaError> {
		const { data: parsed, error } = parseChange(change);
		if (error !== null)
			return ReplicaError.InvalidInput({ boundary: 'change' });
		const result = storageResult('write', () =>
			database.transaction(() => {
				const current = readState(database, parsed);
				const folded = foldChange(current, parsed, 0);
				if (folded.kind === 'inadmissible') return { refused: true } as const;
				if (folded.kind === 'noop') return { applied: false } as const;
				storeRecord(database, folded.record);
				const columns = addressColumns(scalarAddressOf(parsed));
				// A newer accepted local write supersedes any parked obligation at
				// the same address, so parked work cannot accumulate forever.
				database.run(
					`DELETE FROM outbox WHERE parked_reason IS NOT NULL
					AND address_kind = ? AND namespace_key = ? AND member_key = ? AND row_id = ?`,
					[columns.kind, columns.namespace, columns.member, columns.rowId],
				);
				const encoded = encodeOutboxChange(parsed);
				database.run(
					`INSERT INTO outbox (
						local_sequence, address_kind, namespace_key, member_key, row_id,
						status, json_payload, parked_reason
					) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
					[
						nextLocalSequence,
						columns.kind,
						columns.namespace,
						columns.member,
						columns.rowId,
						encoded.status,
						encoded.payload,
					],
				);
				nextLocalSequence += 1;
				return { applied: true } as const;
			}),
		);
		if (result.error !== null) return result;
		if ('refused' in result.data) return ReplicaError.RecordTooLarge();
		if (result.data.applied) {
			notify([scalarAddressOf(parsed)]);
			for (const listener of outboxListeners) listener();
		}
		return Ok({ applied: result.data.applied });
	}

	function subscribe(
		listener: (changes: readonly ReplicaChange[]) => void,
	): () => void {
		changeListeners.add(listener);
		return () => changeListeners.delete(listener);
	}

	/**
	 * Fires after a lifetime replacement wiped every local scalar, outbox, and
	 * document byte. Everything previously observed may be gone; consumers
	 * requery instead of patching.
	 */
	function subscribeReset(listener: () => void): () => void {
		resetListeners.add(listener);
		return () => resetListeners.delete(listener);
	}

	function subscribeOutbox(listener: () => void): () => void {
		outboxListeners.add(listener);
		return () => outboxListeners.delete(listener);
	}

	function readRow(
		address: Omit<RowAddress, 'kind'>,
	): Result<JsonObject | undefined, ReplicaError> {
		if (
			parseNamespaceKey(address.namespace).error !== null ||
			parseMemberKey(address.table).error !== null ||
			parseRowId(address.rowId).error !== null
		) {
			return ReplicaError.InvalidInput({ boundary: 'row address' });
		}
		return storageResult('read row', () => {
			const row = readStateRow(database, { kind: 'row', ...address });
			if (row === undefined || row.status !== 'live') return undefined;
			const record = stateRowToRecord(row);
			return record.kind === 'row' ? structuredClone(record.fields) : undefined;
		});
	}

	function readValue(
		address: Omit<ValueAddress, 'kind'>,
	): Result<JsonValue | undefined, ReplicaError> {
		if (
			parseNamespaceKey(address.namespace).error !== null ||
			parseMemberKey(address.value).error !== null
		) {
			return ReplicaError.InvalidInput({ boundary: 'value address' });
		}
		return storageResult('read value', () => {
			const row = readStateRow(database, { kind: 'value', ...address });
			if (row === undefined || row.status !== 'live') return undefined;
			const record = stateRowToRecord(row);
			return record.kind === 'value'
				? structuredClone(record.payload)
				: undefined;
		});
	}

	function parked(): Result<ParkedObligation[], ReplicaError> {
		return storageResult('read parked obligations', () =>
			database
				.all<OutboxRow>(
					`SELECT local_sequence, address_kind, namespace_key, member_key,
						row_id, status, json_payload, parked_reason
					FROM outbox WHERE parked_reason IS NOT NULL ORDER BY local_sequence`,
				)
				.map((row) => ({
					address:
						row.address_kind === 'row'
							? ({
									kind: 'row',
									namespace: row.namespace_key,
									table: row.member_key,
									rowId: row.row_id,
								} as const)
							: ({
									kind: 'value',
									namespace: row.namespace_key,
									value: row.member_key,
								} as const),
					reason: 'record-bound' as const,
				})),
		);
	}

	/**
	 * Adopt a replacement authority lifetime: erase every old-lifetime scalar,
	 * obligation, and document byte, remint the replica identity, and restart
	 * acquisition from sequence zero. The principal attachment survives.
	 */
	function adoptLifetime(active: LifetimeId): Result<void, ReplicaError> {
		const result = storageResult('adopt authority lifetime', () =>
			database.transaction(() => {
				const replicaId = mintReplica();
				if (parseReplicaId(replicaId).error !== null)
					throw new Error('minted replica id is invalid');
				database.run('DELETE FROM state');
				database.run('DELETE FROM outbox');
				database.run('DELETE FROM document_updates');
				database.run(
					`UPDATE metadata SET replica_id = ?, authority_lifetime = ?,
						last_applied_authority_sequence = 0, last_batch_sequence = 0
					WHERE singleton = 1`,
					[replicaId, active],
				);
				nextLocalSequence = 1;
			}),
		);
		if (result.error !== null) return result;
		notifyReset();
		return Ok(undefined);
	}

	async function synchronize(
		exchange: Exchange,
	): Promise<Result<void, ReplicaError>> {
		let refusalRecoveries = 0;
		while (true) {
			let didRecover = false;
			const metadataResult = metadata();
			if (metadataResult.error !== null) return metadataResult;
			if (metadataResult.data.attachment === undefined)
				return ReplicaError.NotAttached();
			const replicaId = metadataResult.data.replicaId;
			const boundLifetime = metadataResult.data.authorityLifetime;

			const sealedResult = storageResult('seal batch', () => {
				const row = readMetadata(database);
				if (row === undefined) throw new Error('metadata singleton is missing');
				return sealBatch(database, row);
			});
			if (sealedResult.error !== null) return sealedResult;
			const sealed = sealedResult.data;

			let after = metadataResult.data.lastAppliedAuthoritySequence;
			let through: number | undefined;
			let isFirstPage = true;

			while (true) {
				const batch = isFirstPage ? sealed?.batch : undefined;
				const request: ExchangeRequest = {
					replicaId,
					lifetimeId: boundLifetime,
					after,
					...(through === undefined ? {} : { through }),
					...(batch === undefined ? {} : { batch }),
				};
				let rawResponse: ExchangeResponse;
				try {
					rawResponse = await exchange(request);
				} catch (cause) {
					return ReplicaError.TransportFailed({ cause });
				}
				const { data: response, error: responseError } =
					parseExchangeResponse(rawResponse);
				if (responseError !== null)
					return ReplicaError.InvalidExchange({
						reason: responseError.message,
					});

				if ('refusal' in response) {
					switch (response.refusal) {
						case 'storage-limit':
							return ReplicaError.StorageLimit();
						case 'checkpoint-ahead':
							return ReplicaError.CheckpointAhead();
						case 'lifetime-mismatch': {
							refusalRecoveries += 1;
							if (refusalRecoveries > 8)
								return ReplicaError.InvalidExchange({
									reason: 'repeated lifetime mismatches',
								});
							const adopted = adoptLifetime(response.lifetimeId);
							if (adopted.error !== null) return adopted;
							didRecover = true;
							break;
						}
						case 'batch-conflict': {
							refusalRecoveries += 1;
							if (refusalRecoveries > 8)
								return ReplicaError.InvalidExchange({
									reason: 'repeated batch conflicts',
								});
							// A fork means another physical copy of this replica already
							// spent this batch sequence. Recovery is local: mint a fresh
							// replica identity and resubmit pending work as new batches.
							const recovery = storageResult('recover replica fork', () =>
								database.transaction(() => {
									const minted = mintReplica();
									if (parseReplicaId(minted).error !== null)
										throw new Error('minted replica id is invalid');
									database.run(
										'UPDATE metadata SET replica_id = ?, last_batch_sequence = 0 WHERE singleton = 1',
										[minted],
									);
								}),
							);
							if (recovery.error !== null) return recovery;
							didRecover = true;
							break;
						}
						case 'change-inadmissible': {
							if (
								batch === undefined ||
								sealed === undefined ||
								response.seq !== batch.seq ||
								response.digest !== batch.digest ||
								response.changeIndex >= sealed.localSequences.length
							) {
								return ReplicaError.InvalidExchange({
									reason:
										'inadmissibility refusal does not identify the sealed batch',
								});
							}
							const parkedSequence =
								sealed.localSequences[response.changeIndex];
							const parkedResult = storageResult('park refused change', () =>
								database.transaction(() => {
									database.run(
										'UPDATE outbox SET parked_reason = ? WHERE local_sequence = ?',
										[response.reason, parkedSequence ?? -1],
									);
								}),
							);
							if (parkedResult.error !== null) return parkedResult;
							didRecover = true;
							break;
						}
						default:
							response satisfies never;
					}
					break;
				}

				if (boundLifetime !== null && response.lifetimeId !== boundLifetime) {
					return ReplicaError.InvalidExchange({
						reason: 'success carried a different authority lifetime',
					});
				}
				if (through !== undefined && response.through !== through) {
					return ReplicaError.InvalidExchange({
						reason: 'continuation changed the fixed through bound',
					});
				}
				if (response.through < after) {
					return ReplicaError.InvalidExchange({
						reason: 'authority regressed below the durable watermark',
					});
				}
				if (
					response.records.some((record) => record.changedSequence <= after)
				) {
					return ReplicaError.InvalidExchange({
						reason: 'page did not advance from the durable watermark',
					});
				}
				if (batch !== undefined) {
					if (
						response.receipt?.seq !== batch.seq ||
						response.receipt.digest !== batch.digest
					) {
						return ReplicaError.InvalidExchange({
							reason: 'batch receipt does not match the sealed batch',
						});
					}
				} else if (response.receipt !== undefined) {
					return ReplicaError.InvalidExchange({
						reason: 'unexpected batch receipt',
					});
				}

				const nextAfter = response.more
					? (response.records.at(-1)?.changedSequence ?? response.through)
					: response.through;
				const installed = storageResult('install exchange page', () =>
					database.transaction(() => {
						const changes = new Map<string, ReplicaChange>();
						if (batch !== undefined && sealed !== undefined) {
							for (const localSequence of sealed.localSequences) {
								database.run('DELETE FROM outbox WHERE local_sequence = ?', [
									localSequence,
								]);
							}
							database.run(
								'UPDATE metadata SET last_batch_sequence = ? WHERE singleton = 1',
								[batch.seq],
							);
						}
						for (const record of response.records) {
							if (!installRecord(database, record)) continue;
							const address = scalarAddressOf(record);
							changes.set(scalarAddressKey(address), address);
						}
						database.run(
							`UPDATE metadata SET last_applied_authority_sequence = ?${
								boundLifetime === null ? ', authority_lifetime = ?' : ''
							} WHERE singleton = 1`,
							boundLifetime === null
								? [nextAfter, response.lifetimeId]
								: [nextAfter],
						);
						return [...changes.values()];
					}),
				);
				if (installed.error !== null) return installed;
				notify(installed.data);

				after = nextAfter;
				isFirstPage = false;
				if (response.more) {
					through = response.through;
					continue;
				}
				break;
			}

			if (didRecover) continue;
			const pending = storageResult(
				'check pending outbox',
				() => pendingOutboxRows(database)[0],
			);
			if (pending.error !== null) return pending;
			if (pending.data === undefined) return Ok(undefined);
		}
	}

	return {
		metadata,
		attach,
		write,
		readRow,
		readValue,
		parked,
		subscribe,
		subscribeReset,
		subscribeOutbox,
		synchronize,
	};
}

export type Replica = ReturnType<typeof createReplica>;

class AttachmentMismatch extends Error {
	constructor(
		readonly attachment: {
			expectedDeploymentId: string;
			expectedPrincipalId: string;
			deploymentId: string;
			principalId: string;
		},
	) {
		super('attachment mismatch');
	}
}

export function openReplica({
	database,
	mintReplicaId = mintRuntimeId,
	log = createLogger('data/replica'),
}: OpenReplicaOptions): Result<Replica, ReplicaError> {
	try {
		const tables = database.all<SqliteRow & { name: string }>(
			`SELECT name FROM sqlite_schema
			WHERE type = 'table' AND name IN ('metadata', 'state', 'outbox', 'document_updates')`,
		);
		if (tables.length === 0) {
			const replicaId = mintReplicaId();
			if (parseReplicaId(replicaId).error !== null)
				return ReplicaError.InvalidInput({ boundary: 'minted replica id' });
			database.transaction(() => createReplicaSchema(database, replicaId));
		} else if (!tables.some((table) => table.name === 'metadata')) {
			return ReplicaError.UnsupportedFormat({ found: null });
		}
		const row = trySync({
			try: () => readMetadata(database),
			catch: () => ReplicaError.UnsupportedFormat({ found: null }),
		});
		if (row.error !== null) return row;
		if (row.data === undefined)
			return ReplicaError.UnsupportedFormat({ found: null });
		if (row.data.format_version !== REPLICA_FORMAT_VERSION) {
			return ReplicaError.UnsupportedFormat({ found: row.data.format_version });
		}
		if (parseReplicaId(row.data.replica_id).error !== null)
			return ReplicaError.UnsupportedFormat({ found: row.data.format_version });
		return Ok(createReplica(database, mintReplicaId, log));
	} catch (cause) {
		if (cause instanceof AttachmentMismatch) {
			return ReplicaError.WrongAttachment(cause.attachment);
		}
		return ReplicaError.StorageFailed({ operation: 'open', cause });
	}
}
