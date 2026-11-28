import { describe, expect, test } from 'bun:test';
import { timeId } from '@epicenter/app/time';
import {
	dayLabel,
	excerpt,
	formatDuration,
	groupByDay,
	matches,
	olderThan,
	recordedAt,
	usage,
} from './feed';

describe('recordedAt', () => {
	test('reads the moment out of a take the recorder named', () => {
		// The id the recorder plugin's own test makes (`time_id` in `listen.rs`).
		expect(recordedAt('2026-10-30T22-41-05-123Z-k3x9a2f8')?.getTime()).toBe(
			1_793_400_065_123,
		);
	});

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
	const groups = groupByDay(
		items.map((at) => ({ at })),
		now,
	);
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

describe('excerpt', () => {
	const text =
		'The quarterly numbers look fine, but we should move the launch to the week after the holidays.';

	test('starts at the beginning with no query', () => {
		expect(excerpt(text, '', 20)).toEqual([
			{ text: 'The quarterly…', hit: false },
		]);
	});

	test('centres on the first searched word and marks every one', () => {
		const parts = excerpt(text, 'launch week', 40);
		expect(parts.map((part) => part.text).join('')).toBe(
			'…move the launch to the week after the…',
		);
		expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual([
			'launch',
			'week',
		]);
	});

	test('marks a match whatever its case', () => {
		expect(excerpt('Call Dana', 'dana').at(-1)).toEqual({
			text: 'Dana',
			hit: true,
		});
	});
});

describe('usage', () => {
	test('counts days, words, and the pace of takes with text and a length', () => {
		const day = new Date(2026, 4, 1, 9);
		expect(
			usage([
				{ at: day, durationMs: 30_000, transcript: 'one two three four five' },
				{
					at: new Date(2026, 4, 1, 17),
					durationMs: 30_000,
					transcript: ' six  seven ',
				},
				{
					at: new Date(2026, 4, 2),
					durationMs: undefined,
					transcript: 'eight',
				},
				{ at: undefined, durationMs: 60_000, transcript: '' },
			]),
		).toEqual({ days: 2, words: 8, wordsPerMinute: 7 });
	});

	test('has no pace before any take has text and a length', () => {
		expect(usage([])).toEqual({ days: 0, words: 0, wordsPerMinute: undefined });
	});
});

test('only a recording older than the days kept is old, and one with no time never is', () => {
	const now = new Date('2026-11-27T12:00:00.000Z');
	const ids = [
		'2026-11-27T11-00-00-000Z-aaaaaaaa',
		'2026-11-20T12-00-00-001Z-bbbbbbbb',
		'2026-11-20T11-59-59-999Z-cccccccc',
		'2025-01-01T00-00-00-000Z-dddddddd',
		'a-name-with-no-time',
	];
	expect(olderThan(ids, 7, now)).toEqual([
		'2026-11-20T11-59-59-999Z-cccccccc',
		'2025-01-01T00-00-00-000Z-dddddddd',
	]);
});
