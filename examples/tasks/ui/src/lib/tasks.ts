/**
 * How the list groups and labels a task, a row of `tasks list`, by its due
 * day, and where a task's page is. Days are local `YYYY-MM-DD` strings, which
 * sort as text in the order they fall. Only fitting tasks enter these groups; malformed files stay in the repair list.
 */
import { partitionResults } from '@epicenter/app/client';
import type { TaskRowResult, Task } from './app.js';

/**
 * The page of a task, routed by its key: `#/tasks/<time>`, encoded so any
 * file name survives.
 */
export const hrefOf = (task: Pick<Task, 'time'>) => `#/tasks/${encodeURIComponent(task.time)}`;

/** `at` as a local day, `2026-11-10`. */
export function dayOf(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The local noon of `day`, so adding days never crosses midnight on a clock change. */
function noonOf(day: string): Date {
	const [year, month, date] = day.split('-').map(Number) as [number, number, number];
	return new Date(year, month - 1, date, 12);
}

/** The day `count` days after `day`; negative counts go back. */
export function addDays(day: string, count: number): string {
	const at = noonOf(day);
	at.setDate(at.getDate() + count);
	return dayOf(at);
}

/** Whole days from `today` to `day`: 0 today, 1 tomorrow, -1 yesterday. */
function daysUntil(day: string, today: string): number {
	return Math.round((noonOf(day).getTime() - noonOf(today).getTime()) / 86_400_000);
}

/**
 * A due day as a person says it, from `today`: `Today`, `Tomorrow`,
 * `Yesterday`, a weekday within the coming week, else a short date, with the
 * year only when it is not this year's.
 */
export function dueLabel(day: string, today: string): string {
	const days = daysUntil(day, today);
	if (days === 0) return 'Today';
	if (days === 1) return 'Tomorrow';
	if (days === -1) return 'Yesterday';
	const at = noonOf(day);
	if (days > 1 && days < 7)
		return at.toLocaleDateString(undefined, { weekday: 'long' });
	const sameYear = day.slice(0, 4) === today.slice(0, 4);
	return at.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' }),
	});
}

/** Whether `day` is before `today`. */
export const isOverdue = (day: string, today: string) => day < today;

/** A group of open tasks under one heading. */
export type Group = {
	key: 'overdue' | 'today' | 'upcoming' | 'later';
	label: string;
	tasks: Task[];
};

const byTime = (a: Task, b: Task) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
const byDue = (a: Task, b: Task) =>
	(a.due ?? '') < (b.due ?? '') ? -1 : (a.due ?? '') > (b.due ?? '') ? 1 : byTime(a, b);

/**
 * The open tasks in the groups that have any: overdue and today first, then
 * upcoming by day, then those with no day, newest first so a task just added
 * is at the top of its group. Times sort by when they were made.
 */
export function groupOpen(tasks: Task[], today: string): Group[] {
	const open = tasks.filter((task) => !task.done);
	const dated = open.filter((task) => task.due).toSorted(byDue);
	const groups: Group[] = [
		{
			key: 'overdue',
			label: 'Overdue',
			tasks: dated.filter((task) => isOverdue(task.due as string, today)),
		},
		{ key: 'today', label: 'Today', tasks: dated.filter((task) => task.due === today) },
		{
			key: 'upcoming',
			label: 'Upcoming',
			tasks: dated.filter((task) => (task.due as string) > today),
		},
		{
			key: 'later',
			label: 'No date',
			tasks: open.filter((task) => !task.due).toSorted(byTime).reverse(),
		},
	];
	return groups.filter((group) => group.tasks.length > 0);
}

/** The done tasks, newest first. */
export function completed(tasks: Task[]): Task[] {
	return tasks.filter((task) => task.done).toSorted(byTime).reverse();
}

/** Keep every malformed file visible beside the grouped fitting tasks. */
export function splitTasks(rows: TaskRowResult[]) {
	const { oks, errs } = partitionResults(rows);
	return { oks: oks.map((row) => row.data), errs: errs.map((row) => row.error) };
}

/** A malformed file can still carry its key and a fitting title. */
type MisfitRow = { path: string; record?: { time?: string; title?: string } };

export const misfitKeyOf = (error: MisfitRow) =>
	error.record?.time ?? error.path.slice(error.path.lastIndexOf('/') + 1).replace(/\.md$/, '');

export const misfitLabelOf = (error: MisfitRow) =>
	error.record?.title?.trim() ? error.record.title : error.path.slice(error.path.lastIndexOf('/') + 1);
