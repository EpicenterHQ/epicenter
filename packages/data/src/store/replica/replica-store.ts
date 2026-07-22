import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import {
	type AdmittedSubmissionRequest,
	admitFactsPage,
	admitSettlement,
	canonicalize,
	composeOperations,
	type Fact,
	type FactsRequest,
	type FactsResponse,
	type Intent,
	type JsonValue,
	type Operation,
	type ParkedIntent,
	parseFactsRequest,
	parseIntent,
	parseSubmissionRequest,
	type SubmissionRequest,
	type SubmissionResponse,
	sha256Hex,
	type ValidatedLimits,
} from '../../protocol/v1/index.js';
import { createReplicaDocumentStore } from './document-store.js';
import {
	createReplicaStoreSchema,
	REPLICA_STORE_FORMAT_VERSION,
	REPLICA_STORE_INDEXES,
	REPLICA_STORE_TABLES,
} from './schema.js';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';

type RecordAddress = Intent['address'];

type RecordRow = SqliteRow & {
	confirmed_state: 'live' | 'tombstone' | 'unset' | null;
	confirmed_payload: string | null;
	confirmed_sequence: number | null;
	sealed_op: Operation['op'] | null;
	sealed_args: string | null;
	pending_op: Operation['op'] | null;
	pending_args: string | null;
	parked_op: 'patch' | null;
	parked_args: string | null;
	parked_code: 'fact-too-large' | 'patch-base-not-object' | null;
	parked_measured: number | null;
	parked_limit: number | null;
};

type MetaRow = SqliteRow & {
	format_version: number;
	replica_id: string;
	authority_lifetime: string | null;
	erased_authority_lifetime: string | null;
	after_sequence: number;
	sealed_submission: number | null;
	sealed_request: string | null;
	sealed_request_hash: string | null;
	next_submission: number;
};

export type ReplicaRecordLanes = {
	confirmed: {
		state: 'live' | 'tombstone' | 'unset';
		payload?: JsonValue;
		sequence: number;
	} | null;
	sealed: Operation | null;
	pending: Operation | null;
	parked: {
		operation: Operation;
		code: 'fact-too-large' | 'patch-base-not-object';
		measuredBytes?: number;
		limitBytes?: number;
	} | null;
};

export type ReplicaStoreSync = {
	replicaId: string;
	authorityLifetime: string | null;
	afterSequence: number;
	sealedSubmission: number | null;
	nextSubmission: number;
};

export type SealedRequest = { bytes: string; hash: string };

export type ReplicaFactsPage = {
	request: FactsRequest;
	response: FactsResponse;
};

export type OpenReplicaStoreOptions = {
	database: SqliteDatabase;
	limits: ValidatedLimits;
	initialize?: { replicaId: string; authorityLifetime?: string };
};

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function operationArgs(operation: Operation): string | null {
	switch (operation.op) {
		case 'patch':
			return canonicalize({ set: operation.set, unset: operation.unset });
		case 'replace':
			return canonicalize(operation.value);
		case 'tombstone':
		case 'unset':
			return null;
	}
}

function decodeOperation(op: Operation['op'], args: string | null): Operation {
	switch (op) {
		case 'patch': {
			const parsed = JSON.parse(args ?? '') as {
				set: Record<string, JsonValue>;
				unset: string[];
			};
			return { op, set: parsed.set, unset: parsed.unset };
		}
		case 'replace':
			return { op, value: JSON.parse(args ?? '') as JsonValue };
		case 'tombstone':
		case 'unset':
			return { op };
	}
}

function intentOperation(intent: Intent): Operation {
	switch (intent.op) {
		case 'patch':
			return { op: intent.op, set: intent.set, unset: intent.unset };
		case 'replace':
			return { op: intent.op, value: intent.value };
		case 'tombstone':
		case 'unset':
			return { op: intent.op };
	}
}

function lanesOf(row: RecordRow | null): ReplicaRecordLanes | null {
	if (row === null) return null;
	return {
		confirmed:
			row.confirmed_state === null || row.confirmed_sequence === null
				? null
				: {
						state: row.confirmed_state,
						...(row.confirmed_payload === null
							? {}
							: {
									payload: JSON.parse(row.confirmed_payload) as JsonValue,
								}),
						sequence: row.confirmed_sequence,
					},
		sealed:
			row.sealed_op === null
				? null
				: decodeOperation(row.sealed_op, row.sealed_args),
		pending:
			row.pending_op === null
				? null
				: decodeOperation(row.pending_op, row.pending_args),
		parked:
			row.parked_op === null || row.parked_code === null
				? null
				: {
						operation: decodeOperation(row.parked_op, row.parked_args),
						code: row.parked_code,
						...(row.parked_measured === null
							? {}
							: { measuredBytes: row.parked_measured }),
						...(row.parked_limit === null
							? {}
							: { limitBytes: row.parked_limit }),
					},
	};
}

