import { describe, expect, test } from 'bun:test';
import type { Task } from './store.svelte.js';
import { addDays, completed, dayOf, dueLabel, groupOpen, idOf, labelOf, pathOf } from './tasks.js';

const task = (id: string, fields: Partial<Task> = {}): Task => ({
	path: pathOf(id),
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
		// A hand-written `null`, which the row's type does not admit, reads as no date.
		task('e', { due: null as never }),
		task('f', { due: '2026-11-11' }),
		task('g', { done: true, due: '2026-11-01' }),
	];

	test('groups overdue, today, upcoming by day, then undated newest first', () => {
		expect(
			groupOpen(rows, today).map((group) => [group.key, group.tasks.map((t) => idOf(t.path))]),
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
			(t) => idOf(t.path),
		),
	).toEqual(['c', 'a']);
});

test('pathOf and idOf turn a URL id into its file and back', () => {
	expect(pathOf('2026-11-10T22-41-05')).toBe('tasks/2026-11-10T22-41-05.md');
	expect(idOf('tasks/2026-11-10T22-41-05.md')).toBe('2026-11-10T22-41-05');
});

test('labelOf falls back to the file name', () => {
	expect(labelOf({ path: 'tasks/x.md', title: '  ' })).toBe('x.md');
	expect(labelOf({ path: 'tasks/x.md', title: 'Buy milk' })).toBe('Buy milk');
});
