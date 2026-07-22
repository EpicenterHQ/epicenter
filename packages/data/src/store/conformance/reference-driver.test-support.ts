/**
 * Test-only reference drivers binding the conformance schemas to the shared
 * V1 kernel (ADR-0163, ADR-0177).
 *
 * Each transition is expressed as an explicit statement list computed from the
 * current store state, so the harness can commit it atomically or crash it at
 * any statement boundary. Every piece of protocol semantics is delegated to
 * the kernel: pending compaction and parked consumption use
 * `composeOperations`, authority adjudication uses `foldIntent`, sealing
 * admits the request through `parseSubmissionRequest` and persists its exact
 * RFC 8785 canonical bytes and SHA-256 hash, and monotonic fact installation
 * follows ADR-0163's per-address rule. The drivers are oracles for the
 * maintained cases, not product stores; W1B, W2, and W3 bind the same cases
 * to production adapters.
 */
import {
	canonicalize,
	composeOperations,
	encodedFactBytes,
	type Fact,
	foldIntent,
	type Intent,
	type JsonValue,
	type Operation,
	type ParkedIntent,
	parseSubmissionRequest,
	type RecordAddress,
	type SubmissionRequest,
	type SubmissionResponse,
	sha256Hex,
	type ValidatedLimits,
} from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { ReferenceDb, type Statement } from './reference-store.test-support.js';
import type {
	ConformanceReplica,
	CrashedReplica,
	RecordLanes,
	ReplicaConformanceBinding,
	ReplicaObservations,
	ReplicaTransition,
} from './replica-cases.test-support.js';

export const LIMITS: ValidatedLimits = makeLimits();

const TRIPLE_WHERE = 'namespace = ? AND collection = ? AND record_key = ?';
const tripleParams = (address: RecordAddress): [string, string, string] => [
	address.namespace,
	address.collection,
	address.recordKey,
];

type LaneRow = {
	confirmed_state: string | null;
	confirmed_payload: string | null;
	confirmed_sequence: number | null;
	sealed_op: string | null;
	sealed_args: string | null;
	pending_op: string | null;
	pending_args: string | null;
	parked_op: string | null;
	parked_args: string | null;
	parked_code: string | null;
	parked_measured: number | null;
	parked_limit: number | null;
	blob_sha256: string | null;
	blob_pending: number;
};

type ReplicaMeta = {
	replica_id: string;
	authority_lifetime: string | null;
	after_sequence: number;
	sealed_submission: number | null;
	sealed_request: string | null;
	sealed_request_hash: string | null;
	next_submission: number;
};

/** Encode one operation into its lane column pair. */
const laneArgs = (operation: Operation): string | null => {
	if (operation.op === 'patch') {
		return canonicalize({ set: operation.set, unset: operation.unset });
	}
	if (operation.op === 'replace') return canonicalize(operation.value);
	return null;
};

/** Decode a lane column pair back into an operation. */
const laneOperation = (op: string, args: string | null): Operation => {
	if (op === 'patch') {
		const parsed = JSON.parse(args ?? '') as {
			set: Record<string, JsonValue>;
			unset: string[];
		};
		return { op: 'patch', set: parsed.set, unset: parsed.unset };
	}
	if (op === 'replace') {
		return { op: 'replace', value: JSON.parse(args ?? '') as JsonValue };
	}
	if (op === 'tombstone') return { op: 'tombstone' };
	if (op === 'unset') return { op: 'unset' };
	throw new Error(`unknown lane operation ${op}`);
};

export class ReplicaRef {
	constructor(readonly store: ReferenceDb) {}

	static create(fixture: {
		replicaId: string;
		authorityLifetime?: string;
	}): ReplicaRef {
		const store = ReferenceDb.create('replica');
		store.run({
			sql: `INSERT INTO meta (singleton, format_version, replica_id, authority_lifetime)
			      VALUES (1, 1, ?, ?)`,
			params: [fixture.replicaId, fixture.authorityLifetime ?? null],
		});
		return new ReplicaRef(store);
	}

