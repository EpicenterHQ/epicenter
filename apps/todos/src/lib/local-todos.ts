/**
 * Todos as the list arranges them, and what a person is told when a write
 * cannot be saved. Pure functions of what the repository lists, apart from
 * the toast; the views read and write through `getRepository()`.
 */
import type { Note, Saved } from '@epicenter/repository';
import { toast } from '@epicenter/ui/sonner';
import type { todosTables } from './definition.js';

export type TodoNote = Note<'todos/{stem}.md', (typeof todosTables)['todos']>;

/** A note that reads as a todo. */
export type Todo = Extract<TodoNote, { valid: true }>;

/** A note that does not read as a todo: its source stays, with why. */
export type Problem = Extract<TodoNote, { valid: false }>;

/** The file of the todo `id`. */
export const todoPath = (id: string) => `todos/${id}.md`;

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The todos as the list shows them: open first, then done, each by file. */
export function todosOf(notes: readonly TodoNote[]): Todo[] {
	return notes
		.filter((note): note is Todo => note.valid)
		.sort((a, b) => Number(a.fields.done) - Number(b.fields.done) || byPath(a, b));
}

/** Notes whose text is not a valid todo; their source is shown as it is. */
export function repairsOf(notes: readonly TodoNote[]): Problem[] {
	return notes.filter((note): note is Problem => !note.valid).sort(byPath);
}

/** The todo's label: its title, or its file's name when it has none. */
export function labelOf(todo: { params: { stem: string }; fields: { title: string } }) {
	return todo.fields.title.trim() === '' ? todo.params.stem : todo.fields.title;
}

/**
 * Tell the person when a write could not be saved on this device. A write is
 * shown at once and resolves once saved; what the server later does with it
 * is a notice, which the header shows.
 */
export async function reportWrite(saved: Saved, failure: string) {
	const { error } = await saved;
	if (error !== null && error.name !== 'Closed') toast.error(failure, { description: error.message });
}
