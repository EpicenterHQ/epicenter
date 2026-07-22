/**
 * Record Lane-Machine Conformance Suite (ADR-0163, ADR-0164, ADR-0177)
 *
 * The maintained promotion of the disposable 2026-07-21 lane probe: every
 * reference transition of the per-address crash-state machine, executed
 * against explicit ADR-0177-shaped fixtures through one unexported test-only
 * SQLite reference driver, partitioned by the production owner that will bind
 * each subset (W1B/W1C replica adapters, W2 authority, W3 document/blob).
 *
 * The eleven reference transitions map to the frozen decision memo's section
 * 4d list: (1) local write, (2) pending compaction, (3) sealing, (4) new
 * write while sealed, (5) authority acceptance, (6) lost-response exact
 * retry, (7) replica settlement with its parked variants, (8) facts feed
 * ahead of a delayed response plus the prefix-and-cursor transaction,
 * (9) process failure at every boundary, (10) lifetime erase, and
 * (11) reacquisition by a superseded replica, plus the terminal-tombstone
 * document/blob cleanup owned by ADR-0173/0174. Transition 9 is not a
 * separate case: it is the `applyWithCrashes` harness, which strengthens the
 * probe's in-memory rollback into a file-backed kill. Every multi-statement
 * transition is run once per statement boundary: the statement prefix
 * executes inside an open transaction, the database file and its hot journal
 * are copied exactly as they exist at that instant, and the copy is reopened
 * so SQLite's own crash recovery must restore the pre-transition logical
 * state.
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
	type Fact,
	parseSubmissionRequest,
	type RecordAddress,
	type SubmissionRequest,
	sha256Hex,
} from '../../protocol/v1/index.js';
import {
	AuthorityRef,
	LIMITS,
	ReplicaRef,
} from './reference-driver.test-support.js';
import type { ReferenceDb, Statement } from './reference-store.test-support.js';

const LIFETIME = 'lifetime-one';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const REPLICA_B = 'ssssssssssssssssssssssss';

const rowA: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const rowB: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
};
const theme: RecordAddress = {
	namespace: 'so.epicenter.whispering',
	collection: 'settings',
	recordKey: 'theme',
};

/**
 * Transition 9, applied to every multi-statement transition: for each
 * statement boundary, execute the prefix, kill the process at the file level,
 * reopen from the crashed copy, and require the exact pre-transition logical
 * state (plus any caller assertion, such as first-seal byte stability). Then
 * commit the full transition on the live store.
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
			address: rowB,
			op: 'replace',
			value: { z: 1 },
		}),
	);
	replica.store.applyTransaction(
		replica.localWriteStatements({ address: rowA, op: 'replace', value: 1 }),
	);
	const seal = replica.sealStatements();
	replica.store.applyTransaction(seal.statements);
	return { replica, seal };
};

describe('replica subset (W1B/W1C bind these to production adapters)', () => {
	test('1: a local write folds into the pending lane and survives reopen', () => {
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		applyWithCrashes(
			replica.store,
			replica.localWriteStatements({
				address: rowB,
				op: 'replace',
				value: { z: 1 },
			}),
		);
		const reopened = new ReplicaRef(replica.store.reopen());
		const row = reopened.record(rowB);
		expect(row?.pending_op).toBe('replace');
		expect(row?.pending_args).toBe(canonicalize({ z: 1 }));
		expect(row?.confirmed_state).toBeNull();
		reopened.store.close();
	});

	test('2: pending compaction happens inside the write transaction under the one law', () => {
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: rowB,
				op: 'replace',
				value: { z: 1 },
			}),
		);
		// A second write composes: replace {z:1} then patch {y:2} compacts to one
		// replace carrying both fields, never two queued operations.
		applyWithCrashes(
			replica.store,
			replica.localWriteStatements({
				address: rowB,
				op: 'patch',
				set: { y: 2 },
				unset: [],
			}),
		);
		const row = replica.record(rowB);
		expect(row?.pending_op).toBe('replace');
		expect(row?.pending_args).toBe(canonicalize({ y: 2, z: 1 }));
		replica.store.close();
	});

	test('3: sealing moves pending to sealed and persists the first-seal canonical bytes and hash', () => {
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: rowB,
				op: 'replace',
				value: { z: 2 },
			}),
		);
		replica.store.applyTransaction(
			replica.localWriteStatements({ address: rowA, op: 'replace', value: 1 }),
		);
		const seal = replica.sealStatements();
		applyWithCrashes(replica.store, seal.statements, (crashed) => {
			// A crashed seal leaves no half-sealed state: no marker, no bytes.
			expect(new ReplicaRef(crashed).sealedRequest()).toBeNull();
		});

		// Sealed lanes hold the operations; pending lanes are empty.
		expect(replica.record(rowA)?.sealed_op).toBe('replace');
		expect(replica.record(rowB)?.sealed_op).toBe('replace');
		expect(replica.record(rowA)?.pending_op).toBeNull();

		// The persisted bytes are the admitted request's canonical encoding, in
		// canonical address order, and the hash is their SHA-256.
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');
		expect(witness.bytes).toBe(seal.requestBytes);
		expect(sha256Hex(witness.bytes)).toBe(witness.hash);
		const parsed = JSON.parse(witness.bytes) as SubmissionRequest;
		expect(parsed.intents.map((intent) => intent.address.recordKey)).toEqual([
			rowA.recordKey,
			rowB.recordKey,
		]);

		// Debug assertion retained by ADR-0163: reconstruction from the sealed
		// lanes reproduces the persisted bytes under the same encoder.
		expect(replica.reconstructSealedRequest()).toBe(witness.bytes);
		replica.store.close();
	});

	test('4: a new write while sealed cannot change the first-seal retry bytes', () => {
		const { replica, seal } = sealedFixture();
		const firstSeal = replica.sealedRequest();
		if (firstSeal === null) throw new Error('seal persisted nothing');

		const write = replica.localWriteStatements({
			address: rowB,
			op: 'replace',
			value: { z: 3 },
		});
		applyWithCrashes(replica.store, write, (crashed) => {
			expect(new ReplicaRef(crashed).sealedRequest()).toEqual(firstSeal);
		});

		// The sealed lane and the persisted first-seal bytes are byte-identical
		// even though newer pending work now exists at the same address.
		expect(replica.record(rowB)?.sealed_op).toBe('replace');
		expect(replica.record(rowB)?.pending_op).toBe('replace');
		expect(replica.sealedRequest()).toEqual(firstSeal);
		expect(replica.sealedRequest()?.bytes).toBe(seal.requestBytes);
		expect(replica.reconstructSealedRequest()).toBe(firstSeal.bytes);

		// A clean process restart also preserves them exactly.
		const reopened = new ReplicaRef(replica.store.reopen());
		expect(reopened.sealedRequest()).toEqual(firstSeal);
		reopened.store.close();
	});

	test('7: settlement installs facts, retires the seal, clears the bytes, and keeps newer pending', () => {
		const { replica } = sealedFixture();
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');
		// Newer pending desire arrives while the submission is in flight.
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: rowB,
				op: 'patch',
				set: { newer: true },
				unset: [],
			}),
		);

		const authority = AuthorityRef.create(LIFETIME);
		const response = accept(authority, witness.bytes);

		applyWithCrashes(
			replica.store,
			replica.settleStatements(response),
			(crashed) => {
				// Before the settlement commits, the retry bytes must survive a crash.
				expect(new ReplicaRef(crashed).sealedRequest()).toEqual(witness);
			},
		);

		expect(replica.record(rowA)?.confirmed_state).toBe('live');
		expect(replica.record(rowA)?.confirmed_payload).toBe(canonicalize(1));
		expect(replica.record(rowB)?.confirmed_payload).toBe(
			canonicalize({ z: 1 }),
		);
		expect(replica.record(rowA)?.sealed_op).toBeNull();
		expect(replica.record(rowB)?.sealed_op).toBeNull();
		// The newer pending desire survives settlement untouched.
		expect(replica.record(rowB)?.pending_op).toBe('patch');
		const meta = replica.meta();
		expect(meta.sealed_submission).toBeNull();
		expect(meta.sealed_request).toBeNull();
		expect(meta.sealed_request_hash).toBeNull();
		expect(meta.next_submission).toBe(2);
		replica.store.close();
		authority.store.close();
	});

	test('7p: a parked refusal is stored whole and consumed by the next local write', () => {
		// Replica B establishes a live scalar; replica A patches it, which the
		// authority refuses as patch-base-not-object.
		const authority = AuthorityRef.create(LIFETIME);
		accept(
			authority,
			requestBytes({
				authorityLifetime: LIFETIME,
				replicaId: REPLICA_B,
				submissionNumber: 1,
				intents: [{ address: theme, op: 'replace', value: 'dark' }],
			}),
		);

		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: theme,
				op: 'patch',
				set: { a: 1 },
				unset: [],
			}),
		);
		const seal = replica.sealStatements();
		replica.store.applyTransaction(seal.statements);
		const response = accept(authority, seal.requestBytes);
		expect(response.parked).toEqual([
			{ address: theme, code: 'patch-base-not-object' },
		]);

		applyWithCrashes(replica.store, replica.settleStatements(response));
		const row = replica.record(theme);
		// The refused operation is retained whole as a visible non-retrying
		// overlay with its refusal code; the confirmed lane keeps the live value.
		expect(row?.parked_op).toBe('patch');
		expect(row?.parked_code).toBe('patch-base-not-object');
		expect(row?.parked_measured).toBeNull();
		expect(row?.confirmed_payload).toBe(canonicalize('dark'));
		expect(row?.pending_op).toBeNull();

		// A later local write composes with the parked operation under the one
		// law, clears the diagnostic, and creates newly pending work.
		applyWithCrashes(
			replica.store,
			replica.localWriteStatements({
				address: theme,
				op: 'replace',
				value: 'light',
			}),
		);
		const consumed = replica.record(theme);
		expect(consumed?.parked_op).toBeNull();
		expect(consumed?.parked_code).toBeNull();
		expect(consumed?.pending_op).toBe('replace');
		expect(consumed?.pending_args).toBe(canonicalize('light'));
		replica.store.close();
		authority.store.close();
	});

	test('7q: a parked refusal compacts beneath newer pending desire instead of overlaying', () => {
		const authority = AuthorityRef.create(LIFETIME);
		accept(
			authority,
			requestBytes({
				authorityLifetime: LIFETIME,
				replicaId: REPLICA_B,
				submissionNumber: 1,
				intents: [{ address: theme, op: 'replace', value: 'dark' }],
			}),
		);
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: theme,
				op: 'patch',
				set: { a: 1 },
				unset: [],
			}),
		);
		const seal = replica.sealStatements();
		replica.store.applyTransaction(seal.statements);
		// Newer pending desire arrives before settlement.
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: theme,
				op: 'patch',
				set: { b: 2 },
				unset: [],
			}),
		);
		const response = accept(authority, seal.requestBytes);
		applyWithCrashes(replica.store, replica.settleStatements(response));

		const row = replica.record(theme);
		// No overlay is stored: pending = pending-composed-beneath-parked, one
		// operation per address, under the same composition law.
		expect(row?.parked_op).toBeNull();
		expect(row?.pending_op).toBe('patch');
		expect(row?.pending_args).toBe(
			canonicalize({ set: { a: 1, b: 2 }, unset: [] }),
		);
		replica.store.close();
		authority.store.close();
	});

	test('7t: a remembered parked result cannot overlay a newer tombstone at retry settlement', () => {
		const authority = AuthorityRef.create(LIFETIME);
		accept(
			authority,
			requestBytes({
				authorityLifetime: LIFETIME,
				replicaId: REPLICA_B,
				submissionNumber: 1,
				intents: [{ address: theme, op: 'replace', value: 'dark' }],
			}),
		);
		const replica = ReplicaRef.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: theme,
				op: 'patch',
				set: { a: 1 },
				unset: [],
			}),
		);
		const seal = replica.sealStatements();
		replica.store.applyTransaction(seal.statements);
		// First adjudication parks; its response is lost.
		accept(authority, seal.requestBytes);
		// Another replica terminally deletes the record before the retry.
		accept(
			authority,
			requestBytes({
				authorityLifetime: LIFETIME,
				replicaId: REPLICA_B,
				submissionNumber: 2,
				intents: [{ address: theme, op: 'tombstone' }],
			}),
		);
		// Exact retry with the persisted bytes returns the remembered parked
		// result plus the newer tombstone fact.
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');
		const retry = authority.acceptance(witness.bytes);
		if (retry.kind !== 'retry')
			throw new Error(`expected retry, got ${retry.kind}`);
		expect(retry.response.parked).toEqual([
			{ address: theme, code: 'patch-base-not-object' },
		]);
		expect(retry.response.facts[0]?.state).toBe('tombstone');

		applyWithCrashes(replica.store, replica.settleStatements(retry.response));
		const row = replica.record(theme);
		// The stored tombstone supersedes the parked overlay and its diagnostic.
		expect(row?.confirmed_state).toBe('tombstone');
		expect(row?.parked_op).toBeNull();
		expect(row?.pending_op).toBeNull();
		replica.store.close();
		authority.store.close();
	});

	test('8: a feed-ahead tombstone dominates unsealed work while the sealed retry image survives', () => {
		const { replica } = sealedFixture();
		const firstSeal = replica.sealedRequest();
		if (firstSeal === null) throw new Error('seal persisted nothing');
		// Newer pending desire exists beside the sealed lane.
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: rowB,
				op: 'replace',
				value: { z: 9 },
			}),
		);

		// The facts feed learns a tombstone at the sealed address plus an
		// unrelated live fact, and advances the cursor, in one transaction.
		const page = {
			authorityLifetime: LIFETIME,
			facts: [
				{ address: rowB, sequence: 8, state: 'tombstone' } as Fact,
				{
					address: theme,
					sequence: 10,
					state: 'live',
					payload: 'dark',
				} as Fact,
			],
			afterSequence: 10,
		};
		applyWithCrashes(
			replica.store,
			replica.installFactsStatements(page),
			(crashed) => {
				expect(new ReplicaRef(crashed).sealedRequest()).toEqual(firstSeal);
			},
		);

		const row = replica.record(rowB);
		expect(row?.confirmed_state).toBe('tombstone');
		expect(row?.pending_op).toBeNull(); // dominated as superseded
		expect(row?.sealed_op).toBe('replace'); // retry image untouched
		expect(replica.sealedRequest()).toEqual(firstSeal);
		expect(replica.meta().after_sequence).toBe(10);
		expect(replica.record(theme)?.confirmed_payload).toBe(canonicalize('dark'));

		// Monotonic installation: a delayed older fact is ignored while the
		// cursor still advances; an equal sequence with different content is
		// corruption.
		replica.store.applyTransaction(
			replica.installFactsStatements({
				authorityLifetime: LIFETIME,
				facts: [
					{ address: theme, sequence: 9, state: 'live', payload: 'stale' },
				],
				afterSequence: 11,
			}),
		);
		expect(replica.record(theme)?.confirmed_payload).toBe(canonicalize('dark'));
		expect(replica.meta().after_sequence).toBe(11);
		expect(() =>
			replica.installFactsStatements({
				authorityLifetime: LIFETIME,
				facts: [
					{ address: theme, sequence: 10, state: 'live', payload: 'other' },
				],
				afterSequence: 12,
			}),
		).toThrow(/corruption/);
		replica.store.close();
	});

	test('11: a superseded replica erases and reacquires from zero under the successor lifetime', () => {
		const { replica } = sealedFixture();
		// A response carrying a different lifetime is a terminal mismatch: the
		// driver refuses to install it, forcing erase-and-reacquire.
		expect(() =>
			replica.installFactsStatements({
				authorityLifetime: 'lifetime-two',
				facts: [],
				afterSequence: 0,
			}),
		).toThrow(/lifetime mismatch/);

		replica.store.applyTransaction(replica.eraseStatements());
		// Reacquisition binds the successor lifetime and installs from zero.
		applyWithCrashes(
			replica.store,
			replica.installFactsStatements({
				authorityLifetime: 'lifetime-two',
				facts: [
					{ address: theme, sequence: 1, state: 'live', payload: 'dark' },
				],
				afterSequence: 1,
			}),
		);
		const meta = replica.meta();
		expect(meta.authority_lifetime).toBe('lifetime-two');
		expect(meta.after_sequence).toBe(1);
		expect(meta.next_submission).toBe(1);
		expect(replica.record(theme)?.confirmed_payload).toBe(canonicalize('dark'));
		replica.store.close();
	});
});

describe('authority subset (W2 binds these to the production authority)', () => {
	test('5: acceptance folds, sequences, and witnesses in one transaction', () => {
		const { replica } = sealedFixture();
		const witness = replica.sealedRequest();
		if (witness === null) throw new Error('seal persisted nothing');

		const authority = AuthorityRef.create(LIFETIME);
		const outcome = authority.acceptance(witness.bytes);
		if (outcome.kind !== 'accept') throw new Error('expected acceptance');
		applyWithCrashes(authority.store, outcome.statements);

		expect(authority.currentFact(rowA)?.sequence).toBe(1);
		expect(authority.currentFact(rowB)?.sequence).toBe(2);
		expect(authority.meta().next_sequence).toBe(3);
		// The witness records the replica's exact persisted-bytes hash.
		expect(authority.witness(REPLICA_ID)?.request_hash).toBe(witness.hash);
		replica.store.close();
		authority.store.close();
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
			rowA.recordKey,
			rowB.recordKey,
		]);
		expect(authority.store.logicalState()).toBe(before);

		// The same number with different semantic content is a fork.
		const forked = requestBytes({
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [{ address: rowA, op: 'replace', value: 'forged' }],
		});
		expect(authority.acceptance(forked).kind).toBe('fork');

		// A skipped number is a gap.
		const skipped = requestBytes({
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 3,
			intents: [{ address: rowA, op: 'replace', value: 2 }],
		});
		expect(authority.acceptance(skipped).kind).toBe('gap');
		replica.store.close();
		authority.store.close();
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
			intents: [{ address: rowA, op: 'replace', value: 1 }],
		});
		expect(authority.acceptance(mismatched).kind).toBe('lifetime-mismatch');
		expect(authority.store.logicalState()).toBe(before);
		expect(authority.witness(REPLICA_ID)).toBeNull();
		authority.store.close();
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
					{ address: rowA, sequence: 1, state: 'live', payload: { t: 'x' } },
				],
				afterSequence: 1,
			}),
		);
		replica.store.applyTransaction([
			{
				sql: `UPDATE records SET blob_sha256 = ?, blob_pending = 0 WHERE record_key = ?`,
				params: ['a'.repeat(64), rowA.recordKey],
			},
			{
				sql: `INSERT INTO record_documents (record_id, seq, kind, bytes)
				      SELECT record_id, 1, 'baseline', X'01' FROM records WHERE record_key = ?`,
				params: [rowA.recordKey],
			},
			{
				sql: `INSERT INTO document_inflight (record_id, payload, digest, captured_revision)
				      SELECT record_id, X'02', 'digest', 0 FROM records WHERE record_key = ?`,
				params: [rowA.recordKey],
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

	test('a terminal tombstone explicitly deletes the document chain and blob evidence, with no cascade', () => {
		const replica = documentFixture();

		// No cascade exists: installing the tombstone fact alone leaves both
		// sibling rows in place.
		replica.store.applyTransaction(
			replica.installFactsStatements({
				authorityLifetime: LIFETIME,
				facts: [{ address: rowA, sequence: 2, state: 'tombstone' }],
				afterSequence: 2,
			}),
		);
		expect(childCounts(replica)).toEqual({ documents: 1, inflight: 1 });

		// The tombstone transaction owns the cleanup visibly and atomically.
		applyWithCrashes(replica.store, replica.tombstoneCleanupStatements(rowA));
		expect(childCounts(replica)).toEqual({ documents: 0, inflight: 0 });
		const row = replica.record(rowA);
		expect(row?.blob_sha256).toBeNull();
		expect(row?.confirmed_state).toBe('tombstone');
		replica.store.close();
	});

	test('10: lifetime erase deletes records and every sibling relation and resets sync metadata', () => {
		const replica = documentFixture();
		// Sealed work of the superseded lifetime exists and is intentionally
		// abandoned by the erase.
		replica.store.applyTransaction(
			replica.localWriteStatements({
				address: rowB,
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
		replica.store.close();
	});
});