	record(address: RecordAddress): LaneRow | null {
		return this.store.get<LaneRow>(
			`SELECT * FROM records WHERE ${TRIPLE_WHERE}`,
			tripleParams(address),
		);
	}

	meta(): ReplicaMeta {
		const row = this.store.get<ReplicaMeta>(
			'SELECT * FROM meta WHERE singleton = 1',
		);
		if (row === null) throw new Error('replica meta row missing');
		return row;
	}

	/**
	 * One local write: fold the operation into the pending lane. A parked
	 * overlay is consumed by composing beneath the newer desire; existing
	 * pending desire compacts under the same one law. Emits a single statement,
	 * so the write transaction is exactly the compaction transaction (memo
	 * transitions 1 and 2 share it).
	 */
	localWriteStatements(intent: Intent): Statement[] {
		const row = this.record(intent.address);
		const operation: Operation = intentOperation(intent);
		if (row === null) {
			return [
				{
					sql: `INSERT INTO records (namespace, collection, record_key, pending_op, pending_args)
					      VALUES (?, ?, ?, ?, ?)`,
					params: [
						...tripleParams(intent.address),
						operation.op,
						laneArgs(operation),
					],
				},
			];
		}
		// A confirmed tombstone supersedes local desire; the typed API never
		// reaches here, so the reference driver refuses loudly instead of
		// silently writing.
		if (row.confirmed_state === 'tombstone') {
			throw new Error('local write over a confirmed tombstone');
		}
		let composedWith: Operation | undefined;
		let consumesParked = false;
		if (row.parked_op !== null) {
			composedWith = laneOperation(row.parked_op, row.parked_args);
			consumesParked = true;
		} else if (row.pending_op !== null) {
			composedWith = laneOperation(row.pending_op, row.pending_args);
		}
		let next: Operation = operation;
		if (composedWith !== undefined) {
			const outcome = composeOperations(composedWith, operation);
			if (outcome.kind === 'refused') {
				throw new Error(`local compaction refused: ${outcome.code}`);
			}
			next = outcome.operation;
		}
		return [
			{
				sql: consumesParked
					? `UPDATE records SET pending_op = ?, pending_args = ?,
					     parked_op = NULL, parked_args = NULL, parked_code = NULL,
					     parked_measured = NULL, parked_limit = NULL
					   WHERE ${TRIPLE_WHERE}`
					: `UPDATE records SET pending_op = ?, pending_args = ? WHERE ${TRIPLE_WHERE}`,
				params: [next.op, laneArgs(next), ...tripleParams(intent.address)],
			},
		];
	}

	/**
	 * Sealing: move every pending operation to the sealed lane in canonical
	 * address order and persist the submission marker plus the exact canonical
	 * request bytes and their hash (ADR-0163). The request is admitted through
	 * the real kernel parser before its bytes are persisted.
	 */
	sealStatements(): {
		statements: Statement[];
		request: SubmissionRequest;
		requestBytes: string;
		requestHash: string;
	} {
		const meta = this.meta();
		if (meta.authority_lifetime === null) {
			throw new Error('cannot seal before lifetime binding');
		}
		if (meta.sealed_submission !== null) {
			throw new Error('one submission is already sealed');
		}
		const pendingRows = this.store.all<
			LaneRow & { namespace: string; collection: string; record_key: string }
		>(
			`SELECT * FROM records WHERE pending_op IS NOT NULL
			 ORDER BY namespace, collection, record_key`,
		);
		if (pendingRows.length === 0) throw new Error('nothing to seal');
		const intents: Intent[] = pendingRows.map((row) => ({
			address: {
				namespace: row.namespace,
				collection: row.collection,
				recordKey: row.record_key,
			},
			...laneOperation(row.pending_op as string, row.pending_args),
		}));
		const request: SubmissionRequest = {
			authorityLifetime: meta.authority_lifetime,
			replicaId: meta.replica_id,
			submissionNumber: meta.next_submission,
			intents,
		};
		const { data: admitted, error } = parseSubmissionRequest(request, LIMITS);
		if (error !== null)
			throw new Error(`seal admission failed: ${error.message}`);
		const requestBytes = canonicalize(admitted);
		const requestHash = sha256Hex(requestBytes);
		return {
			statements: [
				{
					sql: `UPDATE records SET sealed_op = pending_op, sealed_args = pending_args,
					        pending_op = NULL, pending_args = NULL
					      WHERE pending_op IS NOT NULL`,
				},
				{
					sql: `UPDATE meta SET sealed_submission = next_submission,
					        sealed_request = ?, sealed_request_hash = ?
					      WHERE singleton = 1`,
					params: [requestBytes, requestHash],
				},
			],
			request,
			requestBytes,
			requestHash,
		};
	}

