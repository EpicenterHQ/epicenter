import { describe, expect, test } from 'bun:test';
import { Ok } from '@epicenter/app';
import type { TaskRowResult } from './app.js';
import type { Task } from './app.js';
import { addDays, completed, dayOf, dueLabel, groupOpen, hrefOf, splitTasks, misfitKeyOf, misfitLabelOf } from './tasks.js';
const task = (time: string, fields: Partial<Task> = {}): Task => ({
	path: `data/tasks/${time}.md`,
	time,
	title: time,
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
		task('e'),
		task('f', { due: '2026-11-11' }),
		task('g', { done: true, due: '2026-11-01' }),
	];
	test('groups overdue, today, upcoming by day, then undated newest first', () => {
		expect(groupOpen(rows, today).map((group) => [group.key, group.tasks.map((t) => t.time)])).toEqual([
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
	expect(completed([task('a', { done: true }), task('b'), task('c', { done: true })]).map((t) => t.time)).toEqual(['c', 'a']);
});
test('hrefOf routes by the task\'s time, encoded', () => {
	expect(hrefOf({ time: '2026-11-10T22-41-05' })).toBe('#/tasks/2026-11-10T22-41-05');
	expect(hrefOf({ time: 'a?b#c%' })).toBe('#/tasks/a%3Fb%23c%25');
});
test('Result rows retain unreadable tasks for repair without inventing done', () => {
	const broken: TaskRowResult = { data: null, error: { name: 'Misfit', namespace: 'epicenter/action-error', message: 'Bad done', path: 'data/tasks/b.md', problems: [{ line: 'done is invalid', kind: 'field' }], record: { path: 'data/tasks/b.md', time: 'b', title: 'Broken' } } };
	const { oks, errs } = splitTasks([Ok(task('a')), broken]);
	expect(oks).toEqual([task('a')]);
	expect(errs).toEqual([broken.error!]);
	expect(errs[0]?.record).not.toHaveProperty('done');
});
test('malformed task keys prefer partial time and otherwise keep the file stem', () => {
	expect(misfitKeyOf({ path: 'data/tasks/file.md', record: { time: 'partial?key' } })).toBe('partial?key');
	expect(misfitKeyOf({ path: 'data/tasks/a.b?c.md' })).toBe('a.b?c');
	expect(hrefOf({ time: misfitKeyOf({ path: 'data/tasks/a?b.md' }) })).toBe('#/tasks/a%3Fb');
});
test('malformed task labels prefer fitting titles and otherwise keep the file name', () => {
	expect(misfitLabelOf({ path: 'data/tasks/a.md', record: { title: 'Readable title' } })).toBe('Readable title');
	expect(misfitLabelOf({ path: 'data/tasks/a.md', record: { title: ' ' } })).toBe('a.md');
	expect(misfitLabelOf({ path: 'data/tasks/a.md' })).toBe('a.md');
});
