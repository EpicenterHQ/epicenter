import {
	type Address,
	AuthorityError,
	canonicalize,
	encodedFactBytes,
	type Fact,
	type FactsResponse,
	foldIntent,
	isWellFormedString,
	type JsonObject,
	type JsonValue,
	type ParkedIntent,
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_V1_LIMITS,
	type ScalarProtocolError,
	type SubmissionResponse,
	sha256Hex,
	utf8ByteLength,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { initializeV1AuthoritySchema } from './v1-authority-schema.js';

type MetadataRow = SqliteRow & {
	authority_lifetime: string;
	next_sequence: number;
};

type ReplicaRow = SqliteRow & {
	last_submission_number: number;
	last_request_hash: string | null;
	touched_addresses: string | null;
	parked: string | null;
};

type FactRow = SqliteRow & {
	fact_kind: string;
	namespace: string;
	local_key: string;
	row_id: string | null;
	presence: string;
	payload: string | null;
	authority_sequence: number;
};

type V1AuthorityResult<T> = Result<T, ScalarProtocolError | AuthorityError>;

export type EpicenterSyncV1Authority = {
	readFacts(request: unknown): V1AuthorityResult<FactsResponse>;
	submit(request: unknown): V1AuthorityResult<SubmissionResponse>;
};

const FACTS_AFTER_SEQUENCE = `
	SELECT authority_sequence, 'row' AS fact_kind, namespace,
		table_name AS local_key, row_id, presence, fields AS payload
	FROM main._authority_v1_row_facts WHERE authority_sequence > ?
	UNION ALL
	SELECT authority_sequence, 'value' AS fact_kind, namespace,
		value_name AS local_key, NULL AS row_id, presence, content AS payload
	FROM main._authority_v1_value_facts WHERE authority_sequence > ?
	ORDER BY authority_sequence`;

function readMetadata(database: SqliteDatabase): MetadataRow {
	const metadata = database.all<MetadataRow>(
		`SELECT authority_lifetime, next_sequence
		FROM main._authority_v1_metadata WHERE singleton = 1`,
	)[0];
	if (metadata === undefined)
		throw new Error('V1 authority metadata is missing');
	return metadata;
}

function readReplica(
	database: SqliteDatabase,
	replicaId: string,
): ReplicaRow | undefined {
	return database.all<ReplicaRow>(
		`SELECT last_submission_number, last_request_hash,
			touched_addresses, parked
		FROM main._authority_v1_replicas WHERE replica_id = ?`,
		[replicaId],
	)[0];
}

function factRowToFact(row: FactRow): Fact {
	if (row.fact_kind === 'row') {
		if (row.row_id === null)
			throw new Error('A V1 row fact is missing its row id');
		const address = {
			kind: 'row',
			namespace: row.namespace,
			tableName: row.local_key,
			rowId: row.row_id,
		} as const;
		return row.presence === 'absent'
			? { address, sequence: row.authority_sequence, presence: 'absent' }
			: {
					address,
					sequence: row.authority_sequence,
					presence: 'present',
					fields: JSON.parse(row.payload ?? 'null') as JsonObject,
				};
	}
	const address = {
		kind: 'value',
		namespace: row.namespace,
		valueName: row.local_key,
	} as const;
	return row.presence === 'absent'
		? { address, sequence: row.authority_sequence, presence: 'absent' }
		: {
				address,
				sequence: row.authority_sequence,
				presence: 'present',
				content: JSON.parse(row.payload ?? 'null') as JsonValue,
			};
}

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
			FROM main._authority_v1_row_facts
			WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.tableName, address.rowId],
		)[0];
		if (row === undefined) return undefined;
		return row.presence === 'absent'
			? { address, sequence: row.authority_sequence, presence: 'absent' }
			: {
					address,
					sequence: row.authority_sequence,
					presence: 'present',
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
		FROM main._authority_v1_value_facts
		WHERE namespace = ? AND value_name = ?`,
		[address.namespace, address.valueName],
	)[0];
	if (row === undefined) return undefined;
	return row.presence === 'absent'
		? { address, sequence: row.authority_sequence, presence: 'absent' }
		: {
				address,
				sequence: row.authority_sequence,
				presence: 'present',
				content: JSON.parse(row.content ?? 'null') as JsonValue,
			};
}

function storeFact(database: SqliteDatabase, fact: Fact): void {
	if (fact.address.kind === 'row') {
		const { namespace, tableName, rowId } = fact.address;
		database.run(
			`INSERT INTO main._authority_v1_row_facts (
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
				fact.sequence,
			],
		);
		if (fact.presence === 'absent') {
			database.run(
				`DELETE FROM document_updates
				WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[namespace, tableName, rowId],
			);
			database.run(
				`DELETE FROM document_versions
				WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[namespace, tableName, rowId],
			);
		}
		return;
	}

	const { namespace, valueName } = fact.address;
	database.run(
		`INSERT INTO main._authority_v1_value_facts (
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
			fact.sequence,
		],
	);
}

function currentFactsFor(
	database: SqliteDatabase,
	addresses: readonly Address[],
): Fact[] {
	const facts: Fact[] = [];
	for (const address of addresses) {
		const fact = readFact(database, address);
		if (fact !== undefined) facts.push(fact);
	}
	return facts;
}

function parseStoredArray<T>(value: string | null, name: string): T[] {
	if (value === null) throw new Error(`V1 authority ${name} is missing`);
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed))
		throw new Error(`V1 authority ${name} is not an array`);
	return parsed as T[];
}

function factsResponseEnvelopeBytes(
	authorityLifetime: string,
	hasMore: boolean,
): number {
	return utf8ByteLength(
		canonicalize({ authorityLifetime, facts: [], hasMore }),
	);
}

function packFactsResponse(
	authorityLifetime: string,
	qualifying: readonly Fact[],
	limits: ValidatedLimits,
): FactsResponse {
	let factBytes = 0;
	let prefixCount = 0;
	for (let index = 0; index < qualifying.length; index += 1) {
		const fact = qualifying[index];
		if (fact === undefined) break;
		factBytes += encodedFactBytes(fact);
		const hasMore = index + 1 < qualifying.length;
		const candidateBytes =
			factsResponseEnvelopeBytes(authorityLifetime, hasMore) +
			factBytes +
			index;
		if (candidateBytes > limits.maxFactsResponseBytes) break;
		prefixCount = index + 1;
	}
	if (qualifying.length > 0 && prefixCount === 0) {
		throw new Error('Validated V1 limits could not carry one stored fact');
	}
	return {
		authorityLifetime,
		facts: qualifying.slice(0, prefixCount),
		hasMore: prefixCount < qualifying.length,
	};
}

/**
 * Open the SQLite realization of the pure scalar V1 authority while leaving the
 * combined-exchange authority as an independent path.
 */
export function openEpicenterSyncV1Authority({
	database,
	limits = SCALAR_V1_LIMITS,
	mintLifetime,
}: {
	database: SqliteDatabase;
	limits?: ValidatedLimits;
	mintLifetime: () => string;
}): EpicenterSyncV1Authority {
	initializeV1AuthoritySchema(database, { mintLifetime });
	const initialMetadata = readMetadata(database);
	if (
		initialMetadata.authority_lifetime.length === 0 ||
		!isWellFormedString(initialMetadata.authority_lifetime) ||
		utf8ByteLength(initialMetadata.authority_lifetime) > limits.maxLifetimeBytes
	) {
		throw new Error('V1 authority lifetime is outside protocol limits');
	}

	return {
		readFacts(rawRequest): V1AuthorityResult<FactsResponse> {
			return database.transaction(() => {
				const parsed = parseFactsRequest(rawRequest, limits);
				if (parsed.error !== null) return Err(parsed.error);
				const request = parsed.data;
				const metadata = readMetadata(database);
				if (
					request.authorityLifetime !== undefined &&
					request.authorityLifetime !== metadata.authority_lifetime
				) {
					return AuthorityError.LifetimeMismatch({
						requested: request.authorityLifetime,
						active: metadata.authority_lifetime,
					});
				}
				const activeSequence = metadata.next_sequence - 1;
				if (request.afterSequence > activeSequence) {
					return AuthorityError.SequenceAhead({
						requestedAfterSequence: request.afterSequence,
						activeSequence,
					});
				}
				const qualifying = database
					.all<FactRow>(FACTS_AFTER_SEQUENCE, [
						request.afterSequence,
						request.afterSequence,
					])
					.map(factRowToFact);
				return Ok(
					packFactsResponse(metadata.authority_lifetime, qualifying, limits),
				);
			});
		},

		submit(rawRequest): V1AuthorityResult<SubmissionResponse> {
			return database.transaction(() => {
				const parsed = parseSubmissionRequest(rawRequest, limits);
				if (parsed.error !== null) return Err(parsed.error);
				const request = parsed.data;
				const metadata = readMetadata(database);
				if (request.authorityLifetime !== metadata.authority_lifetime) {
					return AuthorityError.LifetimeMismatch({
						requested: request.authorityLifetime,
						active: metadata.authority_lifetime,
					});
				}

				const requestHash = sha256Hex(canonicalize(request));
				const replica = readReplica(database, request.replicaId);
				const lastNumber = replica?.last_submission_number ?? 0;
				if (replica !== undefined && request.submissionNumber === lastNumber) {
					if (requestHash !== replica.last_request_hash) {
						return AuthorityError.SubmissionFork({
							submissionNumber: request.submissionNumber,
						});
					}
					const touchedAddresses = parseStoredArray<Address>(
						replica.touched_addresses,
						'touched addresses',
					);
					const parked = parseStoredArray<ParkedIntent>(
						replica.parked,
						'parked intents',
					);
					return Ok({
						authorityLifetime: metadata.authority_lifetime,
						facts: currentFactsFor(database, touchedAddresses),
						parked,
					});
				}

				const expectedNumber = lastNumber + 1;
				if (request.submissionNumber !== expectedNumber) {
					return AuthorityError.SubmissionGap({
						submissionNumber: request.submissionNumber,
						expectedNumber,
					});
				}

				let nextSequence = metadata.next_sequence;
				const changedFacts: Fact[] = [];
				const parked: ParkedIntent[] = [];
				for (const intent of request.intents) {
					const outcome = foldIntent(
						readFact(database, intent.address),
						intent,
						nextSequence,
					);
					if (outcome.kind === 'unchanged') continue;
					const measuredBytes = encodedFactBytes(outcome.fact);
					if (
						outcome.fact.presence === 'present' &&
						'fields' in outcome.fact &&
						measuredBytes > limits.maxEncodedFactBytes
					) {
						parked.push({
							address: outcome.fact.address,
							code: 'fact-too-large',
							measuredBytes,
							limitBytes: limits.maxEncodedFactBytes,
						});
						continue;
					}
					if (!Number.isSafeInteger(nextSequence)) {
						return AuthorityError.SequenceExhausted({ nextSequence });
					}
					changedFacts.push(outcome.fact);
					nextSequence += 1;
				}

				for (const fact of changedFacts) storeFact(database, fact);
				database.run(
					`UPDATE main._authority_v1_metadata
					SET next_sequence = ? WHERE singleton = 1`,
					[nextSequence],
				);
				const touchedAddresses = request.intents.map(
					(intent) => intent.address,
				);
				database.run(
					`INSERT INTO main._authority_v1_replicas (
						replica_id, last_submission_number, last_request_hash,
						touched_addresses, parked
					) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (replica_id) DO UPDATE SET
						last_submission_number = excluded.last_submission_number,
						last_request_hash = excluded.last_request_hash,
						touched_addresses = excluded.touched_addresses,
						parked = excluded.parked`,
					[
						request.replicaId,
						request.submissionNumber,
						requestHash,
						JSON.stringify(touchedAddresses),
						JSON.stringify(parked),
					],
				);
				return Ok({
					authorityLifetime: metadata.authority_lifetime,
					facts: currentFactsFor(database, touchedAddresses),
					parked,
				});
			});
		},
	};
}