	/** The persisted retry witness: exact first-seal bytes and hash. */
	sealedRequest(): { bytes: string; hash: string } | null {
		const meta = this.meta();
		if (meta.sealed_request === null || meta.sealed_request_hash === null) {
			return null;
		}
		return { bytes: meta.sealed_request, hash: meta.sealed_request_hash };
	}

	/**
	 * Debug assertion retained by ADR-0163: reconstructing the request from the
	 * sealed lanes under the same encoder must reproduce the persisted bytes.
	 * Retry itself always sends the persisted bytes.
	 */
	reconstructSealedRequest(): string {
		const meta = this.meta();
		if (meta.sealed_submission === null || meta.authority_lifetime === null) {
			throw new Error('nothing sealed');
		}
		const sealedRows = this.store.all<
			LaneRow & { namespace: string; collection: string; record_key: string }
		>(
			`SELECT * FROM records WHERE sealed_op IS NOT NULL
			 ORDER BY namespace, collection, record_key`,
		);
		const request: SubmissionRequest = {
			authorityLifetime: meta.authority_lifetime,
			replicaId: meta.replica_id,
			submissionNumber: meta.sealed_submission,
			intents: sealedRows.map((row) => ({
				address: {
					namespace: row.namespace,
					collection: row.collection,
					recordKey: row.record_key,
				},
				...laneOperation(row.sealed_op as string, row.sealed_args),
			})),
		};
		return canonicalize(request);
	}

