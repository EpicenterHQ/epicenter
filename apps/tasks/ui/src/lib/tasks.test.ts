import { describe, expect, test } from 'bun:test';
import { addDays, completed, dayOf, dueLabel, groupOpen, labelOf, type Task } from './tasks.js';

const task = (id: string, fields: Partial<Task> = {}): Task => ({
	id,
	title: id,
	done: false,
	...fields,
});

describe('days', () => {
	test('dayOf is the local day', () => {
		expect(dayOf(new Date(2026, 10, 10, 23, 59))).toBe('2026-11-10');
	});

	test('addDays crosses months and years', () => {
		expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	test('dueLabel says the near days by name', () => {
		expect(dueLabel('2026-11-10', '2026-11-10')).toBe('Today');
		expect(dueLabel('2026-11-11', '2026-11-10')).toBe('Tomorrow');
		expect(dueLabel('2026-11-09', '2026-11-10')).toBe('Yesterday');
	});

	test('dueLabel gives the year only when it is not this one', () => {
		expect(dueLabel('2027-01-20', '2026-11-10')).toContain('2027');
		expect(dueLabel('2026-12-20', '2026-11-10')).not.toContain('2026');
	});
});

describe('groupOpen', () => {
	const today = '2026-11-10';
	const rows = [
		task('a', { due: '2026-11-12' }),
		task('b', { due: '2026-11-08' }),
		task('c', { due: today }),
		task('d'),
		task('e', { due: null }),
		task('f', { due: '2026-11-11' }),
		task('g', { done: true, due: '2026-11-01' }),
	];

	test('groups overdue, today, upcoming by day, then undated newest first', () => {
		expect(
			groupOpen(rows, today).map((group) => [group.key, group.tasks.map((t) => t.id)]),
		).toEqual([
			['overdue', ['b']],
			['today', ['c']],
			['upcoming', ['f', 'a']],
			['later', ['e', 'd']],
		]);
	});

	test('leaves out empty groups and done tasks', () => {
		expect(groupOpen([task('d'), task('g', { done: true })], today)).toEqual([
			{ key: 'later', label: 'No date', tasks: [task('d')] },
		]);
	});
});

test('completed lists done tasks newest first', () => {
	expect(
		completed([task('a', { done: true }), task('b'), task('c', { done: true })]).map(
			(t) => t.id,
		),
	).toEqual(['c', 'a']);
});

test('labelOf falls back to the file name', () => {
	expect(labelOf({ id: 'x', title: '  ' })).toBe('x.md');
	expect(labelOf({ id: 'x', title: 'Buy milk' })).toBe('Buy milk');
});
