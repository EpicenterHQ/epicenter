/**
 * The reusable replica conformance cases (ADR-0163, ADR-0164, ADR-0177).
 *
 * `runReplicaConformanceCases` states every replica-owned reference transition
 * of the per-address crash-state machine once, against the small
 * `ReplicaConformanceBinding` contract below. The cases observe only semantic
 * lane values (kernel operations, payload values, sync metadata, the persisted
 * first-seal witness) and drive transitions through prepared
 * `ReplicaTransition` values, so they never see a database handle, SQL text,
 * or a physical column. W1A binds the unexported SQLite reference driver;
 * W1B and W1C bind their production replica adapters to the same cases
 * without copying them. Every binding capability accepts an immediate value
 * or a promise so an in-process store and an RPC-backed browser worker run
 * this exact case source.
 *
 * Settlement responses are adjudicated by the pure protocol authority
 * (`protocol/v1/authority.ts`), driven over the replica's canonical request
 * bytes. That keeps the replica cases free of any storage authority: the
 * kernel is the semantic oracle here, and the SQLite reference authority is
 * exercised by the separate authority subset that W2 will bind.
 *
 * Crash coverage (memo transition 9) is the `applyWithCrashes` helper: every
 * multi-statement transition is killed once per fault boundary, and the
 * recovered copy must serialize to the exact pre-transition logical state
 * before the caller's extra assertions (such as first-seal byte stability)
 * run against it.
 */
import { describe, expect, test } from 'bun:test';

import {
	canonicalize,
	createAuthority,
	type FactsRequest,
	type FactsResponse,
	type Intent,
	type JsonValue,
	type Operation,
	parseSubmissionRequest,
	type RecordAddress,
	type SubmissionRequest,
	type SubmissionResponse,
	sha256Hex,
	submit,
	type ValidatedLimits,
} from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';

/** The last learned authority fact at an address, without its address. */
export type ConfirmedLane = {
	state: 'live' | 'tombstone' | 'unset';
	/** Present exactly when `state` is `'live'`. */
	payload?: JsonValue;
	sequence: number;
};

/** The retained refused operation with its diagnostic (ADR-0163 parking). */
export type ParkedLane = {
	operation: Operation;
	code: string;
	/** Present exactly when `code` is `'fact-too-large'`. */
	measuredBytes?: number;
	/** Present exactly when `code` is `'fact-too-large'`. */
	limitBytes?: number;
};

/** The whole per-address crash-state machine, as semantic lane values. */
export type RecordLanes = {
	confirmed: ConfirmedLane | null;
	sealed: Operation | null;
	pending: Operation | null;
	parked: ParkedLane | null;
};

/** The replica's durable synchronization metadata. */
export type ReplicaSync = {
	replicaId: string;
	authorityLifetime: string | null;
	afterSequence: number;
	sealedSubmission: number | null;
	nextSubmission: number;
};

/** The persisted first-seal retry witness: exact canonical bytes and hash. */
export type SealWitness = { bytes: string; hash: string };

/** A capability result that may cross an asynchronous adapter or RPC boundary. */
export type MaybePromise<TValue> = TValue | Promise<TValue>;

/** One facts-feed page to install as a single transaction. */
export type FactsPage = {
	request: FactsRequest;
	response: FactsResponse;
};

/**
 * Read-only observations every replica view answers, live or crash-recovered.
 */
export type ReplicaObservations = {
	record(address: RecordAddress): MaybePromise<RecordLanes | null>;
	sync(): MaybePromise<ReplicaSync>;
	sealedRequest(): MaybePromise<SealWitness | null>;
	/**
	 * An opaque canonical serialization of the complete logical state. Two
	 * states are equivalent exactly when their snapshots are equal strings;
	 * physical identities (rowids, file layout) must not leak into it, and
	 * every durable field the binding persists must be included, or omitted
	 * state escapes crash verification.
	 */
	snapshot(): MaybePromise<string>;
};

