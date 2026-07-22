import { describe, expect, test } from 'bun:test';

import {
	type AdmittedFactsRequest,
	type AdmittedSubmissionRequest,
	canonicalize,
	type FactsRequest,
	type FactsResponse,
	minimumFactsResponseBytes,
	parseFactsRequest,
	parseSubmissionRequest,
	type ScalarSyncLimits,
	type SubmissionRequest,
	type SubmissionResponse,
	type ValidatedLimits,
	validateLimits,
} from '@epicenter/data/protocol/v1';
import type { Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

import type { ScalarAuthorityV1 } from './authority-v1.js';

const LIFETIME = 'lifetime-one';
const REPLICA_A = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const REPLICA_B = 'ssssssssssssssssssssssss';

const ADDRESS_A = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const ADDRESS_B = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
} as const;

const BASE_LIMITS: ScalarSyncLimits = {
	jsonDepth: 16,
	propertiesPerObject: 1024,
	maxNamespaceBytes: 128,
	maxCollectionKeyBytes: 64,
	maxRecordKeyBytes: 64,
	maxLifetimeBytes: 64,
	maxFieldKeyBytes: 128,
	maxUnsetKeysPerIntent: 64,
	maxEncodedFactBytes: 4096,
	maxFactsResponseBytes: 262144,
	maxSubmissionBytes: 262144,
	maxSubmissionResponseBytes: 1048576,
	maxSubmissionAddresses: 64,
};

export function authorityV1TestLimits(
	overrides: Partial<ScalarSyncLimits> = {},
): ValidatedLimits {
	return expectOk(validateLimits({ ...BASE_LIMITS, ...overrides }));
}

type OpenedAuthority = {
	authority: ScalarAuthorityV1;
	reopen(): ScalarAuthorityV1;
	close(): void;
};

export type AuthorityV1ConformanceBinding = {
	name: string;
	open(limits: ValidatedLimits, lifetime: string): OpenedAuthority;
};

function admitFacts(
	request: FactsRequest,
	limits: ValidatedLimits,
): AdmittedFactsRequest {
	return expectOk(parseFactsRequest(request, limits));
}

function admitSubmission(
	request: SubmissionRequest,
	limits: ValidatedLimits,
): AdmittedSubmissionRequest {
	return expectOk(parseSubmissionRequest(request, limits));
}

function submission(
	submissionNumber: number,
	intents: SubmissionRequest['intents'],
	overrides: Partial<
		Pick<SubmissionRequest, 'authorityLifetime' | 'replicaId'>
	> = {},
): SubmissionRequest {
	return {
		authorityLifetime: overrides.authorityLifetime ?? LIFETIME,
		replicaId: overrides.replicaId ?? REPLICA_A,
		submissionNumber,
		intents,
	};
}

function read(
	authority: ScalarAuthorityV1,
	limits: ValidatedLimits,
	request: FactsRequest,
): FactsResponse {
	return expectOk(authority.readFacts(admitFacts(request, limits)));
}

function submit(
	authority: ScalarAuthorityV1,
	limits: ValidatedLimits,
	request: SubmissionRequest,
): SubmissionResponse {
	return expectOk(authority.submit(admitSubmission(request, limits)));
}

function errorName<T>(result: Result<T, { name: string }>): string {
	return expectErr(result).name;
}

