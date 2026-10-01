/**
 * Restricted-query wire validation tests.
 * Exact integer/blob encodings, ordered rows, and response bounds must survive
 * an untyped worker or native reply without accepting malformed values.
 */
import { expect, test } from 'bun:test';
import { isQueryResult, QUERY_LIMITS } from './query.js';

test('ordered duplicate headers preserve distinct values and empty results retain headers', () => {
	expect(
		isQueryResult({
			columns: ['value', 'value'],
			rows: [[{ integer: '9223372036854775807' }, { blob: '00ff' }]],
			truncated: false,
		}),
	).toBe(true);
	expect(
		isQueryResult({ columns: ['value'], rows: [], truncated: false }),
	).toBe(true);
});

test('invalid tags, non-finite numbers and row widths are refused', () => {
	for (const value of [
		{ integer: '9223372036854775808' },
		{ integer: '-9223372036854775809' },
		{ integer: '-0' },
		{ integer: '01' },
		{ integer: '1.0' },
		{ blob: 'ff0' },
		{ blob: 'FF' },
		{ integer: '1', blob: '' },
		Infinity,
		NaN,
		{},
		undefined,
	]) {
		expect(
			isQueryResult({ columns: ['value'], rows: [[value]], truncated: false }),
		).toBe(false);
	}
	expect(
		isQueryResult({ columns: ['value'], rows: [[1, 2]], truncated: false }),
	).toBe(false);
});

test('row, column and serialized byte limits apply to replies', () => {
	expect(
		isQueryResult({
			columns: ['value'],
			rows: Array.from({ length: QUERY_LIMITS.rows + 1 }, () => [null]),
			truncated: true,
		}),
	).toBe(false);
	expect(
		isQueryResult({
			columns: Array.from({ length: QUERY_LIMITS.columns + 1 }, () => 'value'),
			rows: [],
			truncated: false,
		}),
	).toBe(false);
	expect(
		isQueryResult({
			columns: ['value'],
			rows: [['x'.repeat(QUERY_LIMITS.resultBytes)]],
			truncated: true,
		}),
	).toBe(false);
});

test('metadata and exact response overhead count toward the byte limit', () => {
	expect(
		isQueryResult({
			columns: Array.from({ length: 128 }, () => 'x'.repeat(16384)),
			rows: [],
			truncated: false,
		}),
	).toBe(false);
	const overhead = JSON.stringify({
		columns: ['value'],
		rows: [['']],
		truncated: false,
	}).length;
	const exact = {
		columns: ['value'],
		rows: [['x'.repeat(QUERY_LIMITS.resultBytes - overhead)]],
		truncated: false,
	};
	expect(isQueryResult(exact)).toBe(true);
	exact.rows[0]![0] += 'x';
	expect(isQueryResult(exact)).toBe(false);
});
