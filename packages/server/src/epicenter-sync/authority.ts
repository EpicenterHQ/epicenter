import {
	type Address,
	batchDigest,
	type Cursor,
	DATA_ADMISSION_LIMITS,
	type ExchangeResponse,
	encodedJsonBytes,
	type Fact,
	foldIntent,
	type JsonObject,
	type JsonValue,
	parseExchangeRequest,
	type Receipt,
	type RowAddress,
	type ValueAddress,
} from '@epicenter/data/protocol';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import { initializeAuthoritySchema } from './authority-schema.js';

export const AUTHORITY_STORAGE_BYTE_CEILING = 10 * 1024 ** 3 - 64 * 1024 ** 2;

type MetadataRow = SqliteRow & { next_sequence: number };
type ReplicaRow = SqliteRow & {
	accepted_batch: number;
	request_digest: string | null;
	receipt_sequence: number;
};

/**
 * One row of the sequence-ordered union over both fact relations.
 *
 * `local_key` carries the table or value name, and `row_id` is NULL for a value
 * fact rather than an empty-string sentinel.
 */
type FactRow = SqliteRow & {
	fact_kind: string;
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: string;
	payload: string | null;
	authority_sequence: number;
};

function readMetadata(database: SqliteDatabase): MetadataRow {
	const metadata = database.all<MetadataRow>(
		'SELECT next_sequence FROM main._authority_metadata WHERE singleton = 1',
	)[0];
	if (metadata === undefined) throw new Error('Authority metadata is missing');
	return metadata;
}

function readReplica(
	database: SqliteDatabase,
	replicaId: string,
): ReplicaRow | undefined {
	return database.all<ReplicaRow>(
		`SELECT accepted_batch, request_digest, receipt_sequence
		FROM main._authority_replicas WHERE replica_id = ?`,
		[replicaId],
	)[0];
}

function receiptFrom(row: ReplicaRow): Receipt {
	if (row.request_digest === null || row.accepted_batch < 1) {
		throw new Error('Authority replica receipt is incomplete');
	}
	return {
		seq: row.accepted_batch,
		digest: row.request_digest,
		appliedThrough: row.receipt_sequence,
	};
}

function factRowToFact(row: FactRow): Fact {
	if (row.fact_kind === 'row') {
		if (row.row_id === null) {
			// `row_facts.row_id` is NOT NULL, so this is unreachable unless the
			// union projection above is edited wrongly. Refuse rather than coerce
			// to an empty string: that empty-row-id sentinel is exactly what the
			// split relations exist to make unrepresentable.
			throw new Error('A row fact is missing its row id');
		}
		const address: RowAddress = {
			kind: 'row',
			namespace: row.namespace,
			tableName: row.local_key,
			rowId: row.row_id,
		};
		return row.presence === 'absent'
			? {
					presence: 'absent',
					address,
					authoritySequence: row.authority_sequence,
				}
			: {
					presence: 'present',
					address,
					authoritySequence: row.authority_sequence,
					fields: JSON.parse(row.payload ?? 'null') as JsonObject,
				};
	}
	const address: ValueAddress = {
		kind: 'value',
		namespace: row.namespace,
		valueName: row.local_key,
	};
	return row.presence === 'absent'
		? {
				presence: 'absent',
				address,
				authoritySequence: row.authority_sequence,
			}
		: {
				presence: 'present',
				address,
				authoritySequence: row.authority_sequence,
				content: JSON.parse(row.payload ?? 'null') as JsonValue,
			};
}

/**
 * The exchange page is one sequence-ordered stream over both fact relations, so
 * every read that pages by sequence goes through this projection.
 */
const FACTS_IN_RANGE = `
	SELECT authority_sequence, 'row' AS fact_kind, namespace,
		table_name AS local_key, row_id, presence, fields AS payload
	FROM main._authority_row_facts WHERE authority_sequence > ? AND authority_sequence <= ?
	UNION ALL
	SELECT authority_sequence, 'value' AS fact_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, content AS payload
	FROM main._authority_value_facts WHERE authority_sequence > ? AND authority_sequence <= ?
	ORDER BY authority_sequence`;

