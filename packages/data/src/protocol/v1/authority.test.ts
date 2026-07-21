/**
 * Scalar V1 Reference Authority Tests
 *
 * Proves the authority state machine that Wave 2c will realize over SQLite:
 * numbered submissions, exact retry (including under concurrent rewrites and
 * tombstones), fork and gap refusal, lifetime binding, the fact feed, direct
 * settlement facts, terminal tombstones, bounded parked results, sequence
 * safety, and strict ownership, all as pure state transitions over admitted
 * inputs.
 *
 * Key behaviors:
 * - A sequence is assigned only when the current fact changes, and never beyond
 *   the JSON-safe range
 * - `afterSequence` is the only fact-feed progress coordinate; prefixes page by
 *   bytes and `hasMore` comes from one snapshot
 * - Exact retry returns newer current facts while preserving original
 *   adjudication and parked results
 * - Every response, ledger entry, and successor state is detached: mutating one
 *   never affects another
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	type AuthorityState,
	admitFactsPage,
	createAuthority,
	encodedFactBytes,
	type Fact,
	type Intent,
	minimumFactsResponseBytes,
	type RowAddress,
	readFacts,
	type SubmissionRequest,
	submit,
	type ValueAddress,
} from './index.js';
import {
	admitFacts,
	admitSubmission,
	BASE_LIMITS,
	makeAuthority,
	makeLimits,
} from './kernel.test-support.js';

const LIMITS = makeLimits();
const LIFETIME = 'lifetime-one';
const OTHER_LIFETIME = 'lifetime-two';
const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const REPLICA_B = 'ssssssssssssssssssssssss';

const valueAt = (key: string): ValueAddress => ({
	kind: 'value',
	namespace: 'so.epicenter.settings',
	value: key,
});
const rowId = (index: number): string => String(index).padStart(24, 'a');
const rowAt = (index: number): RowAddress => ({
	kind: 'row',
	namespace: 'so.epicenter.notes',
	table: 'recordings',
	rowId: rowId(index),
});
const setValue = (key: string, content: string): Intent => ({
	address: valueAt(key),
	presence: 'present',
	content,
});
const patchRow = (index: number, set: Record<string, string>): Intent => ({
	address: rowAt(index),
	presence: 'present',
	set,
	unset: [],
});
const deleteRow = (index: number): Intent => ({
	address: rowAt(index),
	presence: 'absent',
});

const sub = (
	submissionNumber: number,
	intents: Intent[],
	overrides: Partial<
		Pick<SubmissionRequest, 'authorityLifetime' | 'replicaId'>
	> = {},
): SubmissionRequest => ({
	authorityLifetime: overrides.authorityLifetime ?? LIFETIME,
	replicaId: overrides.replicaId ?? REPLICA,
	submissionNumber,
	intents,
});

/** Submit an admitted submission expected to succeed and return the next state. */
const advance = (
	state: AuthorityState,
	request: SubmissionRequest,
	limits = LIMITS,
): AuthorityState =>
	expectOk(submit(state, admitSubmission(request, limits), limits)).state;

const factContent = (fact: Fact | undefined): unknown =>
	fact !== undefined && fact.presence === 'present' && 'content' in fact
		? fact.content
		: undefined;
const factFields = (fact: Fact | undefined): unknown =>
	fact !== undefined && fact.presence === 'present' && 'fields' in fact
		? fact.fields
		: undefined;

describe('fresh authority', () => {
	test('starts at sequence one with no facts', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		expect(state.nextSequence).toBe(1);
		expect(state.facts.size).toBe(0);
		expect(
			expectOk(
				readFacts(state, admitFacts({ afterSequence: 0 }, LIMITS), LIMITS),
			),
		).toEqual({
			authorityLifetime: LIFETIME,
			facts: [],
			hasMore: false,
		});
	});
});