export function runAuthorityV1ConformanceCases(
	binding: AuthorityV1ConformanceBinding,
): void {
	describe(`scalar V1 authority conformance: ${binding.name}`, () => {
		test('starts empty, binds its lifetime, and refuses a sequence ahead', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				expect(read(opened.authority, limits, { afterSequence: 0 })).toEqual({
					authorityLifetime: LIFETIME,
					facts: [],
					hasMore: false,
				});
				expect(
					errorName(
						opened.authority.readFacts(
							admitFacts(
								{ authorityLifetime: LIFETIME, afterSequence: 1 },
								limits,
							),
						),
					),
				).toBe('SequenceAhead');
			} finally {
				opened.close();
			}
		});

		test('folds one submission and persists the fact, sequence, and witness atomically', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				const request = submission(1, [
					{ address: ADDRESS_A, op: 'patch', set: { title: 'One' }, unset: [] },
					{ address: ADDRESS_B, op: 'replace', value: 2 },
				]);
				const accepted = submit(opened.authority, limits, request);
				expect(accepted.facts.map((fact) => fact.sequence)).toEqual([1, 2]);
				expect(accepted.parked).toEqual([]);

				const reopened = opened.reopen();
				expect(
					read(reopened, limits, {
						authorityLifetime: LIFETIME,
						afterSequence: 0,
					}).facts,
				).toEqual(accepted.facts);
				expect(submit(reopened, limits, request)).toEqual(accepted);
			} finally {
				opened.close();
			}
		});

		test('exact retry keeps its adjudication but returns newer current facts', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				const original = submission(1, [
					{ address: ADDRESS_A, op: 'replace', value: 'first' },
				]);
				submit(opened.authority, limits, original);
				submit(
					opened.authority,
					limits,
					submission(
						1,
						[{ address: ADDRESS_A, op: 'replace', value: 'newer' }],
						{ replicaId: REPLICA_B },
					),
				);
				const retry = submit(opened.authority, limits, original);
				expect(retry.facts[0]).toMatchObject({
					sequence: 2,
					state: 'live',
					payload: 'newer',
				});
			} finally {
				opened.close();
			}
		});

		test('refuses lifetime mismatch, forks, and gaps without changing facts', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				const first = submission(1, [
					{ address: ADDRESS_A, op: 'replace', value: 1 },
				]);
				submit(opened.authority, limits, first);
				expect(
					errorName(
						opened.authority.submit(
							admitSubmission(
								{ ...first, authorityLifetime: 'lifetime-two' },
								limits,
							),
						),
					),
				).toBe('LifetimeMismatch');
				expect(
					errorName(
						opened.authority.submit(
							admitSubmission(
								submission(1, [
									{ address: ADDRESS_A, op: 'replace', value: 9 },
								]),
								limits,
							),
						),
					),
				).toBe('SubmissionFork');
				expect(
					errorName(
						opened.authority.submit(
							admitSubmission(
								submission(3, [
									{ address: ADDRESS_B, op: 'replace', value: 3 },
								]),
								limits,
							),
						),
					),
				).toBe('SubmissionGap');
				expect(
					read(opened.authority, limits, {
						authorityLifetime: LIFETIME,
						afterSequence: 0,
					}).facts,
				).toHaveLength(1);
			} finally {
				opened.close();
			}
		});

		test('tombstones absorb every later operation without spending a sequence', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				submit(
					opened.authority,
					limits,
					submission(1, [{ address: ADDRESS_A, op: 'tombstone' }]),
				);
				const absorbed = submit(
					opened.authority,
					limits,
					submission(2, [
						{ address: ADDRESS_A, op: 'replace', value: 'cannot-return' },
					]),
				);
				expect(absorbed.facts).toEqual([
					{ address: ADDRESS_A, sequence: 1, state: 'tombstone' },
				]);
			} finally {
				opened.close();
			}
		});

		test('parks a patch over a scalar and remembers that result on retry', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				submit(
					opened.authority,
					limits,
					submission(1, [{ address: ADDRESS_A, op: 'replace', value: 1 }]),
				);
				const request = submission(2, [
					{ address: ADDRESS_A, op: 'patch', set: { title: 'x' }, unset: [] },
				]);
				const parked = submit(opened.authority, limits, request);
				expect(parked.parked).toEqual([
					{ address: ADDRESS_A, code: 'patch-base-not-object' },
				]);
				expect(submit(opened.reopen(), limits, request)).toEqual(parked);
			} finally {
				opened.close();
			}
		});

		test('parks an oversized folded patch and keeps the prior live fact', () => {
			const limits = authorityV1TestLimits({ maxEncodedFactBytes: 420 });
			const opened = binding.open(limits, LIFETIME);
			const big = 'x'.repeat(150);
			try {
				submit(
					opened.authority,
					limits,
					submission(1, [
						{ address: ADDRESS_A, op: 'patch', set: { a: big }, unset: [] },
					]),
				);
				const request = submission(2, [
					{ address: ADDRESS_A, op: 'patch', set: { b: big }, unset: [] },
				]);
				const result = submit(opened.authority, limits, request);
				expect(result.facts[0]).toMatchObject({
					sequence: 1,
					state: 'live',
					payload: { a: big },
				});
				const parked = result.parked[0];
				expect(parked?.code).toBe('fact-too-large');
				if (parked?.code !== 'fact-too-large') {
					throw new Error('expected fact-too-large');
				}
				expect(parked.measuredBytes).toBeGreaterThan(
					limits.maxEncodedFactBytes,
				);
				expect(submit(opened.reopen(), limits, request)).toEqual(result);
			} finally {
				opened.close();
			}
		});

		test('returned facts and parked metadata do not alias authority state', () => {
			const limits = authorityV1TestLimits();
			const opened = binding.open(limits, LIFETIME);
			try {
				submit(
					opened.authority,
					limits,
					submission(1, [{ address: ADDRESS_A, op: 'replace', value: 1 }]),
				);
				const request = submission(2, [
					{ address: ADDRESS_A, op: 'patch', set: { title: 'x' }, unset: [] },
				]);
				const returned = submit(opened.authority, limits, request);
				const returnedFact = returned.facts[0];
				const returnedParked = returned.parked[0];
				if (returnedFact === undefined || returnedParked === undefined) {
					throw new Error('expected one fact and one parked result');
				}
				returnedFact.sequence = 999;
				returnedParked.address.recordKey = 'mutated';
				const retry = submit(opened.authority, limits, request);
				expect(retry.facts[0]?.sequence).toBe(1);
				expect(retry.parked[0]?.address).toEqual(ADDRESS_A);
			} finally {
				opened.close();
			}
		});

		test('returns the largest byte-bounded fact prefix and drains from its last sequence', () => {
			const draft = { ...BASE_LIMITS, maxEncodedFactBytes: 420 };
			const minimum = minimumFactsResponseBytes(draft);
			const limits = authorityV1TestLimits({
				maxEncodedFactBytes: 420,
				maxFactsResponseBytes: minimum + 8,
			});
			const opened = binding.open(limits, LIFETIME);
			try {
				for (let index = 0; index < 4; index += 1) {
					const key = String(index).padStart(24, 'a');
					submit(
						opened.authority,
						limits,
						submission(index + 1, [
							{
								address: { ...ADDRESS_A, recordKey: key },
								op: 'replace',
								value: 'x'.repeat(120),
							},
						]),
					);
				}
				const first = read(opened.authority, limits, {
					authorityLifetime: LIFETIME,
					afterSequence: 0,
				});
				expect(first.hasMore).toBe(true);
				expect(first.facts.length).toBeGreaterThan(0);
				expect(
					new TextEncoder().encode(canonicalize(first)).byteLength,
				).toBeLessThanOrEqual(limits.maxFactsResponseBytes);
				const last = first.facts.at(-1);
				if (last === undefined) throw new Error('first facts page is empty');
				const second = read(opened.authority, limits, {
					authorityLifetime: LIFETIME,
					afterSequence: last.sequence,
				});
				expect(second.facts[0]?.sequence).toBe(last.sequence + 1);
			} finally {
				opened.close();
			}
		});
	});
}
