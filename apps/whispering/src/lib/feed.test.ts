import { describe, expect, test } from 'bun:test';
import { timeId } from '@epicenter/app/time';
import {
	dayLabel,
	formatDuration,
	groupByDay,
	matches,
	recordedAt,
} from './feed';

describe('recordedAt', () => {
	test('reads the moment back out of a timeId', () => {
		const at = new Date('2026-10-30T22:41:05.123Z');
		expect(recordedAt(timeId(at))).toEqual(at);
	});

	test('is undefined for an id timeId did not make', () => {
		expect(recordedAt('my-note')).toBeUndefined();
	});
});

test('matches needs every word, in any order and case', () => {
	expect(matches('Tell Sam I will be late', 'sam LATE')).toBe(true);
	expect(matches('Tell Sam I will be late', 'sam early')).toBe(false);
	expect(matches('anything', '  ')).toBe(true);
});

describe('dayLabel', () => {
	const now = new Date(2026, 10, 19, 9);
	test('names today and yesterday', () => {
		expect(dayLabel(new Date(2026, 10, 19, 1), now)).toBe('Today');
		expect(dayLabel(new Date(2026, 10, 18, 23), now)).toBe('Yesterday');
	});
	test('adds the year only for another year', () => {
		expect(dayLabel(new Date(2026, 10, 10), now)).not.toContain('2026');
		expect(dayLabel(new Date(2025, 10, 10), now)).toContain('2025');
	});
});

test('groupByDay keeps runs of one day in the order given', () => {
	const now = new Date(2026, 10, 19, 12);
	const items = [
		new Date(2026, 10, 19, 11),
		new Date(2026, 10, 19, 8),
		new Date(2026, 10, 18, 20),
		undefined,
	];
	const groups = groupByDay(items, (at) => at, now);
	expect(groups.map((g) => [g.label, g.items.length])).toEqual([
		['Today', 2],
		['Yesterday', 1],
		['Unknown date', 1],
	]);
});

test('formatDuration', () => {
	expect(formatDuration(42_000)).toBe('0:42');
	expect(formatDuration(725_000)).toBe('12:05');
	expect(formatDuration(3_725_000)).toBe('1:02:05');
});
