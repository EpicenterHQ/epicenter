/**
 * Capture Tables Tests
 *
 * The folder reads a row's frontmatter through the table's schema with
 * TypeBox's `Check`, so these check the schema the way the folder applies it.
 *
 * Key behaviors:
 * - `capturedAt` accepts RFC 3339 times in UTC and with an offset
 * - A `capturedAt` that is not a date and time, or is missing, does not fit
 * - Keys Capture does not declare still fit
 */
import { expect, test } from 'bun:test';
import { Check } from 'typebox/value';
import { captureTables } from './index.js';

const fits = (fields: unknown) => Check(captureTables.captures, fields);

test('capturedAt accepts UTC and offset times', () => {
	expect(fits({ capturedAt: '2026-10-01T02:30:00.000Z' })).toBe(true);
	expect(fits({ capturedAt: '2026-10-01T10:30:00+08:00' })).toBe(true);
});

test('capturedAt that is not a date and time, or is missing, does not fit', () => {
	expect(fits({ capturedAt: 'yesterday' })).toBe(false);
	expect(fits({ capturedAt: '2026-10-01' })).toBe(false);
	expect(fits({ capturedAt: 5 })).toBe(false);
	expect(fits({})).toBe(false);
});

test('keys Capture does not declare still fit', () => {
	expect(
		fits({ capturedAt: '2026-10-01T02:30:00Z', source: 'phone', tags: ['a'] }),
	).toBe(true);
});

test('draft is an optional boolean and existing captures still fit', () => {
	const capturedAt = '2026-10-01T02:30:00Z';
	expect(fits({ capturedAt })).toBe(true);
	expect(fits({ capturedAt, draft: true })).toBe(true);
	expect(fits({ capturedAt, draft: false })).toBe(true);
	expect(fits({ capturedAt, draft: 'yes' })).toBe(false);
});