	/** Monotonic confirmed-lane installation statements for one learned fact. */
	private installFactStatements(fact: Fact): Statement[] {
		const row = this.record(fact.address);
		const current = row?.confirmed_sequence ?? 0;
		if (fact.sequence < current) return []; // older: ignored
		if (fact.sequence === current && row !== null) {
			const identical =
				row.confirmed_state === fact.state &&
				(fact.state !== 'live' ||
					row.confirmed_payload === canonicalize(fact.payload));
			if (!identical) {
				throw new Error(
					'equal sequence with different content: replica corruption',
				);
			}
			return [];
		}
		const payload = fact.state === 'live' ? canonicalize(fact.payload) : null;
		if (row === null) {
			return [
				{
					sql: `INSERT INTO records (namespace, collection, record_key,
					        confirmed_state, confirmed_payload, confirmed_sequence)
					      VALUES (?, ?, ?, ?, ?, ?)`,
					params: [
						...tripleParams(fact.address),
						fact.state,
						payload,
						fact.sequence,
					],
				},
			];
		}
		if (fact.state === 'tombstone') {
			// A learned tombstone immediately removes every unsealed operation at
			// the address as superseded. The sealed lane stays immutable for exact
			// retry; it stops overlaying and retires at settlement. The same
			// transaction owns the record's terminal cleanup (ADR-0173, ADR-0174,
			// ADR-0177): it clears the blob evidence and explicitly deletes the
			// document chain and in-flight image, because no cascade exists and a
			// committed tombstone must never leave child rows alive.
			return [
				{
					sql: `UPDATE records SET confirmed_state = 'tombstone',
					        confirmed_payload = NULL, confirmed_sequence = ?,
					        pending_op = NULL, pending_args = NULL,
					        parked_op = NULL, parked_args = NULL, parked_code = NULL,
					        parked_measured = NULL, parked_limit = NULL,
					        blob_sha256 = NULL, blob_pending = 0, doc_dirty = 0
					      WHERE ${TRIPLE_WHERE}`,
					params: [fact.sequence, ...tripleParams(fact.address)],
				},
				{
					sql: `DELETE FROM record_documents WHERE record_id =
					        (SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
					params: tripleParams(fact.address),
				},
				{
					sql: `DELETE FROM document_inflight WHERE record_id =
					        (SELECT record_id FROM records WHERE ${TRIPLE_WHERE})`,
					params: tripleParams(fact.address),
				},
			];
		}
		return [
			{
				sql: `UPDATE records SET confirmed_state = ?, confirmed_payload = ?,
				        confirmed_sequence = ?
				      WHERE ${TRIPLE_WHERE}`,
				params: [
					fact.state,
					payload,
					fact.sequence,
					...tripleParams(fact.address),
				],
			},
		];
	}

	/**
	 * One facts-feed prefix installation: install every returned fact under the
	 * monotonic rule and advance the durable cursor, in one transaction. A
	 * fresh replica binds the lifetime in the same transaction.
	 */
	installFactsStatements(page: {
		authorityLifetime: string;
		facts: readonly Fact[];
		afterSequence: number;
	}): Statement[] {
		const meta = this.meta();
		if (
			meta.authority_lifetime !== null &&
			meta.authority_lifetime !== page.authorityLifetime
		) {
			throw new Error('lifetime mismatch: erase and reacquire instead');
		}
		const statements: Statement[] = [];
		for (const fact of page.facts) {
			statements.push(...this.installFactStatements(fact));
		}
		statements.push({
			sql: 'UPDATE meta SET authority_lifetime = ?, after_sequence = ? WHERE singleton = 1',
			params: [page.authorityLifetime, page.afterSequence],
		});
		return statements;
	}

	/**
	 * Settlement of the sealed submission: monotonic installation of every
	 * returned fact, sealed-lane retirement, parked results stored whole or
	 * compacted beneath newer pending desire, the tombstone-discards-parked
	 * rule, and the metadata bump that clears the persisted request bytes, all
	 * as one transaction.
	 */
	settleStatements(response: SubmissionResponse): Statement[] {
		const meta = this.meta();
		if (meta.sealed_submission === null) throw new Error('nothing sealed');
		const statements: Statement[] = [];
		// Remember each parked address's refused sealed operation and whether
		// newer pending desire exists, before any lane mutation.
		const parkedPlans = response.parked.map((parked: ParkedIntent) => {
			const row = this.record(parked.address);
			if (row?.sealed_op == null) {
				throw new Error('parked result for an address with nothing sealed');
			}
			return {
				parked,
				refused: laneOperation(row.sealed_op, row.sealed_args),
				pending:
					row.pending_op === null
						? undefined
						: laneOperation(row.pending_op, row.pending_args),
			};
		});
		for (const fact of response.facts) {
			statements.push(...this.installFactStatements(fact));
		}
		statements.push({
			sql: 'UPDATE records SET sealed_op = NULL, sealed_args = NULL WHERE sealed_op IS NOT NULL',
		});
		for (const plan of parkedPlans) {
			// After monotonic installation the stored confirmed fact decides: a
			// tombstone supersedes the parked operation and its diagnostic.
			const settledFact = response.facts.find(
				(fact) =>
					canonicalize(fact.address) === canonicalize(plan.parked.address),
			);
			const row = this.record(plan.parked.address);
			const storedTombstone =
				row?.confirmed_state === 'tombstone' ||
				(settledFact?.state === 'tombstone' &&
					settledFact.sequence >= (row?.confirmed_sequence ?? 0));
			if (storedTombstone) continue;
			if (plan.pending !== undefined) {
				// The parked operation is older than the newer pending desire:
				// compact beneath it and store no overlay.
				const outcome = composeOperations(plan.refused, plan.pending);
				if (outcome.kind === 'refused') {
					throw new Error(`parked compaction refused: ${outcome.code}`);
				}
				statements.push({
					sql: `UPDATE records SET pending_op = ?, pending_args = ? WHERE ${TRIPLE_WHERE}`,
					params: [
						outcome.operation.op,
						laneArgs(outcome.operation),
						...tripleParams(plan.parked.address),
					],
				});
				continue;
			}
			statements.push({
				sql: `UPDATE records SET parked_op = ?, parked_args = ?, parked_code = ?,
				        parked_measured = ?, parked_limit = ?
				      WHERE ${TRIPLE_WHERE}`,
				params: [
					plan.refused.op,
					laneArgs(plan.refused),
					plan.parked.code,
					plan.parked.code === 'fact-too-large'
						? plan.parked.measuredBytes
						: null,
					plan.parked.code === 'fact-too-large' ? plan.parked.limitBytes : null,
					...tripleParams(plan.parked.address),
				],
			});
		}
		statements.push({
			sql: `UPDATE meta SET sealed_submission = NULL, sealed_request = NULL,
			        sealed_request_hash = NULL, next_submission = next_submission + 1
			      WHERE singleton = 1`,
		});
		return statements;
	}

	/**
	 * Lifetime erase and reacquisition reset (ADR-0170): explicitly delete
	 * every sibling relation and all records, then reset synchronization
	 * metadata while keeping the attachment. Pending and sealed work of the
	 * superseded lifetime is intentionally abandoned.
	 */
	eraseStatements(): Statement[] {
		return [
			{ sql: 'DELETE FROM record_documents' },
			{ sql: 'DELETE FROM document_inflight' },
			{ sql: 'DELETE FROM records' },
			{
				sql: `UPDATE meta SET authority_lifetime = NULL, after_sequence = 0,
				        sealed_submission = NULL, sealed_request = NULL,
				        sealed_request_hash = NULL, next_submission = 1
				      WHERE singleton = 1`,
			},
		];
	}
}

const intentOperation = (intent: Intent): Operation => {
	if (intent.op === 'patch') {
		return { op: 'patch', set: intent.set, unset: intent.unset };
	}
	if (intent.op === 'replace') return { op: 'replace', value: intent.value };
	return { op: intent.op };
};

type AuthorityRecordRow = {
	namespace: string;
	collection: string;
	record_key: string;
	state: 'live' | 'tombstone' | 'unset';
	payload: string | null;
	sequence: number;
};

export class AuthorityRef {
	constructor(readonly store: ReferenceDb) {}

	static create(lifetime: string): AuthorityRef {
		const store = ReferenceDb.create('authority');
		store.run({
			sql: 'INSERT INTO meta (singleton, format_version, authority_lifetime, next_sequence) VALUES (1, 1, ?, 1)',
			params: [lifetime],
		});
		return new AuthorityRef(store);
	}

	currentFact(address: RecordAddress): Fact | undefined {
		const row = this.store.get<AuthorityRecordRow>(
			`SELECT * FROM records WHERE ${TRIPLE_WHERE}`,
			tripleParams(address),
		);
		if (row === null) return undefined;
		if (row.state === 'live') {
			return {
				address,
				sequence: row.sequence,
				state: 'live',
				payload: JSON.parse(row.payload ?? '') as JsonValue,
			};
		}
		return { address, sequence: row.sequence, state: row.state };
	}

	meta(): { authority_lifetime: string; next_sequence: number } {
		const row = this.store.get<{
			authority_lifetime: string;
			next_sequence: number;
		}>('SELECT * FROM meta WHERE singleton = 1');
		if (row === null) throw new Error('authority meta row missing');
		return row;
	}

	witness(replicaId: string): {
		submission_number: number;
		request_hash: string;
		parked: string;
	} | null {
		return this.store.get(
			'SELECT * FROM replica_witness WHERE replica_id = ?',
			[replicaId],
		);
	}

	/**
	 * One-transaction acceptance of a submission delivered as the replica's
	 * persisted canonical bytes: lifetime validation, witness admission
	 * (number, hash), the kernel fold per intent, sequence assignment, record
	 * upserts, `next_sequence`, and the witness upsert with bounded parked
	 * results (memo transition 5). An exact retry (same number, same hash) is
	 * answered from the witness without statements (memo transition 6); a
	 * reused number with different bytes is a fork. Like the pure protocol
	 * authority, a request bound to a different lifetime is terminally
	 * mismatched before any ledger logic runs: it is never adjudicated,
	 * retried, or classified as a fork or gap.
	 */
	acceptance(requestBytes: string):
		| {
				kind: 'accept';
				statements: Statement[];
				request: SubmissionRequest;
				parked: ParkedIntent[];
		  }
		| { kind: 'retry'; response: SubmissionResponse }
		| { kind: 'fork' | 'gap' | 'lifetime-mismatch' } {
		const { data: request, error } = parseSubmissionRequest(
			JSON.parse(requestBytes),
			LIMITS,
		);
		if (error !== null)
			throw new Error(`acceptance admission: ${error.message}`);
		if (request.authorityLifetime !== this.meta().authority_lifetime) {
			return { kind: 'lifetime-mismatch' };
		}
		const requestHash = sha256Hex(canonicalize(request));
		const witness = this.witness(request.replicaId);
		const lastNumber = witness?.submission_number ?? 0;
		if (witness !== null && request.submissionNumber === lastNumber) {
			if (requestHash !== witness.request_hash) return { kind: 'fork' };
			return {
				kind: 'retry',
				response: {
					authorityLifetime: this.meta().authority_lifetime,
					facts: request.intents.flatMap((intent) => {
						const fact = this.currentFact(intent.address);
						return fact === undefined ? [] : [fact];
					}),
					parked: JSON.parse(witness.parked) as ParkedIntent[],
				},
			};
		}
		if (request.submissionNumber !== lastNumber + 1) return { kind: 'gap' };

		const statements: Statement[] = [];
		let nextSequence = this.meta().next_sequence;
		const parked: ParkedIntent[] = [];
		const folded = new Map<string, Fact>();
		for (const intent of request.intents) {
			const key = canonicalize(intent.address);
			const current = folded.get(key) ?? this.currentFact(intent.address);
			const outcome = foldIntent(current, intent, nextSequence);
			if (outcome.kind === 'unchanged') continue;
			if (outcome.kind === 'refused') {
				parked.push({ address: intent.address, code: outcome.code });
				continue;
			}
			const measured = encodedFactBytes(outcome.fact);
			if (intent.op === 'patch' && measured > LIMITS.maxEncodedFactBytes) {
				parked.push({
					address: intent.address,
					code: 'fact-too-large',
					measuredBytes: measured,
					limitBytes: LIMITS.maxEncodedFactBytes,
				});
				continue;
			}
			folded.set(key, outcome.fact);
			const payload =
				outcome.fact.state === 'live'
					? canonicalize(outcome.fact.payload)
					: null;
			statements.push(
				current === undefined
					? {
							sql: `INSERT INTO records (namespace, collection, record_key, state, payload, sequence)
							      VALUES (?, ?, ?, ?, ?, ?)`,
							params: [
								...tripleParams(intent.address),
								outcome.fact.state,
								payload,
								nextSequence,
							],
						}
					: {
							sql: `UPDATE records SET state = ?, payload = ?, sequence = ? WHERE ${TRIPLE_WHERE}`,
							params: [
								outcome.fact.state,
								payload,
								nextSequence,
								...tripleParams(intent.address),
							],
						},
			);
			nextSequence += 1;
		}
		statements.push({
			sql: 'UPDATE meta SET next_sequence = ? WHERE singleton = 1',
			params: [nextSequence],
		});
		statements.push({
			sql: `INSERT INTO replica_witness (replica_id, submission_number, request_hash, parked)
			      VALUES (?, ?, ?, ?)
			      ON CONFLICT(replica_id) DO UPDATE SET
			        submission_number = excluded.submission_number,
			        request_hash = excluded.request_hash,
			        parked = excluded.parked`,
			params: [
				request.replicaId,
				request.submissionNumber,
				requestHash,
				canonicalize(parked),
			],
		});
		return { kind: 'accept', statements, request, parked };
	}

	/** The settlement response for an accepted (committed) submission. */
	responseFor(
		request: SubmissionRequest,
		parked: ParkedIntent[],
	): SubmissionResponse {
		return {
			authorityLifetime: this.meta().authority_lifetime,
			facts: request.intents.flatMap((intent) => {
				const fact = this.currentFact(intent.address);
				return fact === undefined ? [] : [fact];
			}),
			parked,
		};
	}
}

/**
 * The SQLite reference implementation bound to the reusable replica
 * conformance contract. Everything below is translation, not semantics: lane
 * columns decode to kernel operations and payload values, `meta` projects to
 * the sync view, statement lists become prepared transitions whose fault
 * boundaries are statement boundaries, and snapshots delegate to the store's
 * canonical logical-state serialization. W1B and W1C supply their own
 * `ReplicaConformanceBinding` against production adapters.
 */
const lanesOf = (row: LaneRow | null): RecordLanes | null => {
	if (row === null) return null;
	return {
		confirmed:
			row.confirmed_state === null || row.confirmed_sequence === null
				? null
				: {
						state: row.confirmed_state as 'live' | 'tombstone' | 'unset',
						...(row.confirmed_payload === null
							? {}
							: { payload: JSON.parse(row.confirmed_payload) as JsonValue }),
						sequence: row.confirmed_sequence,
					},
		sealed:
			row.sealed_op === null
				? null
				: laneOperation(row.sealed_op, row.sealed_args),
		pending:
			row.pending_op === null
				? null
				: laneOperation(row.pending_op, row.pending_args),
		parked:
			row.parked_op === null || row.parked_code === null
				? null
				: {
						operation: laneOperation(row.parked_op, row.parked_args),
						code: row.parked_code,
						...(row.parked_measured === null
							? {}
							: { measuredBytes: row.parked_measured }),
						...(row.parked_limit === null
							? {}
							: { limitBytes: row.parked_limit }),
					},
	};
};

const referenceObservations = (ref: ReplicaRef): ReplicaObservations => ({
	record: (address) => lanesOf(ref.record(address)),
	sync: () => {
		const meta = ref.meta();
		return {
			replicaId: meta.replica_id,
			authorityLifetime: meta.authority_lifetime,
			afterSequence: meta.after_sequence,
			sealedSubmission: meta.sealed_submission,
			nextSubmission: meta.next_submission,
		};
	},
	sealedRequest: () => ref.sealedRequest(),
	snapshot: () => ref.store.logicalState(),
});

const referenceTransition = (
	ref: ReplicaRef,
	statements: readonly Statement[],
): ReplicaTransition => ({
	boundaries: statements.length,
	crash: (boundary): CrashedReplica => {
		const crashed = new ReplicaRef(
			ref.store.crashDuringTransaction(statements, boundary),
		);
		return {
			...referenceObservations(crashed),
			close: () => crashed.store.close(),
		};
	},
	commit: () => ref.store.applyTransaction(statements),
});

const referenceReplica = (ref: ReplicaRef): ConformanceReplica => ({
	...referenceObservations(ref),
	localWrite: (intent) =>
		referenceTransition(ref, ref.localWriteStatements(intent)),
	seal: () => {
		const seal = ref.sealStatements();
		return {
			transition: referenceTransition(ref, seal.statements),
			requestBytes: seal.requestBytes,
			requestHash: seal.requestHash,
		};
	},
	settle: (response) =>
		referenceTransition(ref, ref.settleStatements(response)),
	installFacts: (page) =>
		referenceTransition(ref, ref.installFactsStatements(page)),
	erase: () => referenceTransition(ref, ref.eraseStatements()),
	reconstructSealedRequest: () => ref.reconstructSealedRequest(),
	reopen: () => referenceReplica(new ReplicaRef(ref.store.reopen())),
	dispose: () => ref.store.dispose(),
});

export const referenceReplicaBinding: ReplicaConformanceBinding = {
	name: 'sqlite reference driver',
	create: (fixture) => referenceReplica(ReplicaRef.create(fixture)),
};