/**
 * Read the one current fact at an address.
 *
 * The address is already known here, so each branch selects only the payload and
 * sequence and rebuilds the record around the caller's address.
 */
function readFact(
	database: SqliteDatabase,
	address: Address,
): Fact | undefined {
	if (address.kind === 'row') {
		const row = database.all<
			SqliteRow & {
				presence: string;
				fields: string | null;
				authority_sequence: number;
			}
		>(
			`SELECT presence, fields, authority_sequence
			FROM main._authority_row_facts WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.tableName, address.rowId],
		)[0];
		if (row === undefined) return undefined;
		return row.presence === 'absent'
			? {
					presence: 'absent',
					address,
					authoritySequence: row.authority_sequence,
				}
			: {
					presence: 'present',
					address,
					authoritySequence: row.authority_sequence,
					fields: JSON.parse(row.fields ?? 'null') as JsonObject,
				};
	}
	const row = database.all<
		SqliteRow & {
			presence: string;
			content: string | null;
			authority_sequence: number;
		}
	>(
		`SELECT presence, content, authority_sequence
		FROM main._authority_value_facts WHERE namespace = ? AND value_name = ?`,
		[address.namespace, address.valueName],
	)[0];
	if (row === undefined) return undefined;
	return row.presence === 'absent'
		? {
				presence: 'absent',
				address,
				authoritySequence: row.authority_sequence,
			}
		: {
				presence: 'present',
				address,
				authoritySequence: row.authority_sequence,
				content: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

function storeFact(database: SqliteDatabase, fact: Fact): void {
	if (fact.address.kind === 'row') {
		const { namespace, tableName, rowId } = fact.address;
		database.run(
			`INSERT INTO main._authority_row_facts (
				namespace, table_name, row_id, presence, fields, authority_sequence
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
				presence = excluded.presence,
				fields = excluded.fields,
				authority_sequence = excluded.authority_sequence`,
			[
				namespace,
				tableName,
				rowId,
				fact.presence,
				'fields' in fact ? JSON.stringify(fact.fields) : null,
				fact.authoritySequence,
			],
		);
		if (fact.presence === 'absent') {
			database.run(
				'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
				[namespace, tableName, rowId],
			);
			database.run(
				'DELETE FROM document_versions WHERE namespace = ? AND table_name = ? AND row_id = ?',
				[namespace, tableName, rowId],
			);
		}
		return;
	}
	const { namespace, valueName } = fact.address;
	database.run(
		`INSERT INTO main._authority_value_facts (
			namespace, value_name, presence, content, authority_sequence
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (namespace, value_name) DO UPDATE SET
			presence = excluded.presence,
			content = excluded.content,
			authority_sequence = excluded.authority_sequence`,
		[
			namespace,
			valueName,
			fact.presence,
			'content' in fact ? JSON.stringify(fact.content) : null,
			fact.authoritySequence,
		],
	);
}

function readPage(
	database: SqliteDatabase,
	position: number,
	through: number,
	pageSize: number,
	receipt: Receipt | undefined,
): { through: number; facts: Fact[]; next: Cursor | null } {
	const available = database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT ?`, [
		position,
		through,
		position,
		through,
		pageSize + 1,
	]);
	let facts = available.slice(0, pageSize).map(factRowToFact);
	while (
		facts.length > 1 &&
		encodedJsonBytes({
			...(receipt === undefined ? {} : { receipt }),
			through,
			facts,
			next: { through, position: facts.at(-1)?.authoritySequence ?? position },
		}) > DATA_ADMISSION_LIMITS.encodedPageBytes
	) {
		facts = facts.slice(0, -1);
	}
	const lastPosition = facts.at(-1)?.authoritySequence ?? position;
	const hasMore =
		available.length > facts.length ||
		database.all<FactRow>(`${FACTS_IN_RANGE} LIMIT 1`, [
			lastPosition,
			through,
			lastPosition,
			through,
		]).length > 0;
	return {
		through,
		facts,
		next: hasMore ? { through, position: lastPosition } : null,
	};
}

/** Open one principal-owned scalar sync authority over caller-owned SQLite. */
export function openEpicenterSyncAuthority({
	database,
	pageSize = DATA_ADMISSION_LIMITS.factsPerPage,
	readDatabaseSize,
}: {
	database: SqliteDatabase;
	pageSize?: number;
	/**
	 * Current size of the caller's database in bytes. When provided, a batch
	 * that would grow the store past the ceiling is refused rather than applied.
	 */
	readDatabaseSize?: () => number;
}) {
	if (
		!Number.isInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > DATA_ADMISSION_LIMITS.factsPerPage
	) {
		throw new RangeError('Authority page size is outside protocol limits');
	}
	initializeAuthoritySchema(database);

	return {
		/**
		 * Settle one replica's batch, if it carried one, and answer the next page
		 * of the sequence-ordered fact stream.
		 *
		 * Takes `unknown` because a Durable Object RPC entry point re-enters this
		 * from a serialized boundary, so the request is parsed here rather than
		 * trusted from a type.
		 */
		exchange(rawRequest: unknown): ExchangeResponse {
			return database.transaction(() => {
				const parsed = parseExchangeRequest(rawRequest);
				if (parsed.error !== null) throw new TypeError(parsed.error.message);
				const request = parsed.data;
				let receipt: Receipt | undefined;
				let metadata = readMetadata(database);

				if (request.batch !== undefined) {
					if (request.batch.digest !== batchDigest(request.batch.intents)) {
						throw new TypeError('Batch digest does not match its intents');
					}
					const stored = readReplica(database, request.replicaId);
					const acceptedBatch = stored?.accepted_batch ?? 0;
					if (request.batch.seq === acceptedBatch) {
						if (
							stored === undefined ||
							stored.request_digest !== request.batch.digest
						) {
							return { refusal: 'batch-conflict' };
						}
						receipt = receiptFrom(stored);
					} else if (request.batch.seq !== acceptedBatch + 1) {
						return { refusal: 'batch-conflict' };
					} else {
						if (
							readDatabaseSize !== undefined &&
							readDatabaseSize() >= AUTHORITY_STORAGE_BYTE_CEILING
						) {
							return { refusal: 'storage-limit' };
						}
						let nextSequence = metadata.next_sequence;
						for (const intent of request.batch.intents) {
							const folded = foldIntent(
								readFact(database, intent.address),
								intent,
								nextSequence,
							);
							if (folded.kind === 'noop') continue;
							// The authority is the only writer of `next_sequence`, so an
							// applied fold always carries a positive sequence and is a
							// genuine authority fact rather than a local one.
							storeFact(database, folded.fact as Fact);
							nextSequence += 1;
						}
						const appliedThrough = nextSequence - 1;
						database.run(
							'UPDATE main._authority_metadata SET next_sequence = ? WHERE singleton = 1',
							[nextSequence],
						);
						database.run(
							`INSERT INTO main._authority_replicas (
								replica_id, accepted_batch, request_digest, receipt_sequence
							) VALUES (?, ?, ?, ?)
							ON CONFLICT (replica_id) DO UPDATE SET
								accepted_batch = excluded.accepted_batch,
								request_digest = excluded.request_digest,
								receipt_sequence = excluded.receipt_sequence`,
							[
								request.replicaId,
								request.batch.seq,
								request.batch.digest,
								appliedThrough,
							],
						);
						receipt = {
							seq: request.batch.seq,
							digest: request.batch.digest,
							appliedThrough,
						};
						metadata = { ...metadata, next_sequence: nextSequence };
					}
				}

				const head = metadata.next_sequence - 1;
				const through = request.cursor?.through ?? head;
				const position = request.cursor?.position ?? request.after;
				if (request.after > head || through > head) {
					throw new TypeError('Exchange cursor is ahead of the authority');
				}
				return {
					...(receipt === undefined ? {} : { receipt }),
					...readPage(database, position, through, pageSize, receipt),
				};
			});
		},
	};
}
