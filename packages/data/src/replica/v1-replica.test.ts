/**
 * V1 Replica Loop Tests
 *
 * Drives both synchronization loops against a scripted authority built on the
 * kernel's own reference model, so the loops are proven against the same
 * semantics the real authority realizes rather than against a hand-rolled fake.
 *
 * Key behaviors:
 * - The two loops make progress independently and neither sequences the other
 * - A facts page installs and advances `afterSequence` as one commit, and a
 *   crash before that commit repeats rather than skips
 * - Submission facts install monotonically but never advance `afterSequence`
 * - An exact submission retry resends the same number and intents
 * - A lifetime mismatch is terminal and distinct from transport trouble
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	type AuthorityState,
	createAuthority,
	type FactsRequest,
	type Intent,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	SCALAR_V1_LIMITS,
	type SubmissionRequest,
	submit,
} from '../protocol/v1/index.js';
import {
	openReplicaV1,
	type ScalarTransport,
	type TransportOutcome,
} from './v1-replica.js';
import { readMetadata, readVisibleFact } from './v1-store.js';

const LIFETIME = '01JQZX000000000000000000AB';
const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';

const ROW_A = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: 'row1aaaaaaaaaaaaaaaaaaaa',
} as const;
const ROW_B = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	tableName: 'rows',
	rowId: 'row2bbbbbbbbbbbbbbbbbbbb',
} as const;
const VALUE = {
	kind: 'value',
	namespace: 'so.epicenter.settings',
	valueName: 'theme',
} as const;

const limits = SCALAR_V1_LIMITS;

/**
 * An authority driven by the kernel's pure reference model.
 *
 * It records every request so a test can assert what the loops actually sent,
 * which is how exact-retry and independent-progress claims are checked rather
 * than assumed.
 */
function createScriptedAuthority(lifetime = LIFETIME) {
	let state: AuthorityState = expectOk(createAuthority(lifetime, limits));
	const factsRequests: FactsRequest[] = [];
	const submissions: SubmissionRequest[] = [];
	let failNextFacts = false;

	const transport: ScalarTransport = {
		async readFacts(request): Promise<TransportOutcome> {
			factsRequests.push(structuredClone(request));
			if (failNextFacts) {
				failNextFacts = false;
				throw new Error('network down');
			}
			const admitted = parseFactsRequest(request, limits);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = readFacts(state, admitted.data, limits);
			if (result.error !== null) {
				return result.error.name === 'LifetimeMismatch'
					? {
							kind: 'refused',
							refusal: {
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							},
						}
					: { kind: 'refused', refusal: { code: 'sequence-ahead' } };
			}
			return { kind: 'response', body: result.data };
		},
		async submit(request): Promise<TransportOutcome> {
			submissions.push(structuredClone(request));
			const admitted = parseSubmissionRequest(request, limits);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = submit(state, admitted.data, limits);
			if (result.error !== null) {
				const code =
					result.error.name === 'LifetimeMismatch'
						? ({
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							} as const)
						: result.error.name === 'SubmissionFork'
							? ({ code: 'submission-fork' } as const)
							: ({ code: 'submission-gap' } as const);
				return { kind: 'refused', refusal: code };
			}
			state = result.data.state;
			return { kind: 'response', body: result.data.response };
		},
	};

	return {
		transport,
		factsRequests,
		submissions,
		get state() {
			return state;
		},
		/** Write directly to the authority, as another replica would. */
		applyRemote(
			intents: Intent[],
			replicaId: string,
			submissionNumber: number,
		) {
			const request: SubmissionRequest = {
				authorityLifetime: state.lifetime,
				replicaId,
				submissionNumber,
				intents,
			};
			const admitted = expectOk(parseSubmissionRequest(request, limits));
			state = expectOk(submit(state, admitted, limits)).state;
		},
		breakNextFactsRequest() {
			failNextFacts = true;
		},
	};
}