/** A crash-recovered copy; the caller closes it after inspecting. */
export type CrashedReplica = ReplicaObservations & {
	close(): MaybePromise<void>;
};

/**
 * One prepared atomic transition. `boundaries` counts the injectable fault
 * points (statement boundaries for a SQLite binding); `crash(boundary)`
 * simulates a process kill after that many fault points and reopens the
 * recovered copy without touching the live store; `commit` applies the whole
 * transition as one transaction.
 */
export type ReplicaTransition = {
	readonly boundaries: MaybePromise<number>;
	crash(boundary: number): MaybePromise<CrashedReplica>;
	commit(): MaybePromise<void>;
};

/**
 * One bound conformance replica. Transitions may refuse at preparation or at
 * commit (the cases wrap both); a refusal must leave the store unchanged.
 */
export type ConformanceReplica = ReplicaObservations & {
	localWrite(intent: Intent): MaybePromise<ReplicaTransition>;
	seal(): MaybePromise<{
		transition: ReplicaTransition;
		requestBytes: string;
		requestHash: string;
	}>;
	settle(response: SubmissionResponse): MaybePromise<ReplicaTransition>;
	installFacts(page: FactsPage): MaybePromise<ReplicaTransition>;
	erase(): MaybePromise<ReplicaTransition>;
	/** Reconstruct the sealed request from the sealed lanes (ADR-0163 debug assertion). */
	reconstructSealedRequest(): MaybePromise<string>;
	/** Close and reopen the same persisted state, as a clean process restart. */
	reopen(): MaybePromise<ConformanceReplica>;
	/** Owning disposal of the replica and everything it persisted. */
	dispose(): MaybePromise<void>;
};

/** What an adapter supplies to run the replica conformance cases. */
export type ReplicaConformanceBinding = {
	/** Suite label, e.g. `'sqlite reference driver'`. */
	name: string;
	create(fixture: {
		replicaId: string;
		authorityLifetime?: string;
	}): MaybePromise<ConformanceReplica>;
};

const LIMITS: ValidatedLimits = makeLimits();

const LIFETIME = 'lifetime-one';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const REPLICA_B = 'ssssssssssssssssssssssss';

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
const theme: RecordAddress = {
	namespace: 'so.epicenter.whispering',
	collection: 'settings',
	recordKey: 'theme',
};

/** Admit a hand-built submission and return its canonical wire bytes. */
const requestBytes = (request: SubmissionRequest): string => {
	const { data, error } = parseSubmissionRequest(request, LIMITS);
	if (error !== null) throw new Error(error.message);
	return canonicalize(data);
};

/**
 * The pure protocol authority driven over canonical request bytes: the
 * replica cases' semantic oracle for settlement responses, including parked
 * results, remembered exact retries, and interleaved submissions from another
 * replica. No storage authority participates here.
 */
const createKernelAuthority = (lifetime: string) => {
	const created = createAuthority(lifetime, LIMITS);
	if (created.error !== null) throw new Error(created.error.message);
	let state = created.data;
	return {
		submitBytes(bytes: string): SubmissionResponse {
			const { data: request, error: parseError } = parseSubmissionRequest(
				JSON.parse(bytes),
				LIMITS,
			);
			if (parseError !== null) throw new Error(parseError.message);
			const { data, error } = submit(state, request, LIMITS);
			if (error !== null) throw new Error(error.message);
			state = data.state;
			return data.response;
		},
	};
};

/**
 * Run every replica-owned conformance case against one binding.
 */
