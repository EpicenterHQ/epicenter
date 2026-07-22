/**
 * Scalar V1 Wire Operation and Settlement Tests
 *
 * Proves parsing and admission for the two wire operations and the context-aware
 * settlement admission that retires durable work. `afterSequence` is the only
 * fact-feed progress coordinate: a fresh replica may omit the lifetime only at
 * sequence zero.
 *
 * Key behaviors:
 * - Facts request cross-field rule: lifetime required past sequence zero
 * - Facts response is strictly sequence-ordered, distinct-addressed, and never
 *   empty while claiming more
 * - Facts-page admission binds response lifetime and sequence progress to the
 *   sealed request
 * - A submission is non-empty, bounded, and carries at most one intent per
 *   distinct address
 * - Settlement admission requires one fact per intent in sealed order, globally
 *   distinct sequences, and parked entries that are an ordered distinct subset
 *   of touched patch addresses with code-appropriate measurements
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	admitFactsPage,
	admitSettlement,
	type Fact,
	type Intent,
	parseFactsRequest,
	parseFactsResponse,
	parseSubmissionRequest,
	parseSubmissionResponse,
	type RecordAddress,
	type SubmissionResponse,
	submit,
} from './index.js';
import {
	admitSubmission,
	makeAuthority,
	makeLimits,
} from './kernel.test-support.js';

const LIMITS = makeLimits();
const LIFETIME = '01hzzzzzzzzzzzzzzzzzzzzzzz';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const loneSurrogate = String.fromCharCode(0xdc00);
const recordKey = (index: number): string => String(index).padStart(24, 'a');
const rowAt = (index: number): RecordAddress => ({
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: recordKey(index),
});
const rowIntent = (index: number): Intent => ({
	address: rowAt(index),
	op: 'patch',
	set: { n: index },
	unset: [],
});
const valueAt = (key: string): RecordAddress => ({
	namespace: 'so.epicenter.whispering',
	collection: 'settings',
	recordKey: key,
});
const VALUE = valueAt('language');
const vFact = (
	address: RecordAddress,
	sequence: number,
	payload: string,
): Fact => ({ address, sequence, state: 'live', payload });
const valueFact = (sequence: number, payload: string): Fact =>
	vFact(VALUE, sequence, payload);
/** Strip the phantom admission brand so a plain literal can be compared. */
const plain = (value: object): Record<string, unknown> => ({ ...value });

describe('facts request', () => {
	test('a fresh replica may start from zero without a lifetime', () => {
		expect(
			plain(expectOk(parseFactsRequest({ afterSequence: 0 }, LIMITS))),
		).toEqual({ afterSequence: 0 });
	});
	test('past sequence zero the bound lifetime is required', () => {
		expectErr(parseFactsRequest({ afterSequence: 5 }, LIMITS));
		expect(
			plain(
				expectOk(
					parseFactsRequest(
						{ afterSequence: 5, authorityLifetime: LIFETIME },
						LIMITS,
					),
				),
			),
		).toEqual({ afterSequence: 5, authorityLifetime: LIFETIME });
	});
	test('rejects a negative sequence, oversized lifetime, and lone-surrogate lifetime', () => {
		expectErr(parseFactsRequest({ afterSequence: -1 }, LIMITS));
		expectErr(
			parseFactsRequest(
				{ afterSequence: 0, authorityLifetime: 'x'.repeat(65) },
				LIMITS,
			),
		);
		expectErr(
			parseFactsRequest(
				{ afterSequence: 0, authorityLifetime: `L${loneSurrogate}` },
				LIMITS,
			),
		);
	});
});