function openAttachedReplica() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const replica = expectOk(openReplicaV1({ database }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	return { database, replica };
}

const patch = (
	address: typeof ROW_A | typeof ROW_B,
	set: Record<string, unknown>,
): Intent => ({ address, presence: 'present', set, unset: [] }) as Intent;

const remoteReplicaId = 'remoterrrrrrrrrrrrrrrrrr';

describe('the facts loop learns current authority state', () => {
	test('a fresh replica binds the lifetime and learns from zero', async () => {
		const authority = createScriptedAuthority();
		authority.applyRemote(
			[patch(ROW_A, { title: 'remote' })],
			remoteReplicaId,
			1,
		);
		const { database, replica } = openAttachedReplica();

		expectOk(await replica.pullFacts(authority.transport));

		expect(expectOk(replica.readRow(ROW_A))).toEqual({ title: 'remote' });
		const meta = readMetadata(database);
		expect(meta.authorityLifetime).toBe(LIFETIME);
		expect(meta.afterSequence).toBe(1);
	});

	test('the first request omits the lifetime and later requests supply it', async () => {
		const authority = createScriptedAuthority();
		authority.applyRemote([patch(ROW_A, { a: 1 })], remoteReplicaId, 1);
		const { replica } = openAttachedReplica();

		await replica.pullFacts(authority.transport);
		await replica.pullFacts(authority.transport);

		expect(authority.factsRequests[0]).toEqual({ afterSequence: 0 });
		expect(authority.factsRequests.at(-1)).toEqual({
			authorityLifetime: LIFETIME,
			afterSequence: 1,
		});
	});

	test('a learned terminal tombstone removes the row locally', async () => {
		const authority = createScriptedAuthority();
		authority.applyRemote([patch(ROW_A, { title: 'x' })], remoteReplicaId, 1);
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);
		expect(expectOk(replica.readRow(ROW_A))).toEqual({ title: 'x' });

		authority.applyRemote(
			[{ address: ROW_A, presence: 'absent' }],
			remoteReplicaId,
			2,
		);
		await replica.pullFacts(authority.transport);

		expect(expectOk(replica.readRow(ROW_A))).toBeUndefined();
	});

	/**
	 * ADR-0163 resumes after a committed prefix and repeats an uncommitted one. A
	 * transport failure leaves the watermark where it was, so the retry re-reads
	 * the same range and skips nothing.
	 */
	test('a failed request repeats rather than skipping the range', async () => {
		const authority = createScriptedAuthority();
		authority.applyRemote([patch(ROW_A, { a: 1 })], remoteReplicaId, 1);
		const { database, replica } = openAttachedReplica();

		authority.breakNextFactsRequest();
		const failed = await replica.pullFacts(authority.transport);
		expect(expectErr(failed).name).toBe('TransportFailed');
		expect(readMetadata(database).afterSequence).toBe(0);

		expectOk(await replica.pullFacts(authority.transport));
		expect(readMetadata(database).afterSequence).toBe(1);
		expect(expectOk(replica.readRow(ROW_A))).toEqual({ a: 1 });
	});

	test('an authority on a different lifetime is a terminal mismatch', async () => {
		const authority = createScriptedAuthority();
		authority.applyRemote([patch(ROW_A, { a: 1 })], remoteReplicaId, 1);
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		const successor = createScriptedAuthority('01JQZX111111111111111111CD');
		const failure = expectErr(await replica.pullFacts(successor.transport));

		expect(failure.name).toBe('LifetimeMismatch');
	});
});

