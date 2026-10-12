/**
 * The todo listing as the list shows it. Pure functions of what the table
 * lists; the store reads and writes the listing, these only arrange it.
 */
import { rowPath, type StoredRow, type TableListing } from '@epicenter/folder';
import type { TodoFields } from './definition.js';

/** Every todo row file, as the table lists it: a row, or why it is not one. */
export type TodoListing = TableListing<TodoFields>;

/** A todo row that reads as a todo. */
export type TodoEntry = StoredRow<TodoFields> & { readonly stem: string };

/** A row file the list cannot edit, and why, for the person to repair as text. */
type Repair = { readonly path: string; readonly reason: string };

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
		const path = rowPath('todos', stem);
		repairs.push(
			result.error.name === 'InvalidRow'
				? {
						path,
						reason: result.error.issues.map((issue) => issue.message).join(' '),
					}
				: {
						path,
						reason: `It could not be read as text: ${result.error.message}`,
					},
		);
	}
	return repairs.sort(byPath);
}