describe('facts response', () => {
	test('accepts a strictly sequence-ordered prefix', () => {
		const response = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(3, 'a'), vFact(valueAt('other'), 7, 'b')],
			hasMore: true,
		};
		expect(expectOk(parseFactsResponse(response, LIMITS))).toEqual(response);
	});
	test('rejects out-of-order or duplicate sequences', () => {
		expectErr(
			parseFactsResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [valueFact(7, 'a'), vFact(valueAt('x'), 3, 'b')],
					hasMore: false,
				},
				LIMITS,
			),
		);
	});
	test('rejects two facts for the same address', () => {
		expectErr(
			parseFactsResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [valueFact(3, 'a'), valueFact(7, 'b')],
					hasMore: false,
				},
				LIMITS,
			),
		);
	});
	test('rejects an empty response that claims more facts remain', () => {
		expectErr(
			parseFactsResponse(
				{ authorityLifetime: LIFETIME, facts: [], hasMore: true },
				LIMITS,
			),
		);
		expect(
			expectOk(
				parseFactsResponse(
					{ authorityLifetime: LIFETIME, facts: [], hasMore: false },
					LIMITS,
				),
			).hasMore,
		).toBe(false);
	});
	test('rejects a response over the byte ceiling', () => {
		const tight = makeLimits({ maxFactsResponseBytes: 5000 });
		expectErr(
			parseFactsResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [
						valueFact(1, 'x'.repeat(3900)),
						vFact(valueAt('other'), 2, 'y'.repeat(3900)),
					],
					hasMore: false,
				},
				tight,
			),
		);
	});
});

describe('context-aware facts-page admission', () => {
	test('a fresh request binds to the response lifetime even for an empty page', () => {
		const request = expectOk(parseFactsRequest({ afterSequence: 0 }, LIMITS));
		const response = {
			authorityLifetime: LIFETIME,
			facts: [],
			hasMore: false,
		};
		const admitted = expectOk(
			admitFactsPage(response, request, request, LIMITS),
		);
		const nextAfterSequence =
			admitted.facts.at(-1)?.sequence ?? request.afterSequence;

		expect(admitted.authorityLifetime).toBe(LIFETIME);
		expect(nextAfterSequence).toBe(0);
	});

	test('a bound request accepts only its authority lifetime, including at sequence zero', () => {
		const request = expectOk(
			parseFactsRequest(
				{ authorityLifetime: LIFETIME, afterSequence: 0 },
				LIMITS,
			),
		);
		const response = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(1, 'a')],
			hasMore: false,
		};

		expectOk(admitFactsPage(response, request, request, LIMITS));
		expectErr(
			admitFactsPage(
				{ ...response, authorityLifetime: 'another-lifetime' },
				request,
				request,
				LIMITS,
			),
		);
	});

	test('every returned fact is strictly newer than the requested cursor', () => {
		const request = expectOk(
			parseFactsRequest(
				{ authorityLifetime: LIFETIME, afterSequence: 5 },
				LIMITS,
			),
		);
		const response = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(5, 'stale')],
			hasMore: false,
		};

		expectErr(admitFactsPage(response, request, request, LIMITS));
		expectOk(
			admitFactsPage(
				{ ...response, facts: [valueFact(6, 'newer')] },
				request,
				request,
				LIMITS,
			),
		);
	});

	test('an empty terminal page preserves the requested cursor and still obeys lifetime binding', () => {
		const request = expectOk(
			parseFactsRequest(
				{ authorityLifetime: LIFETIME, afterSequence: 5 },
				LIMITS,
			),
		);
		const response = {
			authorityLifetime: LIFETIME,
			facts: [],
			hasMore: false,
		};
		const admitted = expectOk(
			admitFactsPage(response, request, request, LIMITS),
		);
		const nextAfterSequence =
			admitted.facts.at(-1)?.sequence ?? request.afterSequence;

		expect(nextAfterSequence).toBe(5);
		expectErr(
			admitFactsPage(
				{ ...response, authorityLifetime: 'another-lifetime' },
				request,
				request,
				LIMITS,
			),
		);
	});

	test('a delayed overlapping page cannot regress an already advanced cursor', () => {
		const request = expectOk(
			parseFactsRequest(
				{ authorityLifetime: LIFETIME, afterSequence: 5 },
				LIMITS,
			),
		);
		const laterPage = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(10, 'later')],
			hasMore: false,
		};
		const delayedEarlierPage = {
			...laterPage,
			facts: [valueFact(8, 'earlier')],
		};

		expectOk(admitFactsPage(laterPage, request, request, LIMITS));
		expectErr(
			admitFactsPage(
				delayedEarlierPage,
				request,
				{ authorityLifetime: LIFETIME, afterSequence: 10 },
				LIMITS,
			),
		);
	});

	test('a delayed page cannot commit after the durable replica rebinds', () => {
		const request = expectOk(
			parseFactsRequest(
				{ authorityLifetime: 'old-lifetime', afterSequence: 5 },
				LIMITS,
			),
		);
		const response = {
			authorityLifetime: 'old-lifetime',
			facts: [valueFact(6, 'old')],
			hasMore: false,
		};

		expectErr(
			admitFactsPage(
				response,
				request,
				{ authorityLifetime: 'new-lifetime', afterSequence: 0 },
				LIMITS,
			),
		);
	});

	test('a delayed fresh page cannot overwrite a lifetime bound while it was in flight', () => {
		const request = expectOk(parseFactsRequest({ afterSequence: 0 }, LIMITS));
		const response = {
			authorityLifetime: 'old-lifetime',
			facts: [],
			hasMore: false,
		};

		expectErr(
			admitFactsPage(
				response,
				request,
				{ authorityLifetime: 'new-lifetime', afterSequence: 0 },
				LIMITS,
			),
		);
	});
});

