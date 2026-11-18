/**
 * Name Helper Tests
 *
 * `timeId()` names captures and recordings, so its order is the order a
 * listing shows, and it must be one plain name, as every path segment is.
 *
 * Key behaviors:
 * - Ids sort by the moment they were made, which `timeOf` reads back
 * - An id holds no `.`, `:`, `/` or uppercase random part, so it splits cleanly in `{id}.{ext}`
 */
import { expect, test } from 'bun:test';
import { timeId, timeOf } from './ids.js';

test('timeId sorts by the moment it was made', () => {
	const moments = [
		'2026-10-30T22:41:05.123Z',
		'2026-10-30T22:41:05.124Z',
		'2026-10-30T22:41:06.000Z',
		'2026-11-01T00:00:00.000Z',
	].map((at) => timeId(new Date(at)));
	expect([...moments].reverse().sort()).toEqual(moments);
	expect(moments[0]).toMatch(/^2026-10-30T22-41-05-123Z-[0-9a-z]{8}$/);
});

test('timeId holds nothing a path segment or {id}.{ext} would split on', () => {
	for (let k = 0; k < 100; k++) {
		const id = timeId();
		expect(id).not.toMatch(/[.:/]/);
		expect(id.slice(-9)).toMatch(/^-[0-9a-z]{8}$/);
	}
	expect(timeId()).not.toBe(timeId());
});

test('timeOf reads back the moment a timeId was made, and nothing from another name', () => {
	const at = new Date('2026-10-30T22:41:05.123Z');
	expect(timeOf(timeId(at))).toEqual(at);
	expect(timeOf('2026-10-30T22-41-05-123Z')).toEqual(at);
	for (const other of [
		'standup',
		'V1StGXR8_Z5jdHi6B-myT',
		'2026-13-40T99-99-99-999Z-k3x9a2f8',
	])
		expect(timeOf(other)).toBeUndefined();
});