describe('sequence assignment', () => {
	test('a sequence is spent only when the current fact changes', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('theme', 'dark')]));
		expect(state.nextSequence).toBe(2);
		// An idempotent set spends nothing; installing a tombstone spends one.
		const next = advance(
			state,
			sub(2, [setValue('theme', 'dark'), deleteRow(9)]),
		);
		expect(next.nextSequence).toBe(3);
	});

	test('an idempotent-only submission spends no sequence', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('theme', 'dark')]));
		expect(
			advance(state, sub(2, [setValue('theme', 'dark')])).nextSequence,
		).toBe(state.nextSequence);
	});

	test('refuses before assigning a sequence beyond the JSON-safe range', () => {
		// A hand-built state whose next sequence is the maximum safe integer.
		const nearMax: AuthorityState = {
			lifetime: LIFETIME,
			nextSequence: Number.MAX_SAFE_INTEGER,
			facts: new Map(),
			replicas: new Map(),
		};
		// Two changes: the first takes the last safe sequence, the second overflows.
		const error = expectErr(
			submit(
				nearMax,
				admitSubmission(
					sub(1, [setValue('a', '1'), setValue('b', '2')]),
					LIMITS,
				),
				LIMITS,
			),
		);
		expect(error.name).toBe('SequenceExhausted');
		expect(nearMax.facts.size).toBe(0); // atomic: nothing committed
	});
});

describe('submission numbering', () => {
	test('the first submission must be number one', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		expect(
			expectErr(
				submit(
					state,
					admitSubmission(sub(2, [setValue('a', '1')]), LIMITS),
					LIMITS,
				),
			).name,
		).toBe('SubmissionGap');
		expectOk(
			submit(
				state,
				admitSubmission(sub(1, [setValue('a', '1')]), LIMITS),
				LIMITS,
			),
		);
	});

	test('a skipped number is refused', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('a', '1')]));
		expect(
			expectErr(
				submit(
					state,
					admitSubmission(sub(3, [setValue('b', '2')]), LIMITS),
					LIMITS,
				),
			).name,
		).toBe('SubmissionGap');
		state = advance(state, sub(2, [setValue('b', '2')]));
		expect(state.nextSequence).toBe(3);
	});

	test('exact retry of the last number is idempotent and does not advance state', () => {
		const request = admitSubmission(sub(1, [setValue('a', '1')]), LIMITS);
		const first = expectOk(
			submit(makeAuthority(LIFETIME, LIMITS), request, LIMITS),
		);
		const retry = expectOk(submit(first.state, request, LIMITS));
		expect(retry.state.nextSequence).toBe(first.state.nextSequence);
		expect(retry.response.facts).toEqual(first.response.facts);
	});

	test('reusing the last number with different content forks', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('a', '1')]));
		expect(
			expectErr(
				submit(
					state,
					admitSubmission(sub(1, [setValue('a', 'changed')]), LIMITS),
					LIMITS,
				),
			).name,
		).toBe('SubmissionFork');
	});

	test('each replica owns an independent numbered stream', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(
			state,
			sub(1, [setValue('a', '1')], { replicaId: REPLICA }),
		);
		state = advance(
			state,
			sub(1, [setValue('b', '2')], { replicaId: REPLICA_B }),
		);
		expect(state.nextSequence).toBe(3);
	});
});

describe('lifetime binding', () => {
	test('a submission for another lifetime is refused', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		expect(
			expectErr(
				submit(
					state,
					admitSubmission(
						sub(1, [setValue('a', '1')], { authorityLifetime: OTHER_LIFETIME }),
						LIMITS,
					),
					LIMITS,
				),
			).name,
		).toBe('LifetimeMismatch');
	});

	test('a facts read for another lifetime is refused', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		expect(
			expectErr(
				readFacts(
					state,
					admitFacts(
						{ afterSequence: 0, authorityLifetime: OTHER_LIFETIME },
						LIMITS,
					),
					LIMITS,
				),
			).name,
		).toBe('LifetimeMismatch');
	});

	test('the facts response supplies the active lifetime for a fresh replica', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		expect(
			expectOk(
				readFacts(state, admitFacts({ afterSequence: 0 }, LIMITS), LIMITS),
			).authorityLifetime,
		).toBe(LIFETIME);
	});
});

