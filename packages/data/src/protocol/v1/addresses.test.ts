/**
 * Scalar V1 Record Address Tests
 *
 * Proves that record addresses are structured kindless triples, not flat
 * qualified strings or kinded species, and that identity is coordinate by
 * coordinate. One namespace has one collection keyspace; how a collection's
 * records are interpreted is Lens vocabulary that never reaches the address.
 *
 * Key behaviors:
 * - Identity holds coordinate-by-coordinate with no kind discriminant
 * - The wire carries structured coordinates, never a flat `key` string or a
 *   legacy row/value kind
 * - The 24-char lowercase runtime mint is frozen; record keys also admit the
 *   Lens local-key grammar; byte ceilings stay parametric
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	addressesEqual,
	addressKey,
	parseAddress,
	type RecordAddress,
} from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();

const RECORD_KEY = 'abc123def456ghi789jkl012';
const address = (overrides: Partial<RecordAddress> = {}): RecordAddress => ({
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: RECORD_KEY,
	...overrides,
});

describe('structured identity', () => {
	test('equal coordinates are equal; a differing coordinate is not', () => {
		expect(addressesEqual(address(), address())).toBe(true);
		expect(
			addressesEqual(
				address(),
				address({ recordKey: 'zzz123def456ghi789jkl012' }),
			),
		).toBe(false);
		expect(
			addressesEqual(address(), address({ collection: 'transcripts' })),
		).toBe(false);
		expect(
			addressesEqual(address(), address({ namespace: 'so.epicenter.other' })),
		).toBe(false);
	});

	test('one namespace has one collection keyspace: same triple, same identity', () => {
		const table = address({ namespace: 'so.epicenter.x', collection: 'name' });
		const values = address({ namespace: 'so.epicenter.x', collection: 'name' });
		expect(addressesEqual(table, values)).toBe(true);
		expect(addressKey(table)).toBe(addressKey(values));
	});

	test('addressKey is insertion-order independent and equal for equal addresses', () => {
		const reordered = {
			recordKey: RECORD_KEY,
			collection: 'recordings',
			namespace: 'so.epicenter.notes',
		} as RecordAddress;
		expect(addressKey(reordered)).toBe(addressKey(address()));
	});
});

describe('parse admission', () => {
	test('accepts a runtime-minted record key and a Lens-declared local key', () => {
		expect(expectOk(parseAddress(address(), LIMITS))).toEqual(address());
		const declared = address({
			namespace: 'so.epicenter.settings',
			collection: 'settings',
			recordKey: 'language',
		});
		expect(expectOk(parseAddress(declared, LIMITS))).toEqual(declared);
	});

	test('rejects a flat qualified key instead of structured coordinates', () => {
		expectErr(
			parseAddress(
				{ key: 'so.epicenter.notes.recordings', recordKey: RECORD_KEY },
				LIMITS,
			),
		);
	});

	test('rejects the legacy kinded row and value address shapes', () => {
		expectErr(
			parseAddress(
				{
					kind: 'row',
					namespace: 'so.epicenter.notes',
					table: 'recordings',
					rowId: RECORD_KEY,
				},
				LIMITS,
			),
		);
		expectErr(
			parseAddress(
				{
					kind: 'value',
					namespace: 'so.epicenter.settings',
					value: 'language',
				},
				LIMITS,
			),
		);
		// A kind riding on an otherwise valid record triple is an extra property.
		expectErr(parseAddress({ ...address(), kind: 'row' }, LIMITS));
	});

	test('rejects an extra property, closing the shape', () => {
		expectErr(parseAddress({ ...address(), extra: 1 }, LIMITS));
	});

	test('rejects a namespace without at least two labels', () => {
		expectErr(parseAddress(address({ namespace: 'notes' }), LIMITS));
	});

	test('rejects a record key outside both grammars', () => {
		expectErr(parseAddress(address({ recordKey: 'TOO-SHORT!' }), LIMITS));
		expectErr(parseAddress(address({ recordKey: `${RECORD_KEY}#` }), LIMITS));
		expectErr(parseAddress(address({ recordKey: '_underscore' }), LIMITS));
		expectErr(parseAddress(address({ recordKey: '' }), LIMITS));
	});

	test('accepts a 25-char local key that is not a runtime mint', () => {
		// One char longer than the mint, valid under the local-key grammar.
		const key = `a${'b'.repeat(24)}`;
		expect(
			expectOk(parseAddress(address({ recordKey: key }), LIMITS)).recordKey,
		).toBe(key);
	});

	test('accepts a namespace at exactly the byte ceiling and rejects one over', () => {
		// LIMITS.maxNamespaceBytes is 128. 63 + 1 (dot) + 64 = 128; +1 = 129.
		const atCeiling = `${'a'.repeat(63)}.${'a'.repeat(64)}`;
		expect(atCeiling.length).toBe(LIMITS.maxNamespaceBytes);
		expect(
			expectOk(parseAddress(address({ namespace: atCeiling }), LIMITS))
				.namespace,
		).toBe(atCeiling);
		const overCeiling = `${'a'.repeat(64)}.${'a'.repeat(64)}`;
		expect(overCeiling.length).toBe(LIMITS.maxNamespaceBytes + 1);
		expectErr(parseAddress(address({ namespace: overCeiling }), LIMITS));
	});

	test('rejects a collection or record key over its byte ceiling', () => {
		expectErr(
			parseAddress(
				address({ collection: 'c'.repeat(LIMITS.maxCollectionKeyBytes + 1) }),
				LIMITS,
			),
		);
		expectErr(
			parseAddress(
				address({ recordKey: 'k'.repeat(LIMITS.maxRecordKeyBytes + 1) }),
				LIMITS,
			),
		);
	});

	test('rejects an exotic outer address shape without throwing', () => {
		const withSymbol = { ...address() };
		(withSymbol as Record<symbol, unknown>)[Symbol('s')] = 1;
		expectErr(parseAddress(withSymbol, LIMITS));
		const withAccessor = { ...address() };
		Object.defineProperty(withAccessor, 'sneak', {
			get: () => 1,
			enumerable: true,
		});
		expectErr(parseAddress(withAccessor, LIMITS));
	});
});
