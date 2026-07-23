import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';

import { isBlobDigest } from '../../blob-v1/index.js';
import type { LensDefinition } from '../../lens.js';
import {
	type ProposalSelection,
	type ProposalSourceRecord,
	writeProposalArtifact,
} from '../../proposal-artifact.js';
import {
	type AdmittedSubmissionRequest,
	admitFactsPage,
	admitSettlement,
	canonicalize,
	composeOperations,
	type Fact,
	type FactsRequest,
	type FactsResponse,
	foldIntent,
	type Intent,
	type JsonValue,
	type Operation,
	type ParkedIntent,
	parseAddress,
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
	replicaStoreSchemaMatches,
} from './schema.js';
import {
	type SnapshotArtifactMetadata,
	type SnapshotArtifactRecord,
	writeSnapshotArtifact,
} from './snapshot-artifact.js';

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';

export const PUBLICATION_OBLIGATION_PAGE_LIMIT = 64;

export const OWED_DOCUMENTS_SQL = `SELECT namespace, collection, record_key
	FROM records
	WHERE document_revision > document_accepted_revision
		AND document_refused_revision IS NULL
	ORDER BY namespace, collection, record_key
	LIMIT ?`;

export const OWED_BLOBS_SQL = `SELECT namespace, collection, record_key
	FROM records
	WHERE blob_sha256 IS NOT NULL AND
		(blob_accepted_sha256 IS NULL OR blob_accepted_sha256 != blob_sha256)
		AND blob_parked_code IS NULL
	ORDER BY namespace, collection, record_key
	LIMIT ?`;
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
	attached_deployment: string | null;
	attached_principal: string | null;
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

export type ReplicaSourceFence = Pick<
	ReplicaStoreSync,
	'replicaId' | 'authorityLifetime'
>;

export type FencedLocalWrite = {
	sourceFence: ReplicaSourceFence;
	intent: Intent;
	expectAbsent?: boolean;
};

export type ReplicaAttachment = {
	deploymentId: string;
	principalId: string;
};

export type FirstAttachmentChoice = 'bring' | 'discard';

export type ReplicaAttachmentState =
	| { kind: 'unattached'; requiresChoice: boolean }
	| { kind: 'attached'; attachment: ReplicaAttachment };

export type ReplicaVisibleRecord =
	| { state: 'live'; payload: JsonValue }
	| { state: 'tombstone' | 'unset' };

export type ReplicaVisibleRecordEntry = {
	address: RecordAddress;
	record: ReplicaVisibleRecord;
};

export type ReplicaVisibleRecordPage = {
	entries: ReplicaVisibleRecordEntry[];
	nextAfter?: string;
};

export type ReplicaWorkSummary = {
	scalar: { pending: number; sealed: number; parked: number };
	document: { pending: number; parked: number };
	blob: { pending: number; parked: number };
};

export type ReplicaParkedWork = {
	address: RecordAddress;
	scalar: ReplicaRecordLanes['parked'];
	document:
		| {
				code: 'document-bound';
				measuredBytes: number;
				measuredStructs: number;
				limitBytes: number;
				limitStructs: number;
		  }
		| {
				code: 'record-not-live';
				state: 'absent' | 'tombstone' | 'unset';
		  }
		| null;
	blob: { code: 'blob-conflict' | 'record-not-live' } | null;
};