describe('fact feed', () => {
	test('bounded prefixes page forward and hasMore comes from one snapshot', () => {
		// Facts near the encoded-fact ceiling so only one fits a tight but valid
		// response budget, forcing single-fact prefixes.
		const big = 'x'.repeat(3800);
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(
			state,
			sub(1, [setValue('a', big), setValue('b', big), setValue('c', big)]),
		);
		const tight = makeLimits({ maxFactsResponseBytes: 6000 });

		const first = expectOk(
			readFacts(state, admitFacts({ afterSequence: 0 }, tight), tight),
		);
		expect(first.facts).toHaveLength(1);
		expect(first.facts[0]?.sequence).toBe(1);
		expect(first.hasMore).toBe(true);

		const second = expectOk(
			readFacts(
				state,
				admitFacts({ afterSequence: 1, authorityLifetime: LIFETIME }, tight),
				tight,
			),
		);
		expect(second.facts[0]?.sequence).toBe(2);
		expect(second.hasMore).toBe(true);

		const third = expectOk(
			readFacts(
				state,
				admitFacts({ afterSequence: 2, authorityLifetime: LIFETIME }, tight),
				tight,
			),
		);
		expect(third.facts[0]?.sequence).toBe(3);
		expect(third.hasMore).toBe(false);
	});

	test('a sequence ahead of the active authority in the same lifetime is corruption', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('a', '1')]));
		expect(
			expectErr(
				readFacts(
					state,
					admitFacts(
						{ afterSequence: 99, authorityLifetime: LIFETIME },
						LIMITS,
					),
					LIMITS,
				),
			).name,
		).toBe('SequenceAhead');
	});

	test('a concurrently rewritten fact moves to a higher sequence and stays discoverable', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('theme', 'dark')]));
		state = advance(state, sub(2, [setValue('theme', 'light')]));
		const seen = expectOk(
			readFacts(
				state,
				admitFacts({ afterSequence: 1, authorityLifetime: LIFETIME }, LIMITS),
				LIMITS,
			),
		);
		expect(seen.facts).toHaveLength(1);
		expect(seen.facts[0]?.sequence).toBe(2);
		expect(factContent(seen.facts[0])).toBe('light');
	});

	test('a rewrite between pages still makes forward progress', () => {
		const big = 'x'.repeat(3800);
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(
			state,
			sub(1, [setValue('a', big), setValue('b', big), setValue('c', big)]),
		);
		const tight = makeLimits({ maxFactsResponseBytes: 6000 });
		// Read page one (sequence 1), then a rewrite of 'a' moves it to sequence 4.
		const page1 = expectOk(
			readFacts(state, admitFacts({ afterSequence: 0 }, tight), tight),
		);
		expect(page1.facts[0]?.sequence).toBe(1);
		state = advance(state, sub(2, [setValue('a', `${big}z`)]));
		// Resuming after sequence 1 skips nothing and surfaces the rewrite at 4.
		const sequences: number[] = [];
		let after = 1;
		for (let step = 0; step < 5; step += 1) {
			const page = expectOk(
				readFacts(
					state,
					admitFacts(
						{ afterSequence: after, authorityLifetime: LIFETIME },
						tight,
					),
					tight,
				),
			);
			for (const fact of page.facts) sequences.push(fact.sequence);
			if (!page.hasMore) break;
			after = page.facts.at(-1)?.sequence ?? after;
		}
		expect(sequences).toEqual([2, 3, 4]);
	});
});

describe('direct settlement facts', () => {
	test('returns one current fact per distinct touched address in sealed order', () => {
		const result = expectOk(
			submit(
				makeAuthority(LIFETIME, LIMITS),
				admitSubmission(
					sub(1, [
						patchRow(2, { n: 'c' }),
						patchRow(0, { n: 'a' }),
						setValue('k', 'v'),
					]),
					LIMITS,
				),
				LIMITS,
			),
		);
		expect(result.response.facts.map((fact) => fact.address)).toEqual([
			rowAt(2),
			rowAt(0),
			valueAt('k'),
		]);
	});

	test('the settlement response carries only facts and parked, never a receipt', () => {
		const result = expectOk(
			submit(
				makeAuthority(LIFETIME, LIMITS),
				admitSubmission(sub(1, [setValue('a', '1')]), LIMITS),
				LIMITS,
			),
		);
		expect(Object.keys(result.response).sort()).toEqual([
			'authorityLifetime',
			'facts',
			'parked',
		]);
	});

	test('a deleted row settles a later row-present intent to the tombstone', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [patchRow(0, { title: 'A' })]));
		state = advance(state, sub(2, [deleteRow(0)]));
		const result = expectOk(
			submit(
				state,
				admitSubmission(sub(3, [patchRow(0, { title: 'B' })]), LIMITS),
				LIMITS,
			),
		);
		expect(result.response.facts[0]?.presence).toBe('absent');
	});
});

