/**
 * Capture's contract, checked the way every client applies it.
 *
 * Key behaviors:
 * - The contract compiles, and a capture lives at `captures/<id>.md`
 * - `capturedAt` accepts RFC 3339 times in UTC and with an offset; one that
 *   is not a date and time, or is missing, does not fit
 * - Keys Capture does not declare still fit
 */
import { expect, test } from 'bun:test';
import { compileContract } from '@epicenter/definition/contract';
import { capture, capturePath } from './index.js';

const compiled = compileContract(capture);
const captures = compiled.data?.collections[0];
const fits = (fields: Record<string, unknown>) =>
	captures?.checkFields(fields).length === 0;

test('the contract compiles, and a capture lives at captures/<id>.md', () => {
	expect(compiled.error).toBeNull();
	expect(capturePath('2026-10-01T02-30-00-000Z-k3x9a2f8')).toBe(
		'captures/2026-10-01T02-30-00-000Z-k3x9a2f8.md',
	);
	expect(compiled.data?.claim('captures/one.md')?.params).toEqual({
		id: 'one',
	});
});

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