describe('the submissions loop settles local work', () => {
	test('a local write survives a round trip and settles', async () => {
		const authority = createScriptedAuthority();
		const { database, replica } = openAttachedReplica();
		// The lifetime must be bound before the replica may submit.
		await replica.pullFacts(authority.transport);

		expectOk(replica.write(patch(ROW_A, { title: 'mine' })));
		// Local-first: visible immediately, before any network round trip.
		expect(expectOk(replica.readRow(ROW_A))).toEqual({ title: 'mine' });

		expectOk(await replica.pushSubmissions(authority.transport));

		expect(authority.submissions).toHaveLength(1);
		expect(authority.submissions[0]?.submissionNumber).toBe(1);
		expect(expectOk(replica.readRow(ROW_A))).toEqual({ title: 'mine' });
		// Settlement retires the work and leaves a confirmed fact behind.
		expect(readMetadata(database).lastSubmissionNumber).toBe(1);
		expect(readMetadata(database).sealedSubmissionNumber).toBeUndefined();
	});

	test('submission numbers increase by one across submissions', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		replica.write(patch(ROW_A, { a: 1 }));
		await replica.pushSubmissions(authority.transport);
		replica.write(patch(ROW_B, { b: 2 }));
		await replica.pushSubmissions(authority.transport);

		expect(authority.submissions.map((s) => s.submissionNumber)).toEqual([
			1, 2,
		]);
	});

	/**
	 * ADR-0163's central watermark rule: only the facts feed advances
	 * `afterSequence`. A settlement that moved it would let the replica skip
	 * facts written by other replicas in the same sequence range.
	 */
	test('settlement facts never advance the facts-feed watermark', async () => {
		const authority = createScriptedAuthority();
		const { database, replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);
		expect(readMetadata(database).afterSequence).toBe(0);

		replica.write(patch(ROW_A, { a: 1 }));
		expectOk(await replica.pushSubmissions(authority.transport));

		expect(readMetadata(database).afterSequence).toBe(0);
		// The facts feed still discovers the same fact afterwards, idempotently.
		expectOk(await replica.pullFacts(authority.transport));
		expect(readMetadata(database).afterSequence).toBe(1);
		expect(expectOk(replica.readRow(ROW_A))).toEqual({ a: 1 });
	});

	test('nothing pending sends no submission', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		const result = expectOk(await replica.pushSubmissions(authority.transport));

		expect(result.kind).toBe('idle');
		expect(authority.submissions).toHaveLength(0);
	});

	/**
	 * The pass that used to spin. With the lifetime unbound a replica may not
	 * submit, but reporting that as pending work told the caller to run again
	 * immediately, and nothing here consumes work, so the loop had no exit. In a
	 * browser that starved the worker's message queue on microtasks and no read
	 * could be served while the facts feed was unreachable.
	 */
	test('an unbound authority lifetime is reported as no work, not pending work', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		replica.write(patch(ROW_A, { title: 'offline' }));

		// No facts read yet, so the lifetime is unbound.
		const result = expectOk(await replica.pushSubmissions(authority.transport));

		expect(result.kind).toBe('awaiting-lifetime');
		expect(authority.submissions).toHaveLength(0);
	});

	/**
	 * A lost response must retry the same replica id, number, and semantic
	 * intents. The authority's ledger is what turns that into an idempotent
	 * application rather than a double write.
	 */
	test('a lost response retries the exact same submission', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);
		replica.write(patch(ROW_A, { a: 1 }));

		// Drop the first response entirely, as a lost reply would.
		const dropping: ScalarTransport = {
			readFacts: authority.transport.readFacts,
			async submit(request) {
				await authority.transport.submit(request);
				throw new Error('response lost');
			},
		};
		expect(expectErr(await replica.pushSubmissions(dropping)).name).toBe(
			'TransportFailed',
		);

		expectOk(await replica.pushSubmissions(authority.transport));

		expect(authority.submissions).toHaveLength(2);
		expect(authority.submissions[0]).toEqual(authority.submissions[1]);
	});
});

describe('the two loops progress independently', () => {
	/**
	 * Neither loop is a phase of the other. A facts feed that cannot reach the
	 * authority must not stop local work from settling, and vice versa.
	 */
	test('the submissions loop still settles while the facts feed is failing', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		replica.write(patch(ROW_A, { a: 1 }));
		authority.breakNextFactsRequest();

		expect(expectErr(await replica.pullFacts(authority.transport)).name).toBe(
			'TransportFailed',
		);
		expectOk(await replica.pushSubmissions(authority.transport));

		expect(authority.submissions).toHaveLength(1);
	});

	test('a remote write and a local write converge on both sides', async () => {
		const authority = createScriptedAuthority();
		const { replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		authority.applyRemote([patch(ROW_B, { remote: true })], remoteReplicaId, 1);
		replica.write(patch(ROW_A, { local: true }));

		expectOk(await replica.pushSubmissions(authority.transport));
		expectOk(await replica.pullFacts(authority.transport));

		expect(expectOk(replica.readRow(ROW_A))).toEqual({ local: true });
		expect(expectOk(replica.readRow(ROW_B))).toEqual({ remote: true });
	});
});