describe('parked fact-too-large', () => {
	const tight = makeLimits({ maxEncodedFactBytes: 420 });
	const big = 'x'.repeat(150);

	test('a patch over a different live base is parked while the live row stays', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [patchRow(0, { a: big })]), tight);
		const result = expectOk(
			submit(
				state,
				admitSubmission(sub(2, [patchRow(0, { b: big })]), tight),
				tight,
			),
		);
		expect(result.response.parked).toHaveLength(1);
		expect(result.response.parked[0]?.code).toBe('fact-too-large');
		expect(result.response.parked[0]?.limitBytes).toBe(
			tight.maxEncodedFactBytes,
		);
		expect(result.response.parked[0]?.measuredBytes).toBeGreaterThan(
			tight.maxEncodedFactBytes,
		);
		expect(factFields(result.response.facts[0])).toEqual({ a: big });
		expect(result.state.nextSequence).toBe(state.nextSequence);
	});

	test('exact retry returns the same stable parked result', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [patchRow(0, { a: big })]), tight);
		const request = admitSubmission(sub(2, [patchRow(0, { b: big })]), tight);
		const first = expectOk(submit(state, request, tight));
		const retry = expectOk(submit(first.state, request, tight));
		expect(retry.response.parked).toEqual(first.response.parked);
	});

	test('parked retry after another replica tombstones the row keeps parked and returns the tombstone', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [patchRow(0, { a: big })]), tight);
		const parkingRequest = admitSubmission(
			sub(2, [patchRow(0, { b: big })]),
			tight,
		);
		const parked = expectOk(submit(state, parkingRequest, tight));
		// Another replica deletes the row.
		const tombstoned = advance(
			parked.state,
			sub(1, [deleteRow(0)], { replicaId: REPLICA_B }),
			tight,
		);
		// The original replica retries its parked submission.
		const retry = expectOk(submit(tombstoned, parkingRequest, tight));
		expect(retry.response.parked).toEqual(parked.response.parked);
		expect(retry.response.facts[0]?.presence).toBe('absent');
	});
});

describe('exact retry under concurrent rewrite', () => {
	test('returns the newer current fact while preserving original adjudication', () => {
		const request = admitSubmission(sub(1, [setValue('k', 'a')]), LIMITS);
		const first = expectOk(
			submit(makeAuthority(LIFETIME, LIMITS), request, LIMITS),
		);
		// A different replica rewrites the same address.
		const rewritten = advance(
			first.state,
			sub(1, [setValue('k', 'b')], { replicaId: REPLICA_B }),
		);
		const retry = expectOk(submit(rewritten, request, LIMITS));
		expect(factContent(retry.response.facts[0])).toBe('b');
		// Original adjudication preserved: no new sequence, no state change.
		expect(retry.state.nextSequence).toBe(rewritten.nextSequence);
	});
});

describe('atomic transition', () => {
	test('a refused submission leaves the prior state unchanged', () => {
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [setValue('a', '1')]));
		const before = state.nextSequence;
		expectErr(
			submit(
				state,
				admitSubmission(sub(5, [setValue('b', '2')]), LIMITS),
				LIMITS,
			),
		);
		expect(state.nextSequence).toBe(before);
		expect(state.facts.size).toBe(1);
	});

	test('a successful submission returns a new state without mutating the old one', () => {
		const state = makeAuthority(LIFETIME, LIMITS);
		const next = advance(state, sub(1, [setValue('a', '1')]));
		expect(state.facts.size).toBe(0);
		expect(next.facts.size).toBe(1);
		expect(next).not.toBe(state);
	});
});

