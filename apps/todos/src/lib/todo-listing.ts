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

/** A row file the list cannot show as a todo, and why. */
type Problem = {
	readonly stem: string;
	readonly path: string;
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

/** Row files whose text is not a valid todo: the person's to repair as text. */
export function repairsOf(listing: TodoListing): Problem[] {
	const repairs: Problem[] = [];
	for (const { stem, result } of listing)
		if (result.error?.name === 'InvalidRow')
			repairs.push({
				stem,
				path: todoPath(stem),
				reason: result.error.issues.map((issue) => issue.message).join(' '),
			});
	return repairs.sort(byPath);
}

/** Row files that could not be read as text at all, each with why. */
export function unreadableOf(listing: TodoListing): Problem[] {
	const unreadable: Problem[] = [];
	for (const { stem, result } of listing)
		if (result.error !== null && result.error.name !== 'InvalidRow')
			unreadable.push({
				stem,
				path: todoPath(stem),
				reason: `It could not be read as text: ${result.error.message}`,
			});
	return unreadable.sort(byPath);
}