describe('submission request', () => {
	test('accepts a compacted distinct-address submission', () => {
		const request = {
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [rowIntent(0), rowIntent(1)],
		};
		expect(plain(expectOk(parseSubmissionRequest(request, LIMITS)))).toEqual(
			request,
		);
	});
	test('rejects submission number zero and an empty submission', () => {
		expectErr(
			parseSubmissionRequest(
				{
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_ID,
					submissionNumber: 0,
					intents: [rowIntent(0)],
				},
				LIMITS,
			),
		);
		expectErr(
			parseSubmissionRequest(
				{
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_ID,
					submissionNumber: 1,
					intents: [],
				},
				LIMITS,
			),
		);
	});
	test('rejects a duplicate address, enforcing per-address compaction', () => {
		expectErr(
			parseSubmissionRequest(
				{
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_ID,
					submissionNumber: 1,
					intents: [rowIntent(0), rowIntent(0)],
				},
				LIMITS,
			),
		);
	});
	test('the same triple is one address regardless of operation shape', () => {
		// The wire carries no kind, so a replace and an unset at one triple are
		// duplicate addresses even though a legacy kinded wire would have split
		// them into disjoint key spaces.
		expectErr(
			parseSubmissionRequest(
				{
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_ID,
					submissionNumber: 1,
					intents: [
						{ address: valueAt('theme'), op: 'replace', value: 'dark' },
						{ address: valueAt('theme'), op: 'unset' },
					],
				},
				LIMITS,
			),
		);
	});
	test('distinct-address count is inclusive: at the max admits, one over rejects', () => {
		const tight = makeLimits({ maxSubmissionAddresses: 3 });
		const base = {
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
		};
		expect(
			expectOk(
				parseSubmissionRequest(
					{ ...base, intents: [rowIntent(0), rowIntent(1), rowIntent(2)] },
					tight,
				),
			).intents,
		).toHaveLength(3);
		expectErr(
			parseSubmissionRequest(
				{
					...base,
					intents: [rowIntent(0), rowIntent(1), rowIntent(2), rowIntent(3)],
				},
				tight,
			),
		);
	});
});