describe('ownership and mutation isolation', () => {
	test('mutating the admitted request after submit does not change stored facts', () => {
		const admitted = admitSubmission(
			sub(1, [patchRow(0, { title: 'A' })]),
			LIMITS,
		);
		const result = expectOk(
			submit(makeAuthority(LIFETIME, LIMITS), admitted, LIMITS),
		);
		// The admitted request is sealed, so a mutation attempt throws; the stored
		// fact is unaffected either way.
		const intent = admitted.intents[0];
		if (intent?.presence === 'present' && 'set' in intent) {
			expect(() => {
				(intent.set as Record<string, string>).title = 'MUTATED';
			}).toThrow();
		}
		expect(factFields([...result.state.facts.values()][0])).toEqual({
			title: 'A',
		});
	});

	test('mutating returned facts does not change authority state', () => {
		const result = expectOk(
			submit(
				makeAuthority(LIFETIME, LIMITS),
				admitSubmission(sub(1, [patchRow(0, { title: 'A' })]), LIMITS),
				LIMITS,
			),
		);
		const returned = result.response.facts[0];
		if (returned?.presence === 'present' && 'fields' in returned)
			returned.fields.title = 'MUTATED';
		expect(factFields([...result.state.facts.values()][0])).toEqual({
			title: 'A',
		});
	});

	test('mutating a returned facts-feed fact does not change authority state', () => {
		const state = advance(
			makeAuthority(LIFETIME, LIMITS),
			sub(1, [setValue('a', '1')]),
		);
		const read = expectOk(
			readFacts(state, admitFacts({ afterSequence: 0 }, LIMITS), LIMITS),
		);
		const fact = read.facts[0];
		if (fact !== undefined) fact.sequence = 999;
		const reread = expectOk(
			readFacts(state, admitFacts({ afterSequence: 0 }, LIMITS), LIMITS),
		);
		expect(reread.facts[0]?.sequence).toBe(1);
	});

	test('mutating parked metadata does not change the remembered ledger result', () => {
		const tight = makeLimits({ maxEncodedFactBytes: 420 });
		const big = 'x'.repeat(150);
		let state = makeAuthority(LIFETIME, LIMITS);
		state = advance(state, sub(1, [patchRow(0, { a: big })]), tight);
		const request = admitSubmission(sub(2, [patchRow(0, { b: big })]), tight);
		const first = expectOk(submit(state, request, tight));
		const parked = first.response.parked[0];
		if (parked !== undefined) parked.measuredBytes = 0;
		const retry = expectOk(submit(first.state, request, tight));
		expect(retry.response.parked[0]?.measuredBytes).toBeGreaterThan(
			tight.maxEncodedFactBytes,
		);
	});

	test('mutating a successor state fact does not change the predecessor', () => {
		const predecessor = advance(
			makeAuthority(LIFETIME, LIMITS),
			sub(1, [patchRow(0, { title: 'A' })]),
		);
		const successor = advance(predecessor, sub(2, [setValue('k', 'v')]));
		const carried = [...successor.facts.values()].find(
			(fact) => fact.presence === 'present' && 'fields' in fact,
		);
		if (carried?.presence === 'present' && 'fields' in carried)
			carried.fields.title = 'MUTATED';
		expect(factFields([...predecessor.facts.values()][0])).toEqual({
			title: 'A',
		});
	});

	test('a carried ledger is not shared between predecessor and successor', () => {
		// Replica A submits, then replica B submits, producing a successor that
		// carries A's ledger.
		const afterA = advance(
			makeAuthority(LIFETIME, LIMITS),
			sub(1, [setValue('a', '1')], { replicaId: REPLICA }),
		);
		const afterB = advance(
			afterA,
			sub(1, [setValue('b', '2')], { replicaId: REPLICA_B }),
		);
		const ledgerA1 = afterA.replicas.get(REPLICA);
		const ledgerA2 = afterB.replicas.get(REPLICA);
		expect(ledgerA1).not.toBe(ledgerA2); // distinct objects
		// Mutate the successor's copy of A's touched addresses.
		const touched = ledgerA2?.touchedAddresses[0];
		if (touched !== undefined && touched.kind === 'value')
			touched.value = 'MUTATED';
		// A's exact retry against the predecessor is unaffected.
		const retry = expectOk(
			submit(
				afterA,
				admitSubmission(
					sub(1, [setValue('a', '1')], { replicaId: REPLICA }),
					LIMITS,
				),
				LIMITS,
			),
		);
		expect(retry.response.facts[0]?.address).toEqual(valueAt('a'));
	});

	test('a sealed admitted submission cannot be mutated after parsing', () => {
		const admitted = admitSubmission(
			sub(1, [patchRow(0, { title: 'A' })]),
			LIMITS,
		);
		// Frozen at every level: pushing an intent, replacing an address coordinate,
		// and editing a nested payload all throw under strict mode.
		expect(() => {
			(admitted.intents as Intent[]).push(setValue('x', 'y'));
		}).toThrow();
		const intent = admitted.intents[0];
		if (intent?.presence === 'present' && 'set' in intent) {
			expect(() => {
				(intent.set as Record<string, string>).title = 'MUTATED';
			}).toThrow();
			expect(() => {
				(intent.address as { rowId: string }).rowId = rowId(9);
			}).toThrow();
		}
	});
});