export function runReplicaConformanceCases(
	binding: ReplicaConformanceBinding,
): void {
	/**
	 * Transition 9, applied to every multi-statement transition: for each fault
	 * boundary, execute the prefix, kill the process, reopen the recovered
	 * copy, and require the exact pre-transition logical state (plus any caller
	 * assertion, such as first-seal byte stability). Then commit the full
	 * transition on the live store.
	 */
	const applyWithCrashes = async (
		replica: ConformanceReplica,
		transition: ReplicaTransition,
		assertAfterCrash?: (crashed: ReplicaObservations) => MaybePromise<void>,
	): Promise<void> => {
		// A transition reporting zero fault boundaries would make the crash
		// matrix silently vacuous; every conformance transition has at least one.
		const boundaries = await transition.boundaries;
		expect(boundaries).toBeGreaterThanOrEqual(1);
		const before = await replica.snapshot();
		for (let boundary = 1; boundary <= boundaries; boundary += 1) {
			const crashed = await transition.crash(boundary);
			expect(await crashed.snapshot()).toBe(before);
			await assertAfterCrash?.(crashed);
			await crashed.close();
		}
		await transition.commit();
	};

	/** A bound replica with one sealed two-address submission. */
	const sealedFixture = async () => {
		const replica = await binding.create({
			replicaId: REPLICA_ID,
			authorityLifetime: LIFETIME,
		});
		await (
			await replica.localWrite({
				address: recordB,
				op: 'replace',
				value: { z: 1 },
			})
		).commit();
		await (
			await replica.localWrite({
				address: recordA,
				op: 'replace',
				value: 1,
			})
		).commit();
		const seal = await replica.seal();
		await seal.transition.commit();
		return { replica, seal };
	};

	describe(`replica subset: ${binding.name}`, () => {
		test('1: a local write folds into the pending lane and survives reopen', async () => {
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await applyWithCrashes(
				replica,
				await replica.localWrite({
					address: recordB,
					op: 'replace',
					value: { z: 1 },
				}),
			);
			const reopened = await replica.reopen();
			const lanes = await reopened.record(recordB);
			expect(lanes?.pending).toEqual({ op: 'replace', value: { z: 1 } });
			expect(lanes?.confirmed).toBeNull();
			await reopened.dispose();
		});

		test('2: pending compaction happens inside the write transaction under the one law', async () => {
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await (
				await replica.localWrite({
					address: recordB,
					op: 'replace',
					value: { z: 1 },
				})
			).commit();
			// A second write composes: replace {z:1} then patch {y:2} compacts to one
			// replace carrying both fields, never two queued operations.
			await applyWithCrashes(
				replica,
				await replica.localWrite({
					address: recordB,
					op: 'patch',
					set: { y: 2 },
					unset: [],
				}),
			);
			expect((await replica.record(recordB))?.pending).toEqual({
				op: 'replace',
				value: { y: 2, z: 1 },
			});
			await replica.dispose();
		});

		test('3: sealing moves pending to sealed and persists the first-seal canonical bytes and hash', async () => {
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await (
				await replica.localWrite({
					address: recordB,
					op: 'replace',
					value: { z: 2 },
				})
			).commit();
			await (
				await replica.localWrite({
					address: recordA,
					op: 'replace',
					value: 1,
				})
			).commit();
			const seal = await replica.seal();
			await applyWithCrashes(replica, seal.transition, async (crashed) => {
				// A crashed seal leaves no half-sealed state: no marker, no bytes.
				expect(await crashed.sealedRequest()).toBeNull();
			});

			// Sealed lanes hold the operations; pending lanes are empty.
			expect((await replica.record(recordA))?.sealed).toEqual({
				op: 'replace',
				value: 1,
			});
			expect((await replica.record(recordB))?.sealed).toEqual({
				op: 'replace',
				value: { z: 2 },
			});
			expect((await replica.record(recordA))?.pending).toBeNull();

			// The persisted bytes are the admitted request's canonical encoding, in
			// canonical address order, and the hash is their SHA-256.
			const witness = await replica.sealedRequest();
			if (witness === null) throw new Error('seal persisted nothing');
			expect(witness.bytes).toBe(seal.requestBytes);
			expect(witness.hash).toBe(seal.requestHash);
			expect(sha256Hex(witness.bytes)).toBe(witness.hash);
			const parsed = JSON.parse(witness.bytes) as SubmissionRequest;
			expect(parsed.intents.map((intent) => intent.address.recordKey)).toEqual([
				recordA.recordKey,
				recordB.recordKey,
			]);

			// Debug assertion retained by ADR-0163: reconstruction from the sealed
			// lanes reproduces the persisted bytes under the same encoder.
			expect(await replica.reconstructSealedRequest()).toBe(witness.bytes);
			await replica.dispose();
		});

		test('3b: sealing takes the largest admissible address prefix and leaves the remainder pending', async () => {
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			const addresses = Array.from(
				{ length: LIMITS.maxSubmissionAddresses + 1 },
				(_, index): RecordAddress => ({
					namespace: 'so.epicenter.bulk',
					collection: 'records',
					recordKey: index.toString(36).padStart(24, '0'),
				}),
			);
			for (const [index, address] of addresses.entries()) {
				await (
					await replica.localWrite({ address, op: 'replace', value: index })
				).commit();
			}
			const prefixFinalAddress = addresses[LIMITS.maxSubmissionAddresses - 1];
			const remainingAddress = addresses[LIMITS.maxSubmissionAddresses];
			if (prefixFinalAddress === undefined || remainingAddress === undefined) {
				throw new Error('bounded sealing fixture is incomplete');
			}

			const first = await replica.seal();
			const firstRequest = JSON.parse(first.requestBytes) as SubmissionRequest;
			expect(firstRequest.intents).toHaveLength(LIMITS.maxSubmissionAddresses);
			expect(firstRequest.intents.at(-1)?.address).toEqual(prefixFinalAddress);
			await applyWithCrashes(replica, first.transition);
			expect((await replica.record(remainingAddress))?.pending).toEqual({
				op: 'replace',
				value: LIMITS.maxSubmissionAddresses,
			});
			expect((await replica.record(prefixFinalAddress))?.sealed).toEqual({
				op: 'replace',
				value: LIMITS.maxSubmissionAddresses - 1,
			});

			const authority = createKernelAuthority(LIFETIME);
			await (
				await replica.settle(authority.submitBytes(first.requestBytes))
			).commit();
			const second = await replica.seal();
			await second.transition.commit();
			const secondRequest = JSON.parse(
				second.requestBytes,
			) as SubmissionRequest;
			expect(secondRequest.intents.map((intent) => intent.address)).toEqual([
				remainingAddress,
			]);
			await replica.dispose();
		});

		test('4: a new write while sealed cannot change the first-seal retry bytes', async () => {
			const { replica, seal } = await sealedFixture();
			const firstSeal = await replica.sealedRequest();
			if (firstSeal === null) throw new Error('seal persisted nothing');

			await applyWithCrashes(
				replica,
				await replica.localWrite({
					address: recordB,
					op: 'replace',
					value: { z: 3 },
				}),
				async (crashed) => {
					expect(await crashed.sealedRequest()).toEqual(firstSeal);
				},
			);

			// The sealed lane and the persisted first-seal bytes are byte-identical
			// even though newer pending work now exists at the same address.
			expect((await replica.record(recordB))?.sealed).toEqual({
				op: 'replace',
				value: { z: 1 },
			});
			expect((await replica.record(recordB))?.pending).toEqual({
				op: 'replace',
				value: { z: 3 },
			});
			expect(await replica.sealedRequest()).toEqual(firstSeal);
			expect((await replica.sealedRequest())?.bytes).toBe(seal.requestBytes);
			expect(await replica.reconstructSealedRequest()).toBe(firstSeal.bytes);

			// A clean process restart also preserves them exactly.
			const reopened = await replica.reopen();
			expect(await reopened.sealedRequest()).toEqual(firstSeal);
			await reopened.dispose();
		});

		test('7: settlement installs facts, retires the seal, clears the bytes, and keeps newer pending', async () => {
			const { replica } = await sealedFixture();
			const witness = await replica.sealedRequest();
			if (witness === null) throw new Error('seal persisted nothing');
			// Newer pending desire arrives while the submission is in flight.
			await (
				await replica.localWrite({
					address: recordB,
					op: 'patch',
					set: { newer: true },
					unset: [],
				})
			).commit();

			const authority = createKernelAuthority(LIFETIME);
			const response = authority.submitBytes(witness.bytes);

			await applyWithCrashes(
				replica,
				await replica.settle(response),
				async (crashed) => {
					// Before the settlement commits, the retry bytes must survive a crash.
					expect(await crashed.sealedRequest()).toEqual(witness);
				},
			);

			expect((await replica.record(recordA))?.confirmed).toEqual({
				state: 'live',
				payload: 1,
				sequence: 1,
			});
			expect((await replica.record(recordB))?.confirmed).toEqual({
				state: 'live',
				payload: { z: 1 },
				sequence: 2,
			});
			expect((await replica.record(recordA))?.sealed).toBeNull();
			expect((await replica.record(recordB))?.sealed).toBeNull();
			// The newer pending desire survives settlement untouched.
			expect((await replica.record(recordB))?.pending).toEqual({
				op: 'patch',
				set: { newer: true },
				unset: [],
			});
			const sync = await replica.sync();
			expect(sync.sealedSubmission).toBeNull();
			expect(await replica.sealedRequest()).toBeNull();
			expect(sync.nextSubmission).toBe(2);
			await replica.dispose();
		});

		test('7p: a parked refusal is stored whole and consumed by the next local write', async () => {
			// Replica B establishes a live scalar; replica A patches it, which the
			// authority refuses as patch-base-not-object.
			const authority = createKernelAuthority(LIFETIME);
			authority.submitBytes(
				requestBytes({
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_B,
					submissionNumber: 1,
					intents: [{ address: theme, op: 'replace', value: 'dark' }],
				}),
			);

			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await (
				await replica.localWrite({
					address: theme,
					op: 'patch',
					set: { a: 1 },
					unset: [],
				})
			).commit();
			const seal = await replica.seal();
			await seal.transition.commit();
			const response = authority.submitBytes(seal.requestBytes);
			expect(response.parked).toEqual([
				{ address: theme, code: 'patch-base-not-object' },
			]);

			await applyWithCrashes(replica, await replica.settle(response));
			const lanes = await replica.record(theme);
			// The refused operation is retained whole as a visible non-retrying
			// overlay with its refusal code; the confirmed lane keeps the live value.
			expect(lanes?.parked).toEqual({
				operation: { op: 'patch', set: { a: 1 }, unset: [] },
				code: 'patch-base-not-object',
			});
			expect(lanes?.confirmed).toEqual({
				state: 'live',
				payload: 'dark',
				sequence: 1,
			});
			expect(lanes?.pending).toBeNull();

			// A later local write composes with the parked operation under the one
			// law, clears the diagnostic, and creates newly pending work.
			await applyWithCrashes(
				replica,
				await replica.localWrite({
					address: theme,
					op: 'replace',
					value: 'light',
				}),
			);
			const consumed = await replica.record(theme);
			expect(consumed?.parked).toBeNull();
			expect(consumed?.pending).toEqual({ op: 'replace', value: 'light' });
			await replica.dispose();
		});

		test('7q: a parked refusal compacts beneath newer pending desire instead of overlaying', async () => {
			const authority = createKernelAuthority(LIFETIME);
			authority.submitBytes(
				requestBytes({
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_B,
					submissionNumber: 1,
					intents: [{ address: theme, op: 'replace', value: 'dark' }],
				}),
			);
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await (
				await replica.localWrite({
					address: theme,
					op: 'patch',
					set: { a: 1 },
					unset: [],
				})
			).commit();
			const seal = await replica.seal();
			await seal.transition.commit();
			// Newer pending desire arrives before settlement.
			await (
				await replica.localWrite({
					address: theme,
					op: 'patch',
					set: { b: 2 },
					unset: [],
				})
			).commit();
			const response = authority.submitBytes(seal.requestBytes);
			await applyWithCrashes(replica, await replica.settle(response));

			const lanes = await replica.record(theme);
			// No overlay is stored: pending = pending-composed-beneath-parked, one
			// operation per address, under the same composition law.
			expect(lanes?.parked).toBeNull();
			expect(lanes?.pending).toEqual({
				op: 'patch',
				set: { a: 1, b: 2 },
				unset: [],
			});
			await replica.dispose();
		});

		test('7t: a remembered parked result cannot overlay a newer tombstone at retry settlement', async () => {
			const authority = createKernelAuthority(LIFETIME);
			authority.submitBytes(
				requestBytes({
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_B,
					submissionNumber: 1,
					intents: [{ address: theme, op: 'replace', value: 'dark' }],
				}),
			);
			const replica = await binding.create({
				replicaId: REPLICA_ID,
				authorityLifetime: LIFETIME,
			});
			await (
				await replica.localWrite({
					address: theme,
					op: 'patch',
					set: { a: 1 },
					unset: [],
				})
			).commit();
			const seal = await replica.seal();
			await seal.transition.commit();
			// First adjudication parks; its response is lost.
			authority.submitBytes(seal.requestBytes);
			// Another replica terminally deletes the record before the retry.
			authority.submitBytes(
				requestBytes({
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_B,
					submissionNumber: 2,
					intents: [{ address: theme, op: 'tombstone' }],
				}),
			);
			// Exact retry with the persisted bytes returns the remembered parked
			// result plus the newer tombstone fact.
			const witness = await replica.sealedRequest();
			if (witness === null) throw new Error('seal persisted nothing');
			const retry = authority.submitBytes(witness.bytes);
			expect(retry.parked).toEqual([
				{ address: theme, code: 'patch-base-not-object' },
			]);
			expect(retry.facts[0]?.state).toBe('tombstone');

			await applyWithCrashes(replica, await replica.settle(retry));
			const lanes = await replica.record(theme);
			// The stored tombstone supersedes the parked overlay and its diagnostic.
			expect(lanes?.confirmed?.state).toBe('tombstone');
			expect(lanes?.parked).toBeNull();
			expect(lanes?.pending).toBeNull();
			await replica.dispose();
		});

		test('8: a feed-ahead tombstone dominates unsealed work while the sealed retry image survives', async () => {
			const { replica } = await sealedFixture();
			const firstSeal = await replica.sealedRequest();
			if (firstSeal === null) throw new Error('seal persisted nothing');
			const authority = createKernelAuthority(LIFETIME);
			const delayedSettlement = authority.submitBytes(firstSeal.bytes);
			// Newer pending desire exists beside the sealed lane.
			await (
				await replica.localWrite({
					address: recordB,
					op: 'replace',
					value: { z: 9 },
				})
			).commit();

			// The facts feed learns a tombstone at the sealed address plus an
			// unrelated live fact, and advances the cursor, in one transaction.
			await applyWithCrashes(
				replica,
				await replica.installFacts({
					request: { authorityLifetime: LIFETIME, afterSequence: 0 },
					response: {
						authorityLifetime: LIFETIME,
						facts: [
							{ address: recordB, sequence: 8, state: 'tombstone' },
							{
								address: theme,
								sequence: 10,
								state: 'live',
								payload: 'dark',
							},
						],
						hasMore: false,
					},
				}),
				async (crashed) => {
					expect(await crashed.sealedRequest()).toEqual(firstSeal);
				},
			);

			const lanes = await replica.record(recordB);
			expect(lanes?.confirmed).toEqual({ state: 'tombstone', sequence: 8 });
			expect(lanes?.pending).toBeNull(); // dominated as superseded
			expect(lanes?.sealed).toEqual({ op: 'replace', value: { z: 1 } }); // retry image untouched
			expect(await replica.sealedRequest()).toEqual(firstSeal);
			expect((await replica.sync()).afterSequence).toBe(10);
			expect((await replica.record(theme))?.confirmed).toEqual({
				state: 'live',
				payload: 'dark',
				sequence: 10,
			});
			await expect(
				(async () => {
					const transition = await replica.installFacts({
						request: { authorityLifetime: LIFETIME, afterSequence: 0 },
						response: {
							authorityLifetime: LIFETIME,
							facts: [],
							hasMore: false,
						},
					});
					await transition.commit();
				})(),
			).rejects.toThrow(/facts page stale request/);
			expect((await replica.sync()).afterSequence).toBe(10);

			// Submission facts do not advance the feed cursor. A delayed settlement
			// therefore installs record A, ignores record B's older sequence, and
			// retires the exact sealed image without weakening the tombstone.
			await applyWithCrashes(replica, await replica.settle(delayedSettlement));
			expect((await replica.record(recordA))?.confirmed).toEqual({
				state: 'live',
				payload: 1,
				sequence: 1,
			});
			expect((await replica.record(recordB))?.confirmed).toEqual({
				state: 'tombstone',
				sequence: 8,
			});
			expect((await replica.sync()).afterSequence).toBe(10);
			expect(await replica.sealedRequest()).toBeNull();

			// An equal sequence with different content is corruption, even through
			// an otherwise context-valid settlement response.
			await (
				await replica.localWrite({
					address: recordA,
					op: 'replace',
					value: 'newer',
				})
			).commit();
			const secondSeal = await replica.seal();
			await secondSeal.transition.commit();
			await expect(
				(async () => {
					const transition = await replica.settle({
						authorityLifetime: LIFETIME,
						facts: [
							{
								address: recordA,
								sequence: 1,
								state: 'live',
								payload: 'conflict',
							},
						],
						parked: [],
					});
					await transition.commit();
				})(),
			).rejects.toThrow(/corruption/);
			await replica.dispose();
		});

		test('11: a superseded replica erases and reacquires from zero under the successor lifetime', async () => {
			const { replica } = await sealedFixture();
			// A response carrying a different lifetime is a terminal mismatch on
			// every installation path (ADR-0163): the store refuses a mismatched
			// facts page and a mismatched settlement response alike, forcing
			// erase-and-reacquire, and the refusal leaves the sealed retry
			// witness untouched.
			await expect(
				(async () => {
					const transition = await replica.installFacts({
						request: {
							authorityLifetime: LIFETIME,
							afterSequence: 0,
						},
						response: {
							authorityLifetime: 'lifetime-two',
							facts: [],
							hasMore: false,
						},
					});
					await transition.commit();
				})(),
			).rejects.toThrow(/facts page lifetime/);
			await expect(
				(async () => {
					const transition = await replica.settle({
						authorityLifetime: 'lifetime-two',
						facts: [],
						parked: [],
					});
					await transition.commit();
				})(),
			).rejects.toThrow(/lifetime mismatch/);
			expect(await replica.sealedRequest()).not.toBeNull();

			await (await replica.erase()).commit();
			await expect(
				(async () => {
					const transition = await replica.installFacts({
						request: { afterSequence: 0 },
						response: {
							authorityLifetime: LIFETIME,
							facts: [],
							hasMore: false,
						},
					});
					await transition.commit();
				})(),
			).rejects.toThrow(/erased authority lifetime/);
			expect((await replica.sync()).authorityLifetime).toBeNull();
			// Reacquisition binds the successor lifetime and installs from zero.
			await applyWithCrashes(
				replica,
				await replica.installFacts({
					request: { afterSequence: 0 },
					response: {
						authorityLifetime: 'lifetime-two',
						facts: [
							{
								address: theme,
								sequence: 1,
								state: 'live',
								payload: 'dark',
							},
						],
						hasMore: false,
					},
				}),
			);
			const sync = await replica.sync();
			expect(sync.authorityLifetime).toBe('lifetime-two');
			expect(sync.afterSequence).toBe(1);
			expect(sync.nextSubmission).toBe(1);
			expect((await replica.record(theme))?.confirmed).toEqual({
				state: 'live',
				payload: 'dark',
				sequence: 1,
			});
			await replica.dispose();
		});
	});
}