function one<TRow extends SqliteRow>(
	database: SqliteDatabase,
	sql: string,
	parameters: readonly (string | number | null)[] = [],
): TRow | null {
	return database.all<TRow>(sql, parameters)[0] ?? null;
}

function readMeta(database: SqliteDatabase): MetaRow {
	const meta = one<MetaRow>(database, 'SELECT * FROM meta WHERE singleton = 1');
	if (meta === null) throw new Error('replica meta row missing');
	return meta;
}

function readRecord(
	database: SqliteDatabase,
	address: RecordAddress,
): RecordRow | null {
	return one<RecordRow>(
		database,
		`SELECT * FROM records WHERE ${TRIPLE_WHERE}`,
		tripleParams(address),
	);
}

function installFact(database: SqliteDatabase, fact: Fact): void {
	const row = readRecord(database, fact.address);
	const currentSequence = row?.confirmed_sequence ?? 0;
	if (fact.sequence < currentSequence) return;
	if (fact.sequence === currentSequence && row !== null) {
		const isIdentical =
			row.confirmed_state === fact.state &&
			(fact.state !== 'live' ||
				row.confirmed_payload === canonicalize(fact.payload));
		if (!isIdentical) {
			throw new Error(
				'equal sequence with different content: replica corruption',
			);
		}
		return;
	}

	const payload = fact.state === 'live' ? canonicalize(fact.payload) : null;
	if (row === null) {
		database.run(
			`INSERT INTO records (
				namespace, collection, record_key,
				confirmed_state, confirmed_payload, confirmed_sequence
			) VALUES (?, ?, ?, ?, ?, ?)`,
			[...tripleParams(fact.address), fact.state, payload, fact.sequence],
		);
		return;
	}

	if (fact.state === 'tombstone') {
		database.run(
			`UPDATE records SET
				confirmed_state = 'tombstone',
				confirmed_payload = NULL,
				confirmed_sequence = ?,
				pending_op = NULL,
				pending_args = NULL,
				parked_op = NULL,
				parked_args = NULL,
				parked_code = NULL,
				parked_measured = NULL,
				parked_limit = NULL,
				blob_sha256 = NULL,
				blob_pending = 0,
				doc_revision = 0,
				doc_dirty = 0
			WHERE ${TRIPLE_WHERE}`,
			[fact.sequence, ...tripleParams(fact.address)],
		);
		database.run(
			`DELETE FROM record_documents WHERE record_id =
				(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
			tripleParams(fact.address),
		);
		database.run(
			`DELETE FROM document_inflight WHERE record_id =
				(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
			tripleParams(fact.address),
		);
		return;
	}

	database.run(
		`UPDATE records SET
			confirmed_state = ?,
			confirmed_payload = ?,
			confirmed_sequence = ?
		WHERE ${TRIPLE_WHERE}`,
		[fact.state, payload, fact.sequence, ...tripleParams(fact.address)],
	);
}

function openSchema(
	database: SqliteDatabase,
	limits: ValidatedLimits,
	initialize: OpenReplicaStoreOptions['initialize'],
): void {
	const objects = database.all<SqliteRow & { name: string; type: string }>(
		`SELECT type, name FROM sqlite_schema
		WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
		ORDER BY type, name`,
	);
	if (objects.length === 0) {
		if (initialize === undefined) {
			throw new Error('replica store does not exist');
		}
		const initialFacts = parseFactsRequest(
			{
				...(initialize.authorityLifetime === undefined
					? {}
					: { authorityLifetime: initialize.authorityLifetime }),
				afterSequence: 0,
			},
			limits,
		);
		if (initialFacts.error !== null) {
			throw new Error(
				`replica initialization failed: ${initialFacts.error.message}`,
			);
		}
		database.transaction(() => createReplicaStoreSchema(database, initialize));
	} else {
		const actual = objects.map(({ type, name }) => `${type}:${name}`);
		const expected = [
			...REPLICA_STORE_INDEXES.map((name) => `index:${name}`),
			...REPLICA_STORE_TABLES.map((name) => `table:${name}`),
		].sort();
		if (
			actual.length !== expected.length ||
			actual.some((entry, index) => entry !== expected[index])
		) {
			throw new Error(
				`replica store schema does not match format ${REPLICA_STORE_FORMAT_VERSION}`,
			);
		}
	}

	const meta = readMeta(database);
	if (meta.format_version !== REPLICA_STORE_FORMAT_VERSION) {
		throw new Error(`unsupported replica store format ${meta.format_version}`);
	}
	const durableFacts = parseFactsRequest(
		{
			...(meta.authority_lifetime === null
				? {}
				: { authorityLifetime: meta.authority_lifetime }),
			afterSequence: meta.after_sequence,
		},
		limits,
	);
	if (durableFacts.error !== null) {
		throw new Error('replica store synchronization metadata is invalid');
	}
	if (meta.erased_authority_lifetime !== null) {
		const erasedLifetime = parseFactsRequest(
			{
				authorityLifetime: meta.erased_authority_lifetime,
				afterSequence: 0,
			},
			limits,
		);
		if (erasedLifetime.error !== null) {
			throw new Error('replica store erased-lifetime metadata is invalid');
		}
	}
}

/**
 * Open the private V1 replica store over a caller-owned embedded SQLite handle.
 *
 * The store owns the universal-record lane machine and its transactions. The
 * caller owns the database handle and runtime lifecycle. This boundary is
 * synchronous because every supported embedded SQLite adapter exposes a
 * synchronous transaction callback.
 */
export function openReplicaStore({
	database,
	limits,
	initialize,
}: OpenReplicaStoreOptions) {
	openSchema(database, limits, initialize);
	const documents = createReplicaDocumentStore(database);

	function record(address: RecordAddress): ReplicaRecordLanes | null {
		return lanesOf(readRecord(database, address));
	}

	function sync(): ReplicaStoreSync {
		const meta = readMeta(database);
		return {
			replicaId: meta.replica_id,
			authorityLifetime: meta.authority_lifetime,
			afterSequence: meta.after_sequence,
			sealedSubmission: meta.sealed_submission,
			nextSubmission: meta.next_submission,
		};
	}

	function sealedRequest(): SealedRequest | null {
		const meta = readMeta(database);
		if (meta.sealed_request === null || meta.sealed_request_hash === null) {
			return null;
		}
		return { bytes: meta.sealed_request, hash: meta.sealed_request_hash };
	}

	function localWrite(rawIntent: Intent): void {
		const { data: intent, error } = parseIntent(rawIntent, limits);
		if (error !== null) throw new Error(error.message);
		database.transaction(() => {
			const row = readRecord(database, intent.address);
			const operation = intentOperation(intent);
			if (row === null) {
				database.run(
					`INSERT INTO records (
						namespace, collection, record_key, pending_op, pending_args
					) VALUES (?, ?, ?, ?, ?)`,
					[
						...tripleParams(intent.address),
						operation.op,
						operationArgs(operation),
					],
				);
				return;
			}
			if (
				row.confirmed_state === 'tombstone' ||
				row.sealed_op === 'tombstone' ||
				row.pending_op === 'tombstone'
			) {
				throw new Error('local write over a tombstone');
			}

			const older =
				row.parked_op !== null
					? decodeOperation(row.parked_op, row.parked_args)
					: row.pending_op !== null
						? decodeOperation(row.pending_op, row.pending_args)
						: undefined;
			const outcome =
				older === undefined
					? { kind: 'composed' as const, operation }
					: composeOperations(older, operation);
			if (outcome.kind === 'refused') {
				throw new Error(`local compaction refused: ${outcome.code}`);
			}
			database.run(
				row.parked_op === null
					? `UPDATE records SET pending_op = ?, pending_args = ?
						WHERE ${TRIPLE_WHERE}`
					: `UPDATE records SET pending_op = ?, pending_args = ?,
						parked_op = NULL, parked_args = NULL, parked_code = NULL,
						parked_measured = NULL, parked_limit = NULL
						WHERE ${TRIPLE_WHERE}`,
				[
					outcome.operation.op,
					operationArgs(outcome.operation),
					...tripleParams(intent.address),
				],
			);
			if (outcome.operation.op === 'tombstone') {
				database.run(
					`UPDATE records SET blob_sha256 = NULL, blob_pending = 0,
						doc_revision = 0, doc_dirty = 0
					WHERE ${TRIPLE_WHERE}`,
					tripleParams(intent.address),
				);
				database.run(
					`DELETE FROM record_documents WHERE record_id =
						(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
					tripleParams(intent.address),
				);
				database.run(
					`DELETE FROM document_inflight WHERE record_id =
						(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
					tripleParams(intent.address),
				);
			}
		});
	}

	function seal(): SealedRequest {
		return database.transaction(() => {
			const meta = readMeta(database);
			if (meta.authority_lifetime === null) {
				throw new Error('cannot seal before lifetime binding');
			}
			if (meta.sealed_submission !== null) {
				throw new Error('one submission is already sealed');
			}
			// MAX_SAFE_INTEGER + 1 is the one internal exhaustion sentinel. It can
			// be reached only by settling the final wire-valid submission number and
			// must never be admitted into another request.
			if (!Number.isSafeInteger(meta.next_submission)) {
				throw new Error('replica submission number space is exhausted');
			}
			let pending = database.all<
				RecordRow & {
					record_id: number;
					namespace: string;
					collection: string;
					record_key: string;
				}
			>(
				`SELECT * FROM records WHERE pending_op IS NOT NULL
				ORDER BY namespace, collection, record_key LIMIT ?`,
				[limits.maxSubmissionAddresses],
			);
			if (pending.length === 0) throw new Error('nothing to seal');
			let admitted: AdmittedSubmissionRequest | undefined;
			let admissionError: Error | undefined;
			while (pending.length > 0) {
				const request: SubmissionRequest = {
					authorityLifetime: meta.authority_lifetime,
					replicaId: meta.replica_id,
					submissionNumber: meta.next_submission,
					intents: pending.map((row) => ({
						address: {
							namespace: row.namespace,
							collection: row.collection,
							recordKey: row.record_key,
						},
						...decodeOperation(
							row.pending_op as Operation['op'],
							row.pending_args,
						),
					})),
				};
				const parsed = parseSubmissionRequest(request, limits);
				if (parsed.error === null) {
					admitted = parsed.data;
					break;
				}
				admissionError = new Error(
					`seal admission failed: ${parsed.error.message}`,
				);
				pending = pending.slice(0, -1);
			}
			if (admitted === undefined) {
				throw (
					admissionError ?? new Error('no pending operation fits a submission')
				);
			}
			const bytes = canonicalize(admitted);
			const hash = sha256Hex(bytes);
			const placeholders = pending.map(() => '?').join(', ');
			database.run(
				`UPDATE records SET
					sealed_op = pending_op,
					sealed_args = pending_args,
					pending_op = NULL,
					pending_args = NULL
				WHERE record_id IN (${placeholders})`,
				pending.map((row) => row.record_id),
			);
			database.run(
				`UPDATE meta SET
					sealed_submission = next_submission,
					sealed_request = ?,
					sealed_request_hash = ?
				WHERE singleton = 1`,
				[bytes, hash],
			);
			return { bytes, hash };
		});
	}

	function reconstructSealedRequest(): string {
		const meta = readMeta(database);
		if (meta.sealed_submission === null || meta.authority_lifetime === null) {
			throw new Error('nothing sealed');
		}
		const sealed = database.all<
			RecordRow & {
				namespace: string;
				collection: string;
				record_key: string;
			}
		>(
			`SELECT * FROM records WHERE sealed_op IS NOT NULL
			ORDER BY namespace, collection, record_key`,
		);
		return canonicalize({
			authorityLifetime: meta.authority_lifetime,
			replicaId: meta.replica_id,
			submissionNumber: meta.sealed_submission,
			intents: sealed.map((row) => ({
				address: {
					namespace: row.namespace,
					collection: row.collection,
					recordKey: row.record_key,
				},
				...decodeOperation(row.sealed_op as Operation['op'], row.sealed_args),
			})),
		} satisfies SubmissionRequest);
	}

	function installFacts(page: ReplicaFactsPage): void {
		const parsedRequest = parseFactsRequest(page.request, limits);
		if (parsedRequest.error !== null) {
			throw new Error(parsedRequest.error.message);
		}
		database.transaction(() => {
			const meta = readMeta(database);
			const admitted = admitFactsPage(
				page.response,
				parsedRequest.data,
				{
					...(meta.authority_lifetime === null
						? {}
						: { authorityLifetime: meta.authority_lifetime }),
					afterSequence: meta.after_sequence,
				},
				limits,
			);
			if (admitted.error !== null) {
				throw new Error(admitted.error.message);
			}
			const response = admitted.data;
			if (response.authorityLifetime === meta.erased_authority_lifetime) {
				throw new Error('erased authority lifetime cannot be rebound');
			}
			for (const fact of response.facts) installFact(database, fact);
			const afterSequence =
				response.facts.at(-1)?.sequence ?? parsedRequest.data.afterSequence;
			database.run(
				`UPDATE meta SET authority_lifetime = ?,
					erased_authority_lifetime = NULL, after_sequence = ?
				WHERE singleton = 1`,
				[response.authorityLifetime, afterSequence],
			);
		});
	}

	function settle(rawResponse: SubmissionResponse): void {
		database.transaction(() => {
			const meta = readMeta(database);
			if (
				meta.sealed_submission === null ||
				meta.sealed_request === null ||
				meta.sealed_request_hash === null ||
				meta.authority_lifetime === null
			) {
				throw new Error('nothing sealed');
			}
			if (rawResponse.authorityLifetime !== meta.authority_lifetime) {
				throw new Error('lifetime mismatch: erase and reacquire instead');
			}
			const parsedRequest = parseSubmissionRequest(
				JSON.parse(meta.sealed_request),
				limits,
			);
			if (parsedRequest.error !== null) {
				throw new Error('persisted sealed request is invalid');
			}
			const request = parsedRequest.data;
			if (
				canonicalize(request) !== meta.sealed_request ||
				sha256Hex(meta.sealed_request) !== meta.sealed_request_hash
			) {
				throw new Error('persisted sealed request witness is corrupt');
			}
			const admitted = admitSettlement(
				rawResponse,
				request,
				{
					authorityLifetime: meta.authority_lifetime,
					sealedSubmission:
						meta.sealed_submission === request.submissionNumber
							? request
							: undefined,
				},
				limits,
			);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const response = admitted.data;
			const parkedPlans = response.parked.map((parked: ParkedIntent) => {
				const row = readRecord(database, parked.address);
				if (row?.sealed_op === null || row?.sealed_op === undefined) {
					throw new Error('parked result for an address with nothing sealed');
				}
				return {
					parked,
					refused: decodeOperation(row.sealed_op, row.sealed_args),
					pending:
						row.pending_op === null
							? undefined
							: decodeOperation(row.pending_op, row.pending_args),
				};
			});

			for (const fact of response.facts) installFact(database, fact);
			database.run(
				`UPDATE records SET sealed_op = NULL, sealed_args = NULL
				WHERE sealed_op IS NOT NULL`,
			);
			for (const plan of parkedPlans) {
				if (
					readRecord(database, plan.parked.address)?.confirmed_state ===
					'tombstone'
				) {
					continue;
				}
				if (plan.pending !== undefined) {
					const outcome = composeOperations(plan.refused, plan.pending);
					if (outcome.kind === 'refused') {
						throw new Error(`parked compaction refused: ${outcome.code}`);
					}
					database.run(
						`UPDATE records SET pending_op = ?, pending_args = ?
						WHERE ${TRIPLE_WHERE}`,
						[
							outcome.operation.op,
							operationArgs(outcome.operation),
							...tripleParams(plan.parked.address),
						],
					);
					continue;
				}
				database.run(
					`UPDATE records SET
						parked_op = ?,
						parked_args = ?,
						parked_code = ?,
						parked_measured = ?,
						parked_limit = ?
					WHERE ${TRIPLE_WHERE}`,
					[
						plan.refused.op,
						operationArgs(plan.refused),
						plan.parked.code,
						plan.parked.code === 'fact-too-large'
							? plan.parked.measuredBytes
							: null,
						plan.parked.code === 'fact-too-large'
							? plan.parked.limitBytes
							: null,
						...tripleParams(plan.parked.address),
					],
				);
			}
			database.run(
				`UPDATE meta SET
					sealed_submission = NULL,
					sealed_request = NULL,
					sealed_request_hash = NULL,
					next_submission = next_submission + 1
				WHERE singleton = 1`,
			);
		});
	}

	function erase(): void {
		database.transaction(() => {
			database.run('DELETE FROM record_documents');
			database.run('DELETE FROM document_inflight');
			database.run('DELETE FROM records');
			database.run(
				`UPDATE meta SET
					erased_authority_lifetime = COALESCE(
						authority_lifetime, erased_authority_lifetime
					),
					authority_lifetime = NULL,
					after_sequence = 0,
					sealed_submission = NULL,
					sealed_request = NULL,
					sealed_request_hash = NULL,
					next_submission = 1
				WHERE singleton = 1`,
			);
		});
	}

	return {
		record,
		sync,
		sealedRequest,
		localWrite,
		seal,
		reconstructSealedRequest,
		installFacts,
		settle,
		erase,
		appendLocalDocumentUpdate: documents.appendLocal,
		installAcceptedDocumentUpdate: documents.installAccepted,
		inspectDocument: documents.inspect,
		exportDocument: documents.exportDocument,
		documentPublication: documents.publication,
		settleDocumentPublication: documents.settle,
		measureDocument: documents.measure,
	};
}

export type ReplicaStore = ReturnType<typeof openReplicaStore>;
