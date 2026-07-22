/**
 * Record Lane-Machine Conformance Suite (ADR-0163, ADR-0164, ADR-0177)
 *
 * The maintained promotion of the disposable 2026-07-21 lane probe: every
 * reference transition of the per-address crash-state machine, executed
 * against explicit ADR-0177-shaped fixtures through one unexported test-only
 * SQLite reference driver, partitioned by the production owner that will bind
 * each subset.
 *
 * The replica subset is stated once, adapter-agnostically, in
 * `runReplicaConformanceCases` (see `replica-cases.test-support.ts`); this
 * file binds the SQLite reference driver to it, and W1B/W1C bind their
 * production replica adapters to the same cases. The authority subset (W2)
 * and the document/blob lifecycle subset (W3) remain reference-bound here
 * until their production owners exist.
 *
 * The eleven reference transitions map to the frozen decision memo's section
 * 4d list: (1) local write, (2) pending compaction, (3) sealing, (4) new
 * write while sealed, (5) authority acceptance, (6) lost-response exact
 * retry, (7) replica settlement with its parked variants, (8) facts feed
 * ahead of a delayed response plus the prefix-and-cursor transaction,
 * (9) process failure at every boundary, (10) lifetime erase, and
 * (11) reacquisition by a superseded replica, plus the terminal-tombstone
 * document/blob cleanup owned by ADR-0173/0174. Transition 9 is not a
 * separate case: it is the crash-matrix harness (`applyWithCrashes` here and
 * in the replica case runner), which strengthens the probe's in-memory
 * rollback into a file-backed kill. Every multi-statement transition is run
 * once per statement boundary: the statement prefix executes inside an open
 * transaction, the database file and its hot journal are copied exactly as
 * they exist at that instant, and the copy is reopened so SQLite's own crash
 * recovery must restore the pre-transition logical state.
 *
 * Beyond the probe, this suite adds the first-seal witness the probe lacked
 * (ADR-0163): sealing persists the exact canonical request bytes and their
 * hash, and those persisted bytes remain the byte-identical retry request
 * across newer pending work, feed-ahead tombstones, injected crashes, and
 * clean reopens, until settlement clears them.
 *
 * Blob staging write-order fault cases intentionally do not appear here; W3
 * adds them to this same suite once a real blob foundation gives them a
 * storage owner to exercise (no skipped or stubbed tests before that).
 */
import { describe, expect, test } from 'bun:test';

import {
	canonicalize,
	parseSubmissionRequest,
	type RecordAddress,
	type SubmissionRequest,
} from '../../protocol/v1/index.js';
import {
	AuthorityRef,
	LIMITS,
	ReplicaRef,
	referenceReplicaBinding,
} from './reference-driver.test-support.js';
import type { ReferenceDb, Statement } from './reference-store.test-support.js';
import { runReplicaConformanceCases } from './replica-cases.test-support.js';

const LIFETIME = 'lifetime-one';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

const recordA: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const recordB: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};

/**
 * Transition 9, applied to every multi-statement transition: for each
 * statement boundary, execute the prefix, kill the process at the file level,
 * reopen from the crashed copy, and require the exact pre-transition logical
 * state (plus any caller assertion). Then commit the full transition on the
 * live store.
 */
const applyWithCrashes = (
	db: ReferenceDb,
	statements: readonly Statement[],
	assertAfterCrash?: (crashed: ReferenceDb) => void,
): void => {
	const before = db.logicalState();
	for (let boundary = 1; boundary <= statements.length; boundary += 1) {
		const crashed = db.crashDuringTransaction(statements, boundary);
		expect(crashed.logicalState()).toBe(before);
		assertAfterCrash?.(crashed);
		crashed.close();
	}
	db.applyTransaction(statements);
};

/** Admit a hand-built submission and return its canonical wire bytes. */
const requestBytes = (request: SubmissionRequest): string => {
	const { data, error } = parseSubmissionRequest(request, LIMITS);
	if (error !== null) throw new Error(error.message);
	return canonicalize(data);
};

