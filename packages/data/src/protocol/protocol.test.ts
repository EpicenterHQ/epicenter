/**
 * Scalar Wire V1 Protocol Tests
 *
 * Verifies structured-address grammar, admission ceilings, lifetime binding,
 * canonical digests, and the closed exchange envelopes.
 *
 * Key behaviors:
 * - Row and value addresses carry literal structured components
 * - One durable watermark drives paging; there is no cursor object
 * - Receipts are minimal (seq, digest) and every response carries a lifetime
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	batchDigest,
	type Change,
	DATA_ADMISSION_LIMITS,
	ExchangeRequestSchema,
	type ExchangeResponse,
	parseChange,
	parseExchangeRequest,
	parseExchangeResponse,
	parseLifetimeId,
	parseMemberKey,
	parseNamespaceKey,
	parseReplicaId,
	parseRowId,
	type Record as SyncRecord,
	sha256Hex,
} from './index.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const LIFETIME_ID = 'llllllllllllllllllllllll';
const NAMESPACE = 'so.epicenter.notes';

describe('structured address grammar', () => {
	test('namespace keys require three lowercase dot-separated labels', () => {
		for (const namespace of [NAMESPACE, 'a.b.c', 'so.epicenter.my-notes']) {
			expect(expectOk(parseNamespaceKey(namespace))).toBe(namespace);
		}
		for (const namespace of [
			'a.b',
			'.a.b.c',
			'a.-b.c',
			'a.b-.c',
			'A.b.c',
			'a..b.c',
			'recordings',
		]) {
			expect(expectErr(parseNamespaceKey(namespace)).name).toBe('Invalid');
		}
	});

	test('namespace key byte length stops at 128 bytes', () => {
		const exact = `a.b.${'c'.repeat(124)}`;
		expect(new TextEncoder().encode(exact)).toHaveLength(128);
		expect(expectOk(parseNamespaceKey(exact))).toBe(exact);
		expect(expectErr(parseNamespaceKey(`${exact}c`)).name).toBe('Invalid');
	});

	test('one member-key grammar serves table and value keys', () => {
		for (const member of [
			'recordings',
			'settings.sound.manual-start',
			'svelte.rows',
			'a',
		]) {
			expect(expectOk(parseMemberKey(member))).toBe(member);
		}
		for (const member of [
			'',
			'Recordings',
			'.rows',
			'rows.',
			'-rows',
			'rows-',
			'a..b',
			'a--b',
			'row_id',
			'x'.repeat(DATA_ADMISSION_LIMITS.memberKeyBytes + 1),
		]) {
			expect(expectErr(parseMemberKey(member)).name).toBe('Invalid');
		}
	});

	test('row, replica, and lifetime IDs require exactly 24 lowercase alphanumerics', () => {
		expect(expectOk(parseRowId(ROW_ID))).toBe(ROW_ID);
		expect(expectOk(parseReplicaId(REPLICA_ID))).toBe(REPLICA_ID);
		expect(expectOk(parseLifetimeId(LIFETIME_ID))).toBe(LIFETIME_ID);
		for (const value of [
			'short',
			`${ROW_ID}x`,
			ROW_ID.toUpperCase(),
			'abc-23def456ghi789jkl012',
		]) {
			expect(expectErr(parseRowId(value)).name).toBe('Invalid');
			expect(expectErr(parseLifetimeId(value)).name).toBe('Invalid');
		}
	});

	test('same member names in different namespaces are distinct admissible addresses', () => {
		const left = expectOk(
			parseChange({
				kind: 'create',
				namespace: 'so.epicenter.alpha',
				table: 'rows',
				rowId: ROW_ID,
				fields: {},
			}),
		);
		const right = expectOk(
			parseChange({
				kind: 'create',
				namespace: 'so.epicenter.beta',
				table: 'rows',
				rowId: ROW_ID,
				fields: {},
			}),
		);
		expect(left.namespace).not.toBe(right.namespace);
		// A table and a value may share one member key; `kind` discriminates.
		expect(
			expectOk(
				parseChange({
					kind: 'set',
					namespace: 'so.epicenter.alpha',
					value: 'rows',
					payload: 1,
				}),
			).kind,
		).toBe('set');
	});
});

describe('change and exchange admission', () => {
	test('all five change variants parse with structured addresses and inputs are cloned', () => {
		const changes: Change[] = [
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { title: 'A' },
			},
			{
				kind: 'update',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { set: { title: 'B' }, unset: ['old'] },
			},
			{ kind: 'delete', namespace: NAMESPACE, table: 'rows', rowId: ROW_ID },
			{
				kind: 'set',
				namespace: 'so.epicenter.settings',
				value: 'theme',
				payload: { dark: true },
			},
			{ kind: 'unset', namespace: 'so.epicenter.settings', value: 'theme' },
		];
		for (const change of changes)
			expect(expectOk(parseChange(change))).toEqual(change);
		expect(expectOk(parseChange(changes[0]))).not.toBe(changes[0]);
	});

	test('flat qualified-key change shapes are refused', () => {
		expect(
			expectErr(
				parseChange({
					kind: 'create',
					key: 'so.epicenter.notes.rows',
					rowId: ROW_ID,
					fields: {},
				}),
			).name,
		).toBe('Invalid');
	});

	test('updates reject empty, duplicate, overlapping, and excessive unset keys', () => {
		const update = (unset: string[], set: Record<string, string> = {}) => ({
			kind: 'update',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: { set, unset },
		});
		for (const change of [
			update([]),
			update(['x', 'x']),
			update(['x'], { x: 'overlap' }),
			update(
				Array.from(
					{ length: DATA_ADMISSION_LIMITS.unsetKeysPerChange + 1 },
					(_, index) => `x${index}`,
				),
			),
		]) {
			expect(expectErr(parseChange(change)).name).toBe('Invalid');
		}
	});

	test('requests carry a lifetime binding: null for fresh replicas, exact otherwise', () => {
		const base = { replicaId: REPLICA_ID, after: 0 };
		expect(
			expectOk(parseExchangeRequest({ ...base, lifetimeId: null })).lifetimeId,
		).toBeNull();
		expect(
			expectOk(parseExchangeRequest({ ...base, lifetimeId: LIFETIME_ID }))
				.lifetimeId,
		).toBe(LIFETIME_ID);
		for (const request of [
			base,
			{ ...base, lifetimeId: 'not-a-lifetime' },
			{ ...base, lifetimeId: LIFETIME_ID.toUpperCase() },
		]) {
			expect(expectErr(parseExchangeRequest(request)).name).toBe('Invalid');
		}
	});

	test('a fresh null-lifetime request may carry an initial batch', () => {
		const changes = [
			{ kind: 'unset', namespace: 'so.epicenter.settings', value: 'theme' },
		] as const satisfies readonly Change[];
		const batch = { seq: 1, digest: batchDigest(changes), changes };
		expect(
			expectOk(
				parseExchangeRequest({
					replicaId: REPLICA_ID,
					lifetimeId: null,
					after: 0,
					batch,
				}),
			),
		).toMatchObject({ lifetimeId: null, batch });
	});

	test('continuations carry through beyond after and never a batch', () => {
		const changes = [
			{ kind: 'unset', namespace: 'so.epicenter.settings', value: 'theme' },
		] as const satisfies readonly Change[];
		const batch = { seq: 1, digest: batchDigest(changes), changes };
		expect(
			expectOk(
				parseExchangeRequest({
					replicaId: REPLICA_ID,
					lifetimeId: LIFETIME_ID,
					after: 3,
					through: 9,
				}),
			),
		).toMatchObject({ after: 3, through: 9 });
		for (const request of [
			// A batch rides only the first page of a scan.
			{
				replicaId: REPLICA_ID,
				lifetimeId: LIFETIME_ID,
				after: 3,
				through: 9,
				batch,
			},
			// A continuation must still have records to fetch.
			{ replicaId: REPLICA_ID, lifetimeId: LIFETIME_ID, after: 3, through: 3 },
			{ replicaId: REPLICA_ID, lifetimeId: LIFETIME_ID, after: 3, through: 2 },
			// The historical cursor object is gone.
			{
				replicaId: REPLICA_ID,
				lifetimeId: LIFETIME_ID,
				after: 3,
				cursor: { through: 9, position: 3 },
			},
		]) {
			expect(expectErr(parseExchangeRequest(request)).name).toBe('Invalid');
		}
	});

	test('successes bind a lifetime and use a continuation fact, not a cursor', () => {
		const record = {
			kind: 'value',
			namespace: 'so.epicenter.settings',
			value: 'theme',
			changedSequence: 2,
			payload: 'dark',
		} as const satisfies SyncRecord;
		expect(
			expectOk(
				parseExchangeResponse({
					lifetimeId: LIFETIME_ID,
					through: 2,
					records: [record],
					more: false,
				}),
			),
		).toMatchObject({ lifetimeId: LIFETIME_ID, records: [record] });
		for (const response of [
			// No lifetime.
			{ through: 2, records: [record], more: false },
			// Record above the fixed through bound.
			{ lifetimeId: LIFETIME_ID, through: 1, records: [record], more: false },
			// `more` promises records above the last returned sequence.
			{ lifetimeId: LIFETIME_ID, through: 2, records: [record], more: true },
			{ lifetimeId: LIFETIME_ID, through: 5, records: [], more: true },
			// The historical cursor object is gone.
			{
				lifetimeId: LIFETIME_ID,
				through: 2,
				records: [record],
				next: null,
			},
		]) {
			expect(expectErr(parseExchangeResponse(response)).name).toBe('Invalid');
		}
	});

	test('receipts are minimal: sequence and digest only', () => {
		const receipt = { seq: 4, digest: 'a'.repeat(64) };
		expect(
			expectOk(
				parseExchangeResponse({
					lifetimeId: LIFETIME_ID,
					receipt,
					through: 0,
					records: [],
					more: false,
				}),
			),
		).toMatchObject({ receipt });
		expect(
			expectErr(
				parseExchangeResponse({
					lifetimeId: LIFETIME_ID,
					receipt: { ...receipt, appliedThrough: 9 },
					through: 0,
					records: [],
					more: false,
				}),
			).name,
		).toBe('Invalid');
	});

	test('every refusal carries the active lifetime and inadmissibility binds the batch', () => {
		const refusals: ExchangeResponse[] = [
			{ refusal: 'batch-conflict', lifetimeId: LIFETIME_ID },
			{ refusal: 'storage-limit', lifetimeId: LIFETIME_ID },
			{ refusal: 'lifetime-mismatch', lifetimeId: LIFETIME_ID },
			{ refusal: 'checkpoint-ahead', lifetimeId: LIFETIME_ID },
			{
				refusal: 'change-inadmissible',
				lifetimeId: LIFETIME_ID,
				seq: 3,
				digest: 'b'.repeat(64),
				changeIndex: 1,
				reason: 'record-bound',
			},
		];
		for (const refusal of refusals) {
			expect(expectOk(parseExchangeResponse(refusal))).toEqual(refusal);
		}
		for (const refusal of [
			{ refusal: 'batch-conflict' },
			{ refusal: 'lifetime-mismatch' },
			{
				refusal: 'change-inadmissible',
				lifetimeId: LIFETIME_ID,
				changeIndex: 0,
				reason: 'record-bound',
			},
		]) {
			expect(expectErr(parseExchangeResponse(refusal)).name).toBe('Invalid');
		}
	});
});

test('canonical batch digest and SHA-256 are deterministic', () => {
	const left = [
		{
			kind: 'set',
			namespace: NAMESPACE,
			value: 'theme',
			payload: { b: 2, a: 1 },
		},
	] as const;
	const right = [
		{
			kind: 'set',
			namespace: NAMESPACE,
			value: 'theme',
			payload: { a: 1, b: 2 },
		},
	] as const;
	expect(batchDigest(left)).toBe(batchDigest(right));
	expect(sha256Hex('abc')).toBe(
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});

test('the request envelope owns exactly the frozen V1 members', () => {
	expect(Object.keys(ExchangeRequestSchema.properties).sort()).toEqual([
		'after',
		'batch',
		'lifetimeId',
		'replicaId',
		'through',
	]);
});
