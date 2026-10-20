/**
 * Todos over this browser's local folder: the rows as the list arranges
 * them, and what a person is told about a save. Pure functions of what the
 * table lists; the views read and write through `getFolder()`.
 */
import type { FolderStatus, Row, ReadError, SaveError } from '@epicenter/folder';
import type { StatusLine } from '@epicenter/svelte/status-line';
import type { ActionError } from '@epicenter/folder/edits';
import { extractErrorMessage } from 'wellcrafted/error';
import type { todosTables } from './definition.js';

export type TodoRow = Row<(typeof todosTables)['todos']>;

/** A row that reads as a todo. */
export type Todo = Extract<TodoRow, { issues: null }>;

/** A row that does not read as a todo: its source stays, with why. */
export type Problem = Extract<TodoRow, { issues: unknown[] }>;

/** The file of the todo `id`. */
export const todoPath = (id: string) => `todos/${id}.md`;

const byId = (a: { id: string }, b: { id: string }) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The todos as the list shows them: open first, then done, each by file. */
export function todosOf(rows: TodoRow[]): Todo[] {
	return rows
		.filter((row): row is Todo => row.issues === null)
		.sort(
			(a, b) => Number(a.fields.done) - Number(b.fields.done) || byId(a, b),
		);
}

/** Rows whose text is not a valid todo; their source is shown as it is. */
export function repairsOf(rows: TodoRow[]): Problem[] {
	return rows
		.filter(
			(row): row is Problem =>
				row.issues !== null &&
				!row.issues.some((issue) => issue.kind === 'not-text'),
		)
		.sort(byId);
}

/** Rows that are not text at all. */
export function unreadableOf(rows: TodoRow[]): Problem[] {
	return rows
		.filter(
			(row): row is Problem =>
				row.issues?.some((issue) => issue.kind === 'not-text') ?? false,
		)
		.sort(byId);
}

/** What a row's issues say, as one sentence per issue. */
export function reasonOf(row: Problem): string {
	return row.issues.map((issue) => issue.message).join(' ');
}

/** The todo's label: its title, or its file's name when it has none. */
export function labelOf(todo: { id: string; fields: { title: string } }) {
	if (todo.fields.title.trim() !== '') return todo.fields.title;
	return todo.id === '' ? todoPath(todo.id) : todo.id;
}

/** What a person is told about a save, read, or delete that failed. */
export function describeFailure(
	error: SaveError | ReadError | ActionError,
): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This device could not save it: ${extractErrorMessage(error.cause)}.`;
		case 'NotStarted':
			return error.reason;
		case 'Unparseable':
			return `Its file cannot be edited as a todo: ${error.reason}.`;
		case 'NotText':
			return 'Its file is not text, so Todos cannot change it.';
		default:
			return error.message;
	}
}

/** The header's summary of whether everything is saved on this device. */
export function saveLine({
	failures,
	saving,
	unsaved,
	storageFailure,
}: FolderStatus): StatusLine {
	if (failures.length > 0) {
		const reasons = failures.flatMap(({ error }) =>
			error ? [describeFailure(error)] : [],
		);
		return {
			label: 'Not saved',
			detail: [...new Set(reasons)].join('\n') || undefined,
			tone: 'error',
		};
	}
	if (saving || unsaved.length > 0) return { label: 'Saving…', tone: 'busy' };
	if (storageFailure !== null)
		return {
			label: 'A save failed',
			detail: describeFailure(storageFailure),
			tone: 'error',
		};
	return { label: 'Saved on this device', short: 'Saved', tone: 'good' };
}