export type ReplicaParkedWorkPage = {
	entries: ReplicaParkedWork[];
	nextAfter?: RecordAddress;
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

export type CaptureReplicaSnapshotOptions = {
	database: SqliteDatabase;
	lens?: LensDefinition;
};

export type CaptureReplicaProposalOptions = {
	database: SqliteDatabase;
	hmacKey: Uint8Array;
	proposalId: string;
	lens: LensDefinition;
	selection: ProposalSelection;
};

function tripleParams(address: RecordAddress): [string, string, string] {
	return [address.namespace, address.collection, address.recordKey];
}

function addressIdentity(address: RecordAddress): string {
	return canonicalize(address);
}

function assertAttachment(attachment: ReplicaAttachment): void {
	if (attachment.principalId.length === 0) {
		throw new Error('attachment principal ID must not be empty');
	}
	try {
		if (new URL(attachment.deploymentId).href !== attachment.deploymentId) {
			throw new Error('not canonical');
		}
	} catch {
		throw new Error('attachment deployment ID must be a canonical URL');
	}
}

function owedAddresses(
	database: SqliteDatabase,
	sql: string,
	limit: number,
): RecordAddress[] {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > PUBLICATION_OBLIGATION_PAGE_LIMIT
	) {
		throw new TypeError(
			`publication obligation limit must be between 1 and ${PUBLICATION_OBLIGATION_PAGE_LIMIT}`,
		);
	}
	return database
		.all<
			SqliteRow & {
				namespace: string;
				collection: string;
				record_key: string;
			}
		>(sql, [limit])
		.map((row) => ({
			namespace: row.namespace,
			collection: row.collection,
			recordKey: row.record_key,
		}));
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

function operationIntent(address: RecordAddress, operation: Operation): Intent {
	return { address, ...operation };
}

function visibleOf(
	address: RecordAddress,
	lanes: ReplicaRecordLanes | null,
): ReplicaVisibleRecord | null {
	if (lanes === null) return null;
	let current: Fact | undefined =
		lanes.confirmed === null
			? undefined
			: lanes.confirmed.state === 'live'
				? {
						address,
						sequence: lanes.confirmed.sequence,
						state: 'live',
						payload: lanes.confirmed.payload as JsonValue,
					}
				: {
						address,
						sequence: lanes.confirmed.sequence,
						state: lanes.confirmed.state,
					};
	const operations =
		lanes.parked === null
			? [lanes.sealed, lanes.pending]
			: [lanes.parked.operation];
	for (const operation of operations) {
		if (operation === null) continue;
		const outcome = foldIntent(
			current,
			operationIntent(address, operation),
			(current?.sequence ?? 0) + 1,
		);
		if (outcome.kind === 'changed') current = outcome.fact;
		// A locally visible parked patch can be impossible to project over the
		// accepted scalar base. Keep the accepted value visible while `record()`
		// exposes the complete refused desire and diagnostic.
	}
	if (current === undefined) return null;
	return current.state === 'live'
		? { state: 'live', payload: structuredClone(current.payload) }
		: { state: current.state };
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
				blob_accepted_sha256 = NULL,
				blob_parked_code = NULL,
				document_revision = 0,
				document_accepted_revision = 0,
				document_refused_revision = NULL,
				document_refused_bytes = NULL,
				document_refused_structs = NULL
			WHERE ${TRIPLE_WHERE}`,
			[fact.sequence, ...tripleParams(fact.address)],
		);
		database.run(
			`DELETE FROM record_documents WHERE record_id =
				(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
			tripleParams(fact.address),
		);
		return;
	}

	database.run(
		`UPDATE records SET
			confirmed_state = ?,
			confirmed_payload = ?,
			confirmed_sequence = ?,
			blob_parked_code = CASE
				WHEN ? = 'live' AND blob_parked_code = 'record-not-live' THEN NULL
				ELSE blob_parked_code
			END
		WHERE ${TRIPLE_WHERE}`,
		[
			fact.state,
			payload,
			fact.sequence,
			fact.state,
			...tripleParams(fact.address),
		],
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
			actual.some((entry, index) => entry !== expected[index]) ||
			!replicaStoreSchemaMatches(database)
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
	const listeners = new Set<(addresses: readonly RecordAddress[]) => void>();

	function notify(addresses: readonly RecordAddress[]): void {
		if (addresses.length === 0) return;
		const unique = new Map<string, RecordAddress>();
		for (const address of addresses) {
			unique.set(addressIdentity(address), structuredClone(address));
		}
		const changes = [...unique.values()];
		for (const listener of listeners) listener(changes);
	}

	function record(address: RecordAddress): ReplicaRecordLanes | null {
		return lanesOf(readRecord(database, address));
	}

	function visible(address: RecordAddress): ReplicaVisibleRecord | null {
		return visibleOf(address, record(address));
	}

	function visibleRecords(
		namespace: string,
		collection: string,
		after?: string,
		limit = 100,
	): ReplicaVisibleRecordPage {
		const boundary = parseAddress(
			{ namespace, collection, recordKey: after ?? 'cursor' },
			limits,
		);
		if (boundary.error !== null) {
			throw new Error('visible record traversal address is invalid');
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error('visible record traversal limit must be 1 through 1000');
		}
		const parameters: (string | number)[] = [namespace, collection];
		const cursor = after === undefined ? '' : ' AND record_key > ?';
		if (after !== undefined) parameters.push(after);
		parameters.push(limit + 1);
		const rows = database.all<
			RecordRow & { namespace: string; collection: string; record_key: string }
		>(
			`SELECT * FROM records
			WHERE namespace = ? AND collection = ?${cursor}
			ORDER BY record_key LIMIT ?`,
			parameters,
		);
		const hasNext = rows.length > limit;
		const pageRows = hasNext ? rows.slice(0, limit) : rows;
		const entries: ReplicaVisibleRecordEntry[] = [];
		for (const row of pageRows) {
			const address = {
				namespace: row.namespace,
				collection: row.collection,
				recordKey: row.record_key,
			};
			const projected = visibleOf(address, lanesOf(row));
			if (projected !== null) entries.push({ address, record: projected });
		}
		const last = pageRows.at(-1);
		return {
			entries,
			...(hasNext && last !== undefined ? { nextAfter: last.record_key } : {}),
		};
	}

	function workSummary(): ReplicaWorkSummary {
		const row = one<
			SqliteRow & {
				scalar_pending: number;
				scalar_sealed: number;
				scalar_parked: number;
				document_pending: number;
				document_parked: number;
				blob_pending: number;
				blob_parked: number;
			}
		>(
			database,
			`SELECT
				count(*) FILTER (WHERE pending_op IS NOT NULL) AS scalar_pending,
				count(*) FILTER (WHERE sealed_op IS NOT NULL) AS scalar_sealed,
				count(*) FILTER (WHERE parked_op IS NOT NULL) AS scalar_parked,
				count(*) FILTER (WHERE doc_dirty = 1 AND NOT EXISTS (
					SELECT 1 FROM document_inflight i
					WHERE i.record_id = records.record_id AND i.parked_code IS NOT NULL
				)) AS document_pending,
				count(*) FILTER (WHERE EXISTS (
					SELECT 1 FROM document_inflight i
					WHERE i.record_id = records.record_id AND i.parked_code IS NOT NULL
				)) AS document_parked,
				count(*) FILTER (WHERE blob_pending = 1 AND blob_parked_code IS NULL)
					AS blob_pending,
				count(*) FILTER (WHERE blob_parked_code IS NOT NULL) AS blob_parked
			FROM records`,
		);
		if (row === null) throw new Error('replica work summary failed');
		return {
			scalar: {
				pending: row.scalar_pending,
				sealed: row.scalar_sealed,
				parked: row.scalar_parked,
			},
			document: {
				pending: row.document_pending,
				parked: row.document_parked,
			},
			blob: { pending: row.blob_pending, parked: row.blob_parked },
		};
	}

	function publicationAddresses(
		plane: 'document' | 'blob',
		limit = 32,
	): RecordAddress[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error('publication address limit must be 1 through 1000');
		}
		const predicate =
			plane === 'document'
				? `doc_dirty = 1 AND NOT EXISTS (
					SELECT 1 FROM document_inflight i
					WHERE i.record_id = records.record_id AND i.parked_code IS NOT NULL
				)`
				: 'blob_pending = 1 AND blob_parked_code IS NULL';
		return database
			.all<
				SqliteRow & {
					namespace: string;
					collection: string;
					record_key: string;
				}
			>(
				`SELECT namespace, collection, record_key FROM records
				WHERE ${predicate}
				ORDER BY namespace, collection, record_key LIMIT ?`,
				[limit],
			)
			.map((row) => ({
				namespace: row.namespace,
				collection: row.collection,
				recordKey: row.record_key,
			}));
	}

	function parkedWork(
		after?: RecordAddress,
		limit = 100,
	): ReplicaParkedWorkPage {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error('parked work limit must be 1 through 1000');
		}
		if (after !== undefined) {
			const parsed = parseAddress(after, limits);
			if (parsed.error !== null)
				throw new Error('parked work cursor is invalid');
		}
		const parameters: (string | number)[] = [];
		const cursor =
			after === undefined
				? ''
				: `AND (r.namespace > ?
					OR (r.namespace = ? AND r.collection > ?)
					OR (r.namespace = ? AND r.collection = ? AND r.record_key > ?))`;
		if (after !== undefined) {
			parameters.push(
				after.namespace,
				after.namespace,
				after.collection,
				after.namespace,
				after.collection,
				after.recordKey,
			);
		}
		parameters.push(limit + 1);
		const rows = database.all<
			RecordRow & {
				namespace: string;
				collection: string;
				record_key: string;
				document_code: 'document-bound' | 'record-not-live' | null;
				document_state: 'absent' | 'tombstone' | 'unset' | null;
				document_measured_bytes: number | null;
				document_measured_structs: number | null;
				document_limit_bytes: number | null;
				document_limit_structs: number | null;
				blob_parked_code: 'blob-conflict' | 'record-not-live' | null;
			}
		>(
			`SELECT r.*,
				i.parked_code AS document_code,
				i.parked_state AS document_state,
				i.measured_bytes AS document_measured_bytes,
				i.measured_structs AS document_measured_structs,
				i.limit_bytes AS document_limit_bytes,
				i.limit_structs AS document_limit_structs
			FROM records r
			LEFT JOIN document_inflight i ON i.record_id = r.record_id
			WHERE (r.parked_op IS NOT NULL OR r.blob_parked_code IS NOT NULL
				OR i.parked_code IS NOT NULL) ${cursor}
			ORDER BY r.namespace, r.collection, r.record_key LIMIT ?`,
			parameters,
		);
		const hasNext = rows.length > limit;
		const pageRows = hasNext ? rows.slice(0, limit) : rows;
		const entries = pageRows.map((row): ReplicaParkedWork => {
			const address = {
				namespace: row.namespace,
				collection: row.collection,
				recordKey: row.record_key,
			};
			const document =
				row.document_code === null
					? null
					: row.document_code === 'record-not-live'
						? row.document_state === null
							? (() => {
									throw new Error('parked document record state is corrupt');
								})()
							: { code: row.document_code, state: row.document_state }
						: row.document_measured_bytes === null ||
								row.document_measured_structs === null ||
								row.document_limit_bytes === null ||
								row.document_limit_structs === null
							? (() => {
									throw new Error('parked document measurements are corrupt');
								})()
							: {
									code: row.document_code,
									measuredBytes: row.document_measured_bytes,
									measuredStructs: row.document_measured_structs,
									limitBytes: row.document_limit_bytes,
									limitStructs: row.document_limit_structs,
								};
			return {
				address,
				scalar: lanesOf(row)?.parked ?? null,
				document,
				blob:
					row.blob_parked_code === null ? null : { code: row.blob_parked_code },
			};
		});
		return {
			entries,
			...(hasNext && entries.length > 0
				? { nextAfter: entries.at(-1)?.address }
				: {}),
		};
	}

	function attachment(): ReplicaAttachmentState {
		const meta = readMeta(database);
		if (meta.attached_deployment !== null && meta.attached_principal !== null) {
			return {
				kind: 'attached',
				attachment: {
					deploymentId: meta.attached_deployment,
					principalId: meta.attached_principal,
				},
			};
		}
		const count = one<SqliteRow & { count: number }>(
			database,
			'SELECT count(*) AS count FROM records',
		)?.count;
		return { kind: 'unattached', requiresChoice: (count ?? 0) > 0 };
	}

	function attach(
		next: ReplicaAttachment,
		choice?: FirstAttachmentChoice,
	): { attached: boolean; discarded: boolean } {
		assertAttachment(next);
		if (choice !== undefined && choice !== 'bring' && choice !== 'discard') {
			throw new Error('first attachment choice must be bring or discard');
		}
		const changed: RecordAddress[] = [];
		const result = database.transaction(() => {
			const meta = readMeta(database);
			if (
				meta.attached_deployment !== null &&
				meta.attached_principal !== null
			) {
				if (
					meta.attached_deployment === next.deploymentId &&
					meta.attached_principal === next.principalId
				) {
					return { attached: false, discarded: false };
				}
				throw new Error('replica is permanently attached to another principal');
			}
			const rows = database.all<
				SqliteRow & {
					namespace: string;
					collection: string;
					record_key: string;
				}
			>('SELECT namespace, collection, record_key FROM records');
			const nonempty = rows.length > 0;
			if (nonempty && choice === undefined) {
				throw new Error('nonempty replica requires bring or discard');
			}
			if (nonempty && choice === 'discard') {
				for (const row of rows) {
					changed.push({
						namespace: row.namespace,
						collection: row.collection,
						recordKey: row.record_key,
					});
				}
				database.run('DELETE FROM record_documents');
				database.run('DELETE FROM document_inflight');
				database.run('DELETE FROM records');
				database.run(
					`UPDATE meta SET
						attached_deployment = ?, attached_principal = ?,
						authority_lifetime = NULL,
						erased_authority_lifetime = NULL,
						after_sequence = 0,
						sealed_submission = NULL,
						sealed_request = NULL,
						sealed_request_hash = NULL,
						next_submission = 1
					WHERE singleton = 1`,
					[next.deploymentId, next.principalId],
				);
				return { attached: true, discarded: true };
			}
			database.run(
				`UPDATE meta SET attached_deployment = ?, attached_principal = ?
				WHERE singleton = 1`,
				[next.deploymentId, next.principalId],
			);
			return { attached: true, discarded: false };
		});
		notify(changed);
		return result;
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

	function writeLocalIntent(intent: Intent): void {
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
					blob_parked_code = NULL,
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
		if (
			outcome.operation.op === 'patch' ||
			outcome.operation.op === 'replace'
		) {
			database.run(
				`DELETE FROM document_inflight
					WHERE parked_code = 'record-not-live' AND record_id =
						(SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
				tripleParams(intent.address),
			);
		}
	}

	function localWrite(rawIntent: Intent): void {
		const { data: intent, error } = parseIntent(rawIntent, limits);
		if (error !== null) throw new Error(error.message);
		database.transaction(() => writeLocalIntent(intent));
		notify([intent.address]);
	}

	/**
	 * Admit one Proposal manifest change without creating a second durable lane.
	 * The source check and ordinary local write share one SQLite transaction so
	 * Restore or replica remint cannot enter between them.
	 */
	function admitFencedLocalWrite({
		sourceFence,
		intent: rawIntent,
		expectAbsent = false,
	}: FencedLocalWrite): void {
		const { data: intent, error } = parseIntent(rawIntent, limits);
		if (error !== null) throw new Error(error.message);
		if (expectAbsent && intent.op !== 'replace') {
			throw new Error('Proposal creation must be a replace');
		}
		const expectedCreation =
			expectAbsent && intent.op === 'replace'
				? canonicalize(intent.value)
				: undefined;
		database.transaction(() => {
			const meta = readMeta(database);
			if (
				meta.replica_id !== sourceFence.replicaId ||
				meta.authority_lifetime !== sourceFence.authorityLifetime
			) {
				throw new Error('Proposal source fence does not match this replica');
			}
			const row = readRecord(database, intent.address);
			if (row === null) {
				writeLocalIntent(intent);
				return;
			}
			const terminal =
				row.confirmed_state === 'tombstone' ||
				row.sealed_op === 'tombstone' ||
				row.pending_op === 'tombstone';
			if (terminal) return;
			if (expectedCreation !== undefined) {
				const current = visibleOf(intent.address, lanesOf(row));
				if (
					current?.state === 'live' &&
					canonicalize(current.payload) === expectedCreation
				) {
					return;
				}
				throw new Error('Proposal-created record key collision');
			}
			writeLocalIntent(intent);
		});
		notify([intent.address]);
	}

	/**
	 * Admit one newly minted live record and its already-promoted blob as one
	 * SQLite fact. The caller owns file staging and debris recovery.
	 */
	function admitLocalRecordWithBlob({
		address,
		payload,
		digest,
	}: {
		address: RecordAddress;
		payload: Record<string, JsonValue>;
		digest: string;
	}): void {
		const parsed = parseIntent(
			{ address, op: 'patch', set: payload, unset: [] },
			limits,
		);
		if (parsed.error !== null) throw new Error(parsed.error.message);
		if (!isBlobDigest(digest)) throw new TypeError('invalid blob digest');
		const operation = intentOperation(parsed.data);
		database.transaction(() => {
			if (readRecord(database, parsed.data.address) !== null) {
				throw new Error('record address is already occupied');
			}
			database.run(
				`INSERT INTO records (
					namespace, collection, record_key, pending_op, pending_args,
					blob_sha256, blob_accepted_sha256, blob_parked_code
				) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
				[
					...tripleParams(parsed.data.address),
					operation.op,
					operationArgs(operation),
					digest,
				],
			);
		});
		notify([parsed.data.address]);
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
		notify(page.response.facts.map((fact) => fact.address));
	}

	function settle(rawResponse: SubmissionResponse): void {
		const changed: RecordAddress[] = [];
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
			changed.push(...request.intents.map((intent) => intent.address));
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
		notify(changed);
	}

	function erase(): void {
		const changed = database.all<
			SqliteRow & { namespace: string; collection: string; record_key: string }
		>('SELECT namespace, collection, record_key FROM records');
		database.transaction(() => {
			database.run('DELETE FROM record_documents');
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
		notify(
			changed.map((row) => ({
				namespace: row.namespace,
				collection: row.collection,
				recordKey: row.record_key,
			})),
		);
	}

	function captureSnapshot({
		database: target,
		lens,
	}: CaptureReplicaSnapshotOptions): SnapshotArtifactMetadata {
		return database.readTransaction(() => {
			const meta = readMeta(database);

			function* records(): Generator<SnapshotArtifactRecord> {
				let afterRecordId = 0;
				while (true) {
					const rows = database.all<
						RecordRow & {
							record_id: number;
							namespace: string;
							collection: string;
							record_key: string;
							doc_revision: number;
							doc_dirty: number;
							blob_sha256: string | null;
							document_byte_length: number;
						}
					>(
						`SELECT r.*, COALESCE((
							SELECT sum(length(d.bytes)) FROM record_documents d
							WHERE d.record_id = r.record_id
						), 0) AS document_byte_length
						FROM records r
						WHERE r.record_id > ?
						ORDER BY r.record_id LIMIT 1000`,
						[afterRecordId],
					);
					for (const row of rows) {
						const address = {
							namespace: row.namespace,
							collection: row.collection,
							recordKey: row.record_key,
						};
						const visible = visibleOf(address, lanesOf(row));
						if (visible?.state !== 'live') continue;
						yield {
							...address,
							payload: visible.payload,
							documentRevision: row.doc_revision,
							documentByteLength: row.document_byte_length,
							documentDirty: row.doc_dirty === 1,
							blobSha256: row.blob_sha256,
						};
					}
					const last = rows.at(-1);
					if (last === undefined || rows.length < 1000) return;
					afterRecordId = last.record_id;
				}
			}
			return writeSnapshotArtifact({
				database: target,
				sourceAuthorityLifetime: meta.authority_lifetime,
				sourceAuthorityAfterSequence: meta.after_sequence,
				records: records(),
				...(lens === undefined ? {} : { lens }),
			});
		});
	}

	function captureProposal({
		database: target,
		hmacKey,
		proposalId,
		lens,
		selection,
	}: CaptureReplicaProposalOptions): void {
		database.readTransaction(() => {
			const meta = readMeta(database);
			function* records(): Generator<ProposalSourceRecord> {
				for (const [collection, selected] of Object.entries(
					selection.collections,
				)) {
					for (const recordKey of selected.recordKeys) {
						const address = {
							namespace: selection.namespace,
							collection,
							recordKey,
						};
						const current = visible(address);
						yield current?.state === 'live'
							? { address, state: 'live', payload: current.payload }
							: { address, state: 'absent' };
					}
				}
			}
			writeProposalArtifact({
				database: target,
				hmacKey,
				proposalId,
				sourceReplicaId: meta.replica_id,
				sourceAuthorityLifetime: meta.authority_lifetime,
				lens,
				selection,
				records: records(),
			});
		});
	}

	return {
		record,
		visible,
		visibleRecords,
		workSummary,
		publicationAddresses,
		parkedWork,
		attachment,
		attach,
		subscribe(listener: (addresses: readonly RecordAddress[]) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sync,
		sealedRequest,
		localWrite,
		admitFencedLocalWrite,
		admitLocalRecordWithBlob,
		seal,
		reconstructSealedRequest,
		installFacts,
		settle,
		erase,
		captureSnapshot,
		captureProposal,
		appendLocalDocumentUpdate(address: RecordAddress, update: Uint8Array) {
			documents.appendLocal(address, update);
			notify([address]);
		},
		installAcceptedDocumentUpdate(address: RecordAddress, update: Uint8Array) {
			documents.installAccepted(address, update);
			notify([address]);
		},
		inspectDocument: documents.inspect,
		exportDocument: documents.exportDocument,
		documentPublication(
			address: RecordAddress,
			authorityStateVector?: Uint8Array,
		) {
			const state = documents.publication(address, authorityStateVector);
			notify([address]);
			return state;
		},
		settleDocumentPublication(
			address: RecordAddress,
			proof: Parameters<typeof documents.settle>[1],
		) {
			documents.settle(address, proof);
			notify([address]);
		},
		measureDocument: documents.measure,
	};
}

export type ReplicaStore = ReturnType<typeof openReplicaStore>;
