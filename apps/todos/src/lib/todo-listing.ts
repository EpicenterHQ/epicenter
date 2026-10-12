/**
 * The todo listing as the list shows it. Pure functions of what the table
 * lists; the store reads and writes the listing, these only arrange it.
 */
import {
	rowPath,
	rowStemOf,
	type StoredRow,
	type TableListing,
} from '@epicenter/folder';
import type { TodoFields, todosDefinition } from './definition.js';

/** The todo table's directory: its key in the definition. */
const TABLE = 'todos' satisfies keyof typeof todosDefinition.tables;

/** The file of the todo `stem`: `todos/<stem>.md`. */
export const todoPath = (stem: string) => rowPath(TABLE, stem);

/** The stem of `path` when it is a todo's file, or `undefined`. */
export const todoStem = (path: string) => rowStemOf(TABLE, path);

/** Every todo row file, as the table lists it: a row, or why it is not one. */
export type TodoListing = TableListing<TodoFields>;

/** A todo row that reads as a todo. */
export type TodoEntry = StoredRow<TodoFields> & { readonly stem: string };

/**
 * A row file the list cannot edit, and why. Text that is not a valid todo
 * (`invalid`) is the person's to repair as text; a file that could not be
 * read as text (`unreadable`) is not.
 */
type Repair = {
	readonly stem: string;
	readonly path: string;
	readonly kind: 'invalid' | 'unreadable';
	readonly reason: string;
};

function byPath(a: { path: string }, b: { path: string }) {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The listing as the list shows it: open todos first, then done, each by path. */
export function todosOf(listing: TodoListing): TodoEntry[] {
	const entries: TodoEntry[] = [];
	for (const { stem, result } of listing)
		if (result.error === null) entries.push({ ...result.data, stem });
	return entries.sort(
		(a, b) =>
			Number(a.row.fields.done) - Number(b.row.fields.done) || byPath(a, b),
	);
}

/** The row files the list does not offer, each with why. */
export function repairsOf(listing: TodoListing): Repair[] {
	const repairs: Repair[] = [];
	for (const { stem, result } of listing) {
		if (result.error === null) continue;
		const path = todoPath(stem);
		repairs.push(
			result.error.name === 'InvalidRow'
				? {
						stem,
						path,
						kind: 'invalid',
						reason: result.error.issues.map((issue) => issue.message).join(' '),
					}
				: {
						stem,
						path,
						kind: 'unreadable',
						reason: `It could not be read as text: ${result.error.message}`,
					},
		);
	}
	return repairs.sort(byPath);
}
