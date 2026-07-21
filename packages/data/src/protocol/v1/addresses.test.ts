/**
 * Scalar V1 Address Tests
 *
 * Proves that scalar addresses are structured, not flat qualified strings, and
 * that identity is by every coordinate plus kind. Row and value addresses share
 * a namespace but occupy disjoint key spaces, so one namespace may reuse a name
 * for a table and a value.
 *
 * Key behaviors:
 * - Identity holds coordinate-by-coordinate; kind disambiguates same names
 * - The wire carries structured coordinates, never a flat `key` string
 * - The 24-char lowercase runtime id is frozen; the namespace and local-key
 *   grammars are V1-local; byte ceilings stay parametric
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	type Address,
	addressesEqual,
	addressKey,
	parseAddress,
	type RowAddress,
	type ValueAddress,
} from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();

const ROW_ID = 'abc123def456ghi789jkl012';
const row = (
	overrides: Partial<Omit<RowAddress, 'kind'>> = {},
): RowAddress => ({
	kind: 'row',
	namespace: 'so.epicenter.notes',
	table: 'recordings',
	rowId: ROW_ID,
	...overrides,
});
const value = (
	overrides: Partial<Omit<ValueAddress, 'kind'>> = {},
): ValueAddress => ({
	kind: 'value',
	namespace: 'so.epicenter.settings',
	value: 'language',
	...overrides,
});

describe('structured identity', () => {
	test('equal coordinates are equal; a differing coordinate is not', () => {
		expect(addressesEqual(row(), row())).toBe(true);
		expect(
			addressesEqual(row(), row({ rowId: 'zzz123def456ghi789jkl012' })),
		).toBe(false);
		expect(addressesEqual(row(), row({ table: 'transcripts' }))).toBe(false);
		expect(
			addressesEqual(row(), row({ namespace: 'so.epicenter.other' })),
		).toBe(false);
	});

	test('a row and a value with the same namespace and name are distinct', () => {
		const rowAddress = row({ namespace: 'so.epicenter.x', table: 'name' });
		const valueAddress = value({ namespace: 'so.epicenter.x', value: 'name' });
		expect(addressesEqual(rowAddress, valueAddress)).toBe(false);
		expect(addressKey(rowAddress)).not.toBe(addressKey(valueAddress));
	});

	test('addressKey is insertion-order independent and equal for equal addresses', () => {
		const reordered = {
			rowId: ROW_ID,
			table: 'recordings',
			namespace: 'so.epicenter.notes',
			kind: 'row',
		} as Address;
		expect(addressKey(reordered)).toBe(addressKey(row()));
	});
});

describe('parse admission', () => {
	test('accepts valid row and value addresses', () => {
		expect(expectOk(parseAddress(row(), LIMITS))).toEqual(row());
		expect(expectOk(parseAddress(value(), LIMITS))).toEqual(value());
	});

	test('rejects a flat qualified key instead of structured coordinates', () => {
		expectErr(
			parseAddress(
				{ kind: 'row', key: 'so.epicenter.notes.recordings', rowId: ROW_ID },
				LIMITS,
			),
		);
	});

	test('rejects an extra property, closing the shape', () => {
		expectErr(parseAddress({ ...row(), extra: 1 }, LIMITS));
	});

	test('rejects a namespace without at least two labels', () => {
		expectErr(parseAddress(row({ namespace: 'notes' }), LIMITS));
	});

	test('rejects a runtime id that is not 24 lowercase characters', () => {
		expectErr(parseAddress(row({ rowId: 'TOO-SHORT' }), LIMITS));
		expectErr(parseAddress(row({ rowId: `${ROW_ID}x` }), LIMITS));
	});

	test('accepts a namespace at exactly the byte ceiling and rejects one over', () => {
		// LIMITS.maxNamespaceBytes is 128. 63 + 1 (dot) + 64 = 128; +1 = 129.
		const atCeiling = `${'a'.repeat(63)}.${'a'.repeat(64)}`;
		expect(atCeiling.length).toBe(LIMITS.maxNamespaceBytes);
		expect(
			expectOk(parseAddress(row({ namespace: atCeiling }), LIMITS)).namespace,
		).toBe(atCeiling);
		const overCeiling = `${'a'.repeat(64)}.${'a'.repeat(64)}`;
		expect(overCeiling.length).toBe(LIMITS.maxNamespaceBytes + 1);
		expectErr(parseAddress(row({ namespace: overCeiling }), LIMITS));
	});

	test('rejects an exotic outer address shape without throwing', () => {
		const withSymbol = { ...row() };
		(withSymbol as Record<symbol, unknown>)[Symbol('s')] = 1;
		expectErr(parseAddress(withSymbol, LIMITS));
		const withAccessor = { ...row() };
		Object.defineProperty(withAccessor, 'sneak', {
			get: () => 1,
			enumerable: true,
		});
		expectErr(parseAddress(withAccessor, LIMITS));
	});
});
