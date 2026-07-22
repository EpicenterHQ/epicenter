import type {
	DocumentAcceptance,
	DocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import {
	type AdmittedFactsRequest,
	type AdmittedSubmissionRequest,
	AuthorityError,
	canonicalize,
	encodedFactBytes,
	type Fact,
	type FactsResponse,
	foldIntent,
	type JsonValue,
	type ParkedIntent,
	parseFactsRequest,
	type SubmissionResponse,
	sha256Hex,
	utf8ByteLength,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { Ok, type Result } from 'wellcrafted/result';

import { openAuthorityV1Schema } from './authority-v1-schema.js';
import { recoverInterruptedCaptureManifests } from './capture-manifest-v1.js';
import {
	type AuthorityDocumentRead,
	createAuthorityDocumentV1,
} from './document-authority-v1.js';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';
const FACTS_READ_CHUNK = 128;

type RecordAddress = AdmittedSubmissionRequest['intents'][number]['address'];

type MetaRow = SqliteRow & {
	format_version: number;
	authority_lifetime: string;
	next_sequence: number;
	next_capture_revision: number;
};

type RecordRow = SqliteRow & {
	namespace: string;
	collection: string;
	record_key: string;
	state: 'live' | 'tombstone' | 'unset';
	payload: string | null;
	sequence: number;
};

type WitnessRow = SqliteRow & {
	submission_number: number;
	request_hash: string;
	parked: string;
};

export type ScalarAuthorityV1 = {
	readFacts(
		request: AdmittedFactsRequest,
	): Result<FactsResponse, AuthorityError>;
	submit(
		request: AdmittedSubmissionRequest,
	): Result<SubmissionResponse, AuthorityError>;
};

export type DataAuthorityV1 = ScalarAuthorityV1 & {
	authorityLifetime(): string;
	acceptDocument(request: DocumentPublicationRequest): DocumentAcceptance;
	exportDocument(address: RecordAddress): Uint8Array | undefined;
	readDocument(address: RecordAddress): AuthorityDocumentRead;
};

export type OpenScalarAuthorityV1Options = {
	database: SqliteDatabase;
	limits: ValidatedLimits;
	initialize?: { authorityLifetime: string };
};

function one<TRow extends SqliteRow>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | null {
	return database.all<TRow>(sql, parameters)[0] ?? null;
}

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function readMeta(database: SqliteDatabase): MetaRow {
	const meta = one<MetaRow>(database, 'SELECT * FROM meta WHERE singleton = 1');
	if (meta === null) throw new Error('scalar V1 authority metadata is missing');
	return meta;
}

function factFromRow(row: RecordRow): Fact {
	const address = {
		namespace: row.namespace,
		collection: row.collection,
		recordKey: row.record_key,
	};
	return row.state === 'live'
		? {
				address,
				sequence: row.sequence,
				state: 'live',
				payload: JSON.parse(row.payload ?? '') as JsonValue,
			}
		: { address, sequence: row.sequence, state: row.state };
}

function readFact(
	database: SqliteDatabase,
	address: RecordAddress,
): Fact | undefined {
	const row = one<RecordRow>(
		database,
		`SELECT namespace, collection, record_key, state, payload, sequence
		FROM records WHERE ${TRIPLE_WHERE}`,
		tripleParams(address),
	);
	return row === null ? undefined : factFromRow(row);
}

function currentFactsFor(
	database: SqliteDatabase,
	request: AdmittedSubmissionRequest,
): Fact[] {
	return request.intents.map((intent) => {
		const fact = readFact(database, intent.address);
		if (fact === undefined) {
			throw new Error('accepted submission did not establish a current fact');
		}
		return fact;
	});
}

function readWitness(
	database: SqliteDatabase,
	replicaId: string,
): WitnessRow | null {
	return one<WitnessRow>(
		database,
		`SELECT submission_number, request_hash, parked
		FROM replica_witness WHERE replica_id = ?`,
		[replicaId],
	);
}

function storeFact(
	database: SqliteDatabase,
	fact: Fact,
	captureRevision: number,
): void {
	const payload = fact.state === 'live' ? canonicalize(fact.payload) : null;
	database.run(
		`INSERT INTO records (
			namespace, collection, record_key, state, payload, sequence,
			capture_revision
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (namespace, collection, record_key) DO UPDATE SET
			state = excluded.state,
			payload = excluded.payload,
			sequence = excluded.sequence,
			capture_revision = excluded.capture_revision,
			accepted_blob_sha256 = CASE
				WHEN excluded.state = 'tombstone' THEN NULL
				ELSE records.accepted_blob_sha256
			END`,
		[
			...tripleParams(fact.address),
			fact.state,
			payload,
			fact.sequence,
			captureRevision,
		],
	);
	if (fact.state === 'tombstone') {
		database.run(
			`DELETE FROM record_documents WHERE record_id =
				(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
			tripleParams(fact.address),
		);
	}
}

function readFactsPage(
	database: SqliteDatabase,
	request: AdmittedFactsRequest,
	limits: ValidatedLimits,
): Result<FactsResponse, AuthorityError> {
	const meta = readMeta(database);
	if (
		request.authorityLifetime !== undefined &&
		request.authorityLifetime !== meta.authority_lifetime
	) {
		return AuthorityError.LifetimeMismatch({
			requested: request.authorityLifetime,
			active: meta.authority_lifetime,
		});
	}
	const activeSequence = meta.next_sequence - 1;
	if (request.afterSequence > activeSequence) {
		return AuthorityError.SequenceAhead({
			requestedAfterSequence: request.afterSequence,
			activeSequence,
		});
	}

	const emptyTrueBytes = utf8ByteLength(
		canonicalize({
			authorityLifetime: meta.authority_lifetime,
			facts: [],
			hasMore: true,
		}),
	);
	const emptyFalseBytes = emptyTrueBytes + 1;
	const facts: Fact[] = [];
	let factsBytes = 0;
	let cursor = request.afterSequence;

	for (;;) {
		const rows = database.all<RecordRow>(
			`SELECT namespace, collection, record_key, state, payload, sequence
			FROM records WHERE sequence > ? ORDER BY sequence LIMIT ?`,
			[cursor, FACTS_READ_CHUNK],
		);
		for (const row of rows) {
			const fact = factFromRow(row);
			const nextFactsBytes =
				factsBytes + encodedFactBytes(fact) + (facts.length === 0 ? 0 : 1);
			if (emptyTrueBytes + nextFactsBytes > limits.maxFactsResponseBytes) {
				return Ok({
					authorityLifetime: meta.authority_lifetime,
					facts,
					hasMore: true,
				});
			}
			facts.push(fact);
			factsBytes = nextFactsBytes;
			cursor = row.sequence;
		}

		if (rows.length < FACTS_READ_CHUNK) {
			if (
				facts.length > 0 &&
				emptyFalseBytes + factsBytes > limits.maxFactsResponseBytes
			) {
				facts.pop();
				return Ok({
					authorityLifetime: meta.authority_lifetime,
					facts,
					hasMore: true,
				});
			}
			return Ok({
				authorityLifetime: meta.authority_lifetime,
				facts,
				hasMore: false,
			});
		}
	}
}

/** Open one principal-owned scalar V1 authority over caller-owned SQLite. */
export function openScalarAuthorityV1({
	database,
	limits,
	initialize,
}: OpenScalarAuthorityV1Options): DataAuthorityV1 {
	if (initialize !== undefined) {
		const admitted = parseFactsRequest(
			{ authorityLifetime: initialize.authorityLifetime, afterSequence: 0 },
			limits,
		);
		if (admitted.error !== null) {
			throw new Error(
				`scalar V1 authority initialization failed: ${admitted.error.message}`,
			);
		}
	}
	openAuthorityV1Schema(database, initialize);
	recoverInterruptedCaptureManifests(database);
	const meta = readMeta(database);
	const admittedMeta = parseFactsRequest(
		{ authorityLifetime: meta.authority_lifetime, afterSequence: 0 },
		limits,
	);
	if (admittedMeta.error !== null) {
		throw new Error('scalar V1 authority lifetime metadata is invalid');
	}
	const documents = createAuthorityDocumentV1(database);

	return {
		authorityLifetime: () => readMeta(database).authority_lifetime,
		acceptDocument: documents.accept,
		exportDocument: documents.exportDocument,
		readDocument: documents.readDocument,
		readFacts(request) {
			return database.transaction(() =>
				readFactsPage(database, request, limits),
			);
		},

		submit(request) {
			return database.transaction(() => {
				const currentMeta = readMeta(database);
				if (request.authorityLifetime !== currentMeta.authority_lifetime) {
					return AuthorityError.LifetimeMismatch({
						requested: request.authorityLifetime,
						active: currentMeta.authority_lifetime,
					});
				}

				const requestHash = sha256Hex(canonicalize(request));
				const witness = readWitness(database, request.replicaId);
				const lastNumber = witness?.submission_number ?? 0;
				if (witness !== null && request.submissionNumber === lastNumber) {
					if (requestHash !== witness.request_hash) {
						return AuthorityError.SubmissionFork({
							submissionNumber: request.submissionNumber,
						});
					}
					return Ok({
						authorityLifetime: currentMeta.authority_lifetime,
						facts: currentFactsFor(database, request),
						parked: JSON.parse(witness.parked) as ParkedIntent[],
					});
				}

				const expectedNumber = lastNumber + 1;
				if (request.submissionNumber !== expectedNumber) {
					return AuthorityError.SubmissionGap({
						submissionNumber: request.submissionNumber,
						expectedNumber,
					});
				}

				let nextSequence = currentMeta.next_sequence;
				let nextCaptureRevision = currentMeta.next_capture_revision;
				const parked: ParkedIntent[] = [];
				const changed: Array<{ fact: Fact; captureRevision: number }> = [];
				for (const intent of request.intents) {
					const outcome = foldIntent(
						readFact(database, intent.address),
						intent,
						nextSequence,
					);
					if (outcome.kind === 'unchanged') continue;
					if (outcome.kind === 'refused') {
						parked.push({
							address: structuredClone(intent.address),
							code: outcome.code,
						});
						continue;
					}
					const measuredBytes = encodedFactBytes(outcome.fact);
					if (
						intent.op === 'patch' &&
						measuredBytes > limits.maxEncodedFactBytes
					) {
						parked.push({
							address: structuredClone(intent.address),
							code: 'fact-too-large',
							measuredBytes,
							limitBytes: limits.maxEncodedFactBytes,
						});
						continue;
					}
					if (!Number.isSafeInteger(nextSequence)) {
						return AuthorityError.SequenceExhausted({ nextSequence });
					}
					if (!Number.isSafeInteger(nextCaptureRevision)) {
						throw new Error('authority capture revision exhausted');
					}
					changed.push({
						fact: outcome.fact,
						captureRevision: nextCaptureRevision,
					});
					nextSequence += 1;
					nextCaptureRevision += 1;
				}

				for (const entry of changed) {
					storeFact(database, entry.fact, entry.captureRevision);
				}
				database.run(
					`UPDATE meta SET next_sequence = ?, next_capture_revision = ?
					WHERE singleton = 1`,
					[nextSequence, nextCaptureRevision],
				);
				database.run(
					`INSERT INTO replica_witness (
						replica_id, submission_number, request_hash, parked
					) VALUES (?, ?, ?, ?)
					ON CONFLICT (replica_id) DO UPDATE SET
						submission_number = excluded.submission_number,
						request_hash = excluded.request_hash,
						parked = excluded.parked`,
					[
						request.replicaId,
						request.submissionNumber,
						requestHash,
						canonicalize(parked),
					],
				);

				return Ok({
					authorityLifetime: currentMeta.authority_lifetime,
					facts: currentFactsFor(database, request),
					parked,
				});
			});
		},
	};
}