describe('authority lifetime admission', () => {
	test('empty, oversized, and lone-surrogate lifetimes refuse', () => {
		expectErr(createAuthority('', LIMITS));
		expectErr(createAuthority('x'.repeat(65), LIMITS));
		expectErr(createAuthority(`L${String.fromCharCode(0xd800)}`, LIMITS));
	});

	test('a non-string lifetime is total: numbers, null, symbols, and proxies refuse without throwing', () => {
		// A number must not coerce to a string; a hostile proxy must not throw. The
		// `typeof` guard short-circuits before any string method or trap runs.
		const throwingProxy = new Proxy(
			{},
			{
				get() {
					throw new Error('trap');
				},
			},
		);
		for (const lifetime of [
			42,
			0,
			Number.NaN,
			true,
			null,
			undefined,
			Symbol('lifetime'),
			{ toString: () => 'coerced' },
			['lifetime'],
			throwingProxy,
		]) {
			expect(() => createAuthority(lifetime, LIMITS)).not.toThrow();
			expectErr(createAuthority(lifetime, LIMITS));
		}
	});

	test('a created authority emits a request-compatible facts page', () => {
		const state = advance(
			makeAuthority(LIFETIME, LIMITS),
			sub(1, [setValue('a', '1')]),
		);
		const request = admitFacts({ afterSequence: 0 }, LIMITS);
		const response = expectOk(readFacts(state, request, LIMITS));
		expectOk(admitFactsPage(response, request, request, LIMITS));
	});

	test('a maximally escaped lifetime still makes fact-feed progress at the minimum ceiling', () => {
		// A control-char lifetime expands 6x under canonicalization. With the
		// facts-response ceiling at exactly the derived minimum, one fact must still
		// fit, so readFacts never returns empty facts with hasMore true.
		const maxLifetimeBytes = 16;
		const maxEncodedFactBytes = 200;
		const escaped = '\u0000'.repeat(maxLifetimeBytes);
		const draft = { ...BASE_LIMITS, maxLifetimeBytes, maxEncodedFactBytes };
		const limits = makeLimits({
			maxLifetimeBytes,
			maxEncodedFactBytes,
			maxFactsResponseBytes: minimumFactsResponseBytes(draft),
		});
		let state = makeAuthority(escaped, limits);
		state = expectOk(
			submit(
				state,
				admitSubmission(
					{
						authorityLifetime: escaped,
						replicaId: REPLICA,
						submissionNumber: 1,
						intents: [setValue('a', '1')],
					},
					limits,
				),
				limits,
			),
		).state;
		const read = expectOk(
			readFacts(
				state,
				admitFacts({ afterSequence: 0, authorityLifetime: escaped }, limits),
				limits,
			),
		);
		expect(read.facts.length).toBeGreaterThan(0);
	});

	test('a maximum-size terminal fact fits at the exact facts-response minimum', () => {
		// A fact sized to exactly maxEncodedFactBytes, held under a worst-case
		// escaped lifetime, must return terminal (hasMore:false) at the derived
		// minimum ceiling. Because false is one byte longer than true, an envelope
		// modeled on true would leave this one byte short and return empty.
		const maxLifetimeBytes = 8;
		const escaped = '\u0000'.repeat(maxLifetimeBytes);
		const atFact: Fact = {
			address: valueAt('k'),
			sequence: 1,
			presence: 'present',
			content: 'x'.repeat(200),
		};
		const maxEncodedFactBytes = encodedFactBytes(atFact);
		const draft = { ...BASE_LIMITS, maxLifetimeBytes, maxEncodedFactBytes };
		const limits = makeLimits({
			maxLifetimeBytes,
			maxEncodedFactBytes,
			maxFactsResponseBytes: minimumFactsResponseBytes(draft),
		});
		const state: AuthorityState = {
			lifetime: escaped,
			nextSequence: 2,
			facts: new Map([['k', atFact]]),
			replicas: new Map(),
		};
		const read = expectOk(
			readFacts(
				state,
				admitFacts({ afterSequence: 0, authorityLifetime: escaped }, limits),
				limits,
			),
		);
		expect(read.facts).toHaveLength(1);
		expect(read.hasMore).toBe(false);
	});
});
