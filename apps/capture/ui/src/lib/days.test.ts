import { expect, test } from 'bun:test';
import { byDay, dayLabel } from './days.js';

// Built from local parts, so the tests hold in any time zone.
const now = new Date(2026, 10, 10, 15, 0);
const at = (day: number, hour: number, month = 10, year = 2026) =>
	new Date(year, month, day, hour).toISOString();

test('dayLabel says Today, Yesterday, a weekday within the week, then a date', () => {
	expect(dayLabel(new Date(2026, 10, 10, 0, 5), now, 'en-US')).toBe('Today');
	expect(dayLabel(new Date(2026, 10, 9, 23, 59), now, 'en-US')).toBe(
		'Yesterday',
	);
	expect(dayLabel(new Date(2026, 10, 5, 12), now, 'en-US')).toBe('Thursday');
	expect(dayLabel(new Date(2026, 9, 30, 12), now, 'en-US')).toBe('Fri, Oct 30');
	expect(dayLabel(new Date(2025, 9, 30, 12), now, 'en-US')).toBe(
		'Thu, Oct 30, 2025',
	);
});

test('byDay groups consecutive rows by local day and puts undated rows last', () => {
	const groups = byDay(
		[
			{ path: 'a', capturedAt: at(10, 14) },
			{ path: 'b', capturedAt: at(10, 1) },
			{ path: 'x', capturedAt: undefined },
			{ path: 'c', capturedAt: at(9, 22) },
			{ path: 'y', capturedAt: 'not a date' },
		],
		now,
		'en-US',
	);
	expect(
		groups.map((group) => [group.label, group.rows.map((row) => row.path)]),
	).toEqual([
		['Today', ['a', 'b']],
		['Yesterday', ['c']],
		['No date', ['x', 'y']],
	]);
});