/** Drive an authority acceptance to completion and return the response. */
const accept = (authority: AuthorityRef, bytes: string) => {
	const outcome = authority.acceptance(bytes);
	if (outcome.kind !== 'accept') {
		throw new Error(`expected acceptance, got ${outcome.kind}`);
	}
	applyWithCrashes(authority.store, outcome.statements);
	return authority.responseFor(outcome.request, outcome.parked);
};

/** A bound replica with one sealed two-address submission. */
const sealedFixture = () => {
	const replica = ReplicaRef.create({
		replicaId: REPLICA_ID,
		authorityLifetime: LIFETIME,
	});
	replica.store.applyTransaction(
		replica.localWriteStatements({
			address: recordB,
			op: 'replace',
			value: { z: 1 },
		}),
	);
	replica.store.applyTransaction(
		replica.localWriteStatements({ address: recordA, op: 'replace', value: 1 }),
	);
	const seal = replica.sealStatements();
	replica.store.applyTransaction(seal.statements);
	return { replica, seal };
};

runReplicaConformanceCases(referenceReplicaBinding);

describe('authority subset (W2 binds these to the production authority)', () => {
	test('5: acceptance folds, sequences, and witnesses in one transaction', () => {
		const { replica } = sealedFixture();
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');

		const authority = AuthorityRef.create(LIFETIME);
		const outcome = authority.acceptance(witness.bytes);
		if (outcome.kind !== 'accept') throw new Error('expected acceptance');
		applyWithCrashes(authority.store, outcome.statements);

		expect(authority.currentFact(recordA)?.sequence).toBe(1);
		expect(authority.currentFact(recordB)?.sequence).toBe(2);
		expect(authority.meta().next_sequence).toBe(3);
		// The witness records the replica's exact persisted-bytes hash.
		expect(authority.witness(REPLICA_ID)?.request_hash).toBe(witness.hash);
		replica.store.dispose();
		authority.store.dispose();
	});

	test('6: a lost response is answered from the witness by exact persisted-bytes retry', () => {
		const { replica } = sealedFixture();
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');
		const authority = AuthorityRef.create(LIFETIME);
		accept(authority, witness.bytes);
		const before = authority.store.logicalState();

		// Exact retry: same persisted bytes, same number, same hash. The
		// authority answers from the witness without re-adjudicating.
		const retry = authority.acceptance(witness.bytes);
		if (retry.kind !== 'retry')
			throw new Error(`expected retry, got ${retry.kind}`);
		expect(retry.response.facts.map((fact) => fact.address.recordKey)).toEqual([
			recordA.recordKey,
			recordB.recordKey,
		]);
		expect(authority.store.logicalState()).toBe(before);

		// The same number with different semantic content is a fork.
		const forked = requestBytes({
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [{ address: recordA, op: 'replace', value: 'forged' }],
		});
		expect(authority.acceptance(forked).kind).toBe('fork');

		// A skipped number is a gap.
		const skipped = requestBytes({
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 3,
			intents: [{ address: recordA, op: 'replace', value: 2 }],
		});
		expect(authority.acceptance(skipped).kind).toBe('gap');
		replica.store.dispose();
		authority.store.dispose();
	});

	test('a submission bound to another lifetime is a terminal mismatch, never adjudicated', () => {
		// Matches the pure protocol authority (`submit` in protocol/v1): the
		// lifetime is validated before any ledger logic, so a mismatched request
		// is refused even when its number and content would otherwise be an
		// exact retry, a fork, or the expected next submission.
		const authority = AuthorityRef.create(LIFETIME);
		const before = authority.store.logicalState();
		const mismatched = requestBytes({
			authorityLifetime: 'lifetime-two',
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [{ address: recordA, op: 'replace', value: 1 }],
		});
		expect(authority.acceptance(mismatched).kind).toBe('lifetime-mismatch');
		expect(authority.store.logicalState()).toBe(before);
		expect(authority.witness(REPLICA_ID)).toBeNull();
		authority.store.dispose();
	});
});