describe('the visible projection never disagrees with the fold', () => {
	/**
	 * The projection is derived state, so the only thing that makes it safe is
	 * that every mutation refreshes it. Settlement was the path that did not:
	 * retiring a sealed intent removed the overlay from the fold while leaving
	 * the projection showing it, so a table scan and a typed read disagreed
	 * about the same row.
	 *
	 * Checked by recomputing the fold and comparing, rather than by asserting a
	 * specific value, so this catches any future mutation path that forgets.
	 */
	function expectProjectionMatchesFold(
		database: ReturnType<typeof createBunSqliteAdapter>,
		address: typeof ROW_A | typeof VALUE,
	) {
		const folded = readVisibleFact(database, address);
		const projected =
			address.kind === 'row'
				? database.all<{ presence: string; fields: string | null }>(
						`SELECT presence, fields FROM main._replica_v1_visible_rows
						WHERE namespace = ? AND table_name = ? AND row_id = ?`,
						[address.namespace, address.tableName, address.rowId],
					)[0]
				: database.all<{ presence: string; content: string | null }>(
						`SELECT presence, content FROM main._replica_v1_visible_values
						WHERE namespace = ? AND value_name = ?`,
						[address.namespace, address.valueName],
					)[0];

		if (folded === undefined) {
			expect(projected).toBeUndefined();
			return;
		}
		expect(projected?.presence).toBe(folded.presence);
		if ('fields' in folded) {
			expect(JSON.parse((projected as { fields: string }).fields)).toEqual(
				folded.fields,
			);
		}
		if ('content' in folded) {
			expect(JSON.parse((projected as { content: string }).content)).toEqual(
				folded.content,
			);
		}
	}

	test('it stays in step across a full write and settle cycle', async () => {
		const authority = createScriptedAuthority();
		const { database, replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		replica.write(patch(ROW_A, { title: 'mine' }));
		expectProjectionMatchesFold(database, ROW_A);

		expectOk(await replica.pushSubmissions(authority.transport));
		// The overlay is retired here and the settled fact stands alone.
		expectProjectionMatchesFold(database, ROW_A);

		expectOk(await replica.pullFacts(authority.transport));
		expectProjectionMatchesFold(database, ROW_A);
	});

	/**
	 * The interleaving ADR-0163 names: a delayed submission response carrying an
	 * older fact than the facts feed already installed. The response fact is
	 * ignored as stale, but the sealed intent still retires, and the overlay it
	 * was contributing has to come off the projection with it.
	 *
	 * This is the only shape where retirement changes visible state, because
	 * ordinarily a settled fact already contains its own intent's effect.
	 */
	test('it stays in step when settlement is overtaken by a newer fact', async () => {
		const authority = createScriptedAuthority();
		const { database, replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);
		replica.write(patch(ROW_A, { title: 'mine' }));

		// While this submission is in flight, another replica rewrites the same
		// address and this replica learns it, so the response arrives stale.
		const overtaking: ScalarTransport = {
			readFacts: authority.transport.readFacts,
			async submit(request) {
				const outcome = await authority.transport.submit(request);
				// The same field, so the retired overlay and the newer fact actually
				// disagree. A remote write to a different field would fold to the
				// same result either way and prove nothing.
				authority.applyRemote(
					[patch(ROW_A, { title: 'theirs' })],
					remoteReplicaId,
					1,
				);
				await replica.pullFacts(authority.transport);
				return outcome;
			},
		};
		expectOk(await replica.pushSubmissions(overtaking));

		expectProjectionMatchesFold(database, ROW_A);
	});

	test('it stays in step for values and for a learned tombstone', async () => {
		const authority = createScriptedAuthority();
		const { database, replica } = openAttachedReplica();
		await replica.pullFacts(authority.transport);

		replica.write({
			address: VALUE,
			presence: 'present',
			content: 'dark',
		} as Intent);
		expectOk(await replica.pushSubmissions(authority.transport));
		expectProjectionMatchesFold(database, VALUE);

		replica.write(patch(ROW_A, { title: 'doomed' }));
		expectOk(await replica.pushSubmissions(authority.transport));
		authority.applyRemote(
			[{ address: ROW_A, presence: 'absent' }],
			remoteReplicaId,
			1,
		);
		expectOk(await replica.pullFacts(authority.transport));
		expectProjectionMatchesFold(database, ROW_A);
	});
});

describe('two replicas converge through the same authority', () => {
	test('each learns the other’s writes', async () => {
		const authority = createScriptedAuthority();
		const first = openAttachedReplica();
		const second = openAttachedReplica();
		await first.replica.pullFacts(authority.transport);
		await second.replica.pullFacts(authority.transport);

		first.replica.write(patch(ROW_A, { from: 'first' }));
		second.replica.write(patch(ROW_B, { from: 'second' }));
		expectOk(await first.replica.pushSubmissions(authority.transport));
		expectOk(await second.replica.pushSubmissions(authority.transport));

		expectOk(await first.replica.pullFacts(authority.transport));
		expectOk(await second.replica.pullFacts(authority.transport));

		for (const { replica } of [first, second]) {
			expect(expectOk(replica.readRow(ROW_A))).toEqual({ from: 'first' });
			expect(expectOk(replica.readRow(ROW_B))).toEqual({ from: 'second' });
		}
	});

	test('a value set on one replica reaches the other', async () => {
		const authority = createScriptedAuthority();
		const first = openAttachedReplica();
		const second = openAttachedReplica();
		await first.replica.pullFacts(authority.transport);
		await second.replica.pullFacts(authority.transport);

		first.replica.write({
			address: VALUE,
			presence: 'present',
			content: 'dark',
		} as Intent);
		expectOk(await first.replica.pushSubmissions(authority.transport));
		expectOk(await second.replica.pullFacts(authority.transport));

		expect(expectOk(second.replica.readValue(VALUE))).toBe('dark');
	});
});