describe('submission response structure', () => {
	test('carries settlement facts and bounded parked results', () => {
		const response: SubmissionResponse = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(4, 'en')],
			parked: [
				{
					address: rowAt(0),
					code: 'fact-too-large',
					measuredBytes: 5000,
					limitBytes: 4096,
				},
				{ address: rowAt(1), code: 'patch-base-not-object' },
			],
		};
		expect(expectOk(parseSubmissionResponse(response, LIMITS))).toEqual(
			response,
		);
	});
	test('rejects an unknown parked code', () => {
		expectErr(
			parseSubmissionResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [],
					parked: [
						{
							address: rowAt(0),
							code: 'conflict',
							measuredBytes: 1,
							limitBytes: 1,
						},
					],
				},
				LIMITS,
			),
		);
	});
	test('rejects measurements on a patch-base-not-object entry', () => {
		expectErr(
			parseSubmissionResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [],
					parked: [
						{
							address: rowAt(0),
							code: 'patch-base-not-object',
							measuredBytes: 1,
							limitBytes: 1,
						},
					],
				},
				LIMITS,
			),
		);
	});
	test('rejects a fact-too-large entry missing its measurements', () => {
		expectErr(
			parseSubmissionResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [],
					parked: [{ address: rowAt(0), code: 'fact-too-large' }],
				},
				LIMITS,
			),
		);
	});
});