describe('document/blob subset (W3 binds these to the real foundations)', () => {
	/** A replica whose record owns a document chain, an in-flight image, and blob evidence. */
	const documentFixture = () => {
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.installFactsStatements({
				authorityLifetime: LIFETIME,
				facts: [
					{ address: recordA, sequence: 1, state: 'live', payload: { t: 'x' } },
				],
				afterSequence: 1,
			}),
		);
		replica.store.applyTransaction([
			{
				sql: `UPDATE records SET blob_sha256 = ?, blob_pending = 0 WHERE record_key = ?`,
				params: ['a'.repeat(64), recordA.recordKey],
			},
			{
				sql: `INSERT INTO record_documents (record_id, seq, kind, bytes)
				      SELECT record_id, 1, 'baseline', X'01' FROM records WHERE record_key = ?`,
				params: [recordA.recordKey],
			},
			{
				sql: `INSERT INTO document_inflight (record_id, payload, digest, captured_revision)
				      SELECT record_id, X'02', 'digest', 0 FROM records WHERE record_key = ?`,
				params: [recordA.recordKey],
			},
		]);
		return replica;
	};

	const childCounts = (replica: ReplicaRef) => ({
		documents: replica.store.get<{ n: number }>(
			'SELECT count(*) AS n FROM record_documents',
		)?.n,
		inflight: replica.store.get<{ n: number }>(
			'SELECT count(*) AS n FROM document_inflight',
		)?.n,
	});

	test('a terminal tombstone installs, clears blob evidence, and deletes child rows in one transaction', () => {
		const replica = documentFixture();
		expect(childCounts(replica)).toEqual({ documents: 1, inflight: 1 });

		// One crash-injected transaction installs the tombstone, clears the blob
		// evidence, and explicitly deletes the document chain and in-flight image
		// (no cascade exists to do any of it implicitly). A crash at any
		// statement boundary restores the fully live record with both children,
		// so no observable state ever holds a committed tombstone beside a
		// half-done cleanup.
		applyWithCrashes(
			replica.store,
			replica.installFactsStatements({
				authorityLifetime: LIFETIME,
				facts: [{ address: recordA, sequence: 2, state: 'tombstone' }],
				afterSequence: 2,
			}),
			(crashed) => {
				const recovered = new ReplicaRef(crashed);
				expect(recovered.record(recordA)?.confirmed_state).toBe('live');
				expect(childCounts(recovered)).toEqual({ documents: 1, inflight: 1 });
			},
		);
		expect(childCounts(replica)).toEqual({ documents: 0, inflight: 0 });
		const row = replica.record(recordA);
		expect(row?.blob_sha256).toBeNull();
		expect(row?.confirmed_state).toBe('tombstone');
		replica.store.dispose();
	});

	test('10: lifetime erase deletes records and every sibling relation and resets sync metadata', () => {
		const replica = documentFixture();
		// Sealed work of the superseded lifetime exists and is intentionally
		// abandoned by the erase.
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: recordB,
				op: 'replace',
				value: { z: 1 },
			}),
		);
		replica.store.applyTransaction(replica.sealStatements().statements);

		applyWithCrashes(replica.store, replica.eraseStatements());
		expect(
			replica.store.get<{ n: number }>('SELECT count(*) AS n FROM records')?.n,
		).toBe(0);
		expect(childCounts(replica)).toEqual({ documents: 0, inflight: 0 });
		const meta = replica.meta();
		expect(meta.authority_lifetime).toBeNull();
		expect(meta.after_sequence).toBe(0);
		expect(meta.sealed_submission).toBeNull();
		expect(meta.sealed_request).toBeNull();
		expect(meta.next_submission).toBe(1);
		expect(meta.replica_id).toBe(REPLICA_ID); // the attachment identity survives
		replica.store.dispose();
	});
});