describe('context-aware settlement admission', () => {
	// A genuine sealed submission and the authority response that settles it.
	const sealed = admitSubmission(
		{
			authorityLifetime: 'lifetime-one',
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [
				rowIntent(0),
				rowIntent(1),
				{ address: valueAt('k'), op: 'replace', value: 'v' },
			],
		},
		LIMITS,
	);
	const settled = expectOk(
		submit(makeAuthority('lifetime-one', LIMITS), sealed, LIMITS),
	).response;
	const durableSettlement = {
		authorityLifetime: sealed.authorityLifetime,
		sealedSubmission: sealed,
	};
	// Deterministic settlement: exactly three facts, one per sealed intent.
	const [f0, f1, f2] = settled.facts;
	if (f0 === undefined || f1 === undefined || f2 === undefined) {
		throw new Error('settlement should carry one fact per intent');
	}

	test('admits a faithful settlement response', () => {
		expect(
			expectOk(admitSettlement(settled, sealed, durableSettlement, LIMITS)),
		).toEqual(settled);
	});

	test('rejects a response after the durable lifetime or seal changes', () => {
		expectErr(
			admitSettlement(
				settled,
				sealed,
				{ ...durableSettlement, authorityLifetime: 'lifetime-two' },
				LIMITS,
			),
		);
		expectErr(
			admitSettlement(
				settled,
				sealed,
				{ ...durableSettlement, sealedSubmission: undefined },
				LIMITS,
			),
		);
		expectErr(
			admitSettlement(
				settled,
				sealed,
				{
					...durableSettlement,
					sealedSubmission: {
						...sealed,
						submissionNumber: sealed.submissionNumber + 1,
					},
				},
				LIMITS,
			),
		);
	});

	test('rejects a missing fact', () => {
		expectErr(
			admitSettlement(
				{ ...settled, facts: settled.facts.slice(1) },
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
	});

	test('rejects a duplicate fact', () => {
		expectErr(
			admitSettlement(
				{ ...settled, facts: [f0, f0, f2] },
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
	});

	test('rejects reordered facts', () => {
		expectErr(
			admitSettlement(
				{ ...settled, facts: [f1, f0, f2] },
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
	});

	test('rejects an unrelated fact address', () => {
		const swapped = [{ ...f0, address: rowAt(99) }, f1, f2];
		expectErr(
			admitSettlement(
				{ ...settled, facts: swapped },
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
	});

	test('rejects invalid parked measurement and a parked address not touched', () => {
		expectErr(
			admitSettlement(
				{
					...settled,
					parked: [
						{
							address: rowAt(0),
							code: 'fact-too-large',
							measuredBytes: 10,
							limitBytes: 20,
						},
					],
				},
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
		expectErr(
			admitSettlement(
				{
					...settled,
					parked: [
						{
							address: rowAt(88),
							code: 'fact-too-large',
							measuredBytes: LIMITS.maxEncodedFactBytes + 1,
							limitBytes: LIMITS.maxEncodedFactBytes,
						},
					],
				},
				sealed,
				durableSettlement,
				LIMITS,
			),
		);
	});

	test('admits a patch-base-not-object parked entry for a touched patch address', () => {
		expect(
			expectOk(
				admitSettlement(
					{
						...settled,
						parked: [{ address: rowAt(0), code: 'patch-base-not-object' }],
					},
					sealed,
					durableSettlement,
					LIMITS,
				),
			).parked,
		).toEqual([{ address: rowAt(0), code: 'patch-base-not-object' }]);
	});

	test('rejects parked metadata for a non-patch intent', () => {
		// Seal a submission whose intents are a tombstone and a replace, then
		// present responses that park those addresses. Parking is legal only for
		// a patch.
		const nonPatchSealed = admitSubmission(
			{
				authorityLifetime: 'lifetime-one',
				replicaId: REPLICA_ID,
				submissionNumber: 1,
				intents: [
					{ address: rowAt(0), op: 'tombstone' },
					{ address: valueAt('v'), op: 'replace', value: 'x' },
				],
			},
			LIMITS,
		);
		const nonPatchSettled = expectOk(
			submit(makeAuthority('lifetime-one', LIMITS), nonPatchSealed, LIMITS),
		).response;
		for (const parked of [
			{
				address: rowAt(0),
				code: 'fact-too-large' as const,
				measuredBytes: LIMITS.maxEncodedFactBytes + 1,
				limitBytes: LIMITS.maxEncodedFactBytes,
			},
			{ address: valueAt('v'), code: 'patch-base-not-object' as const },
		]) {
			expectErr(
				admitSettlement(
					{ ...nonPatchSettled, parked: [parked] },
					nonPatchSealed,
					{
						authorityLifetime: nonPatchSealed.authorityLifetime,
						sealedSubmission: nonPatchSealed,
					},
					LIMITS,
				),
			);
		}
	});
});

describe('exotic outer shapes are rejected without throwing', () => {
	const validSubmission = {
		authorityLifetime: LIFETIME,
		replicaId: REPLICA_ID,
		submissionNumber: 1,
		intents: [rowIntent(0)],
	};
	const withSymbol = (base: object): object => {
		const copy = { ...base };
		(copy as Record<symbol, unknown>)[Symbol('s')] = 1;
		return copy;
	};
	const withAccessor = (base: object): object => {
		const copy = { ...base };
		Object.defineProperty(copy, 'sneak', { get: () => 1, enumerable: true });
		return copy;
	};
	const withHidden = (base: object): object => {
		const copy = { ...base };
		Object.defineProperty(copy, 'sneak', { value: 1, enumerable: false });
		return copy;
	};

	test('a submission request with a symbol, accessor, or hidden property returns Invalid', () => {
		expectErr(parseSubmissionRequest(withSymbol(validSubmission), LIMITS));
		expectErr(parseSubmissionRequest(withAccessor(validSubmission), LIMITS));
		expectErr(parseSubmissionRequest(withHidden(validSubmission), LIMITS));
	});

	test('a facts request with an exotic outer property returns Invalid', () => {
		expectErr(parseFactsRequest(withAccessor({ afterSequence: 0 }), LIMITS));
	});

	test('exotic response shapes return Invalid rather than throwing', () => {
		const validResponse = {
			authorityLifetime: LIFETIME,
			facts: [valueFact(1, 'a')],
			hasMore: false,
		};
		expectErr(parseFactsResponse(withAccessor(validResponse), LIMITS));
		expectErr(
			parseSubmissionResponse(
				withSymbol({ authorityLifetime: LIFETIME, facts: [], parked: [] }),
				LIMITS,
			),
		);
	});
});

describe('admitted requests are sealed', () => {
	test('mutating an admitted facts request after parsing throws', () => {
		const admitted = expectOk(parseFactsRequest({ afterSequence: 0 }, LIMITS));
		expect(() => {
			(admitted as { afterSequence: number }).afterSequence = 5;
		}).toThrow();
	});
});

describe('total parsing under deep trees and proxies', () => {
	// A 20,000-deep nested array proves both end-to-end admission within a raised
	// limit and typed Invalid refusal under the ordinary limit, without exhausting
	// the JavaScript stack in either case.
	const deepValue = (depth: number): unknown => {
		let node: unknown = 0;
		for (let level = 0; level < depth; level += 1) node = [node];
		return node;
	};
	test('a 20,000-deep submission is admitted at its depth limit and rejected one below', () => {
		const submission = {
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [
				{
					address: valueAt('k'),
					op: 'replace' as const,
					value: deepValue(20000),
				},
			],
		};
		const deepLimitOverrides = {
			maxEncodedFactBytes: 100000,
			maxFactsResponseBytes: 200000,
			maxSubmissionBytes: 200000,
			maxSubmissionResponseBytes: 20000000,
		};
		const admitted = expectOk(
			parseSubmissionRequest(
				submission,
				makeLimits({ ...deepLimitOverrides, jsonDepth: 20000 }),
			),
		);

		expect(admitted.intents).toHaveLength(1);
		expect(Object.isFrozen(admitted)).toBe(true);
		expectErr(
			parseSubmissionRequest(
				submission,
				makeLimits({ ...deepLimitOverrides, jsonDepth: 19999 }),
			),
		);
	});

	test('a 20,000-deep request payload returns Invalid without throwing', () => {
		expectErr(
			parseSubmissionRequest(
				{
					authorityLifetime: LIFETIME,
					replicaId: REPLICA_ID,
					submissionNumber: 1,
					intents: [
						{ address: valueAt('k'), op: 'replace', value: deepValue(20000) },
					],
				},
				LIMITS,
			),
		);
	});

	test('a 20,000-deep response payload returns Invalid without throwing', () => {
		expectErr(
			parseFactsResponse(
				{
					authorityLifetime: LIFETIME,
					facts: [
						{
							address: valueAt('k'),
							sequence: 1,
							state: 'live',
							payload: deepValue(20000),
						},
					],
					hasMore: false,
				},
				LIMITS,
			),
		);
	});

	test('a transparent Proxy returns Invalid (structuredClone cannot own it)', () => {
		const validSubmission = {
			authorityLifetime: LIFETIME,
			replicaId: REPLICA_ID,
			submissionNumber: 1,
			intents: [rowIntent(0)],
		};
		const transparent = new Proxy(validSubmission, {});
		expectErr(parseSubmissionRequest(transparent, LIMITS));
	});

	test('a throwing Proxy returns Invalid without escaping the boundary', () => {
		const throwing = new Proxy(
			{ afterSequence: 0 },
			{
				get() {
					throw new Error('trap');
				},
			},
		);
		expectErr(parseFactsRequest(throwing, LIMITS));
	});

	test('a generative Proxy is refused at the derived node budget', () => {
		const maxSubmissionBytes = 20_000;
		const limits = makeLimits({ maxSubmissionBytes });
		let generatedChildren = 0;
		const generative = (): object =>
			new Proxy(
				{},
				{
					getPrototypeOf: () => Object.prototype,
					ownKeys: () => ['next'],
					getOwnPropertyDescriptor: () => {
						generatedChildren += 1;
						return {
							configurable: true,
							enumerable: true,
							value: generative(),
							writable: true,
						};
					},
				},
			);

		expectErr(parseSubmissionRequest(generative(), limits));
		expect(generatedChildren).toBeGreaterThan(10_000);
		expect(generatedChildren).toBeLessThanOrEqual(maxSubmissionBytes);
	});

	test('a wide Proxy is refused before any child descriptor or value read', () => {
		const maxSubmissionBytes = 20_000;
		const limits = makeLimits({ maxSubmissionBytes });
		const keys = Array.from({ length: 50_000 }, (_, index) => `k${index}`);
		let descriptorsRead = 0;
		let valuesRead = 0;
		const wide = new Proxy(
			{},
			{
				getPrototypeOf: () => Object.prototype,
				ownKeys: () => keys,
				getOwnPropertyDescriptor: () => {
					descriptorsRead += 1;
					return {
						configurable: true,
						enumerable: true,
						value: 0,
						writable: true,
					};
				},
				get: () => {
					valuesRead += 1;
					return 0;
				},
			},
		);

		expectErr(parseSubmissionRequest(wide, limits));
		expect(descriptorsRead).toBe(0);
		expect(valuesRead).toBe(0);
	});
});
