/**
 * The one list Todos shows (decision 12): the todos still on this device
 * ("not uploaded yet") and, signed in, the ones in the repository, by id.
 * `oneList` from `@epicenter/svelte/client` does the merging and routing
 * (writes go to the copy shown and follow a todo that moves; new todos go
 * to the repository, or wait on the device); Todos adds its order and the
 * words it shows.
 */
import type { NoteOf } from '@epicenter/definition/contract';
import {
	type CaptureQueue,
	type ListedNote,
	type OneList,
	oneList,
	type ReactiveNotes,
} from '@epicenter/svelte/client';
import type { Todos } from './contract.js';
import { todos } from './contract.js';

/** Todos' one collection: a note per todo. */
export type TodoNotes = Todos['collections']['todos'];

export type Todo = NoteOf<TodoNotes>;

/** A todo as the list shows it, with where its copy is. */
export type TodoRow = ListedNote<TodoNotes>;

/** The file of the todo `id`. */
export const todoPath = (id: string) =>
	todos.collections.todos.path.replace('{id}', id);

/** Why a note does not read as a todo, in a line. */
export const describeIssues = (
	issues: readonly { field: string; message: string }[],
) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');

/** The todo's label: its title, or its file's name when it has none. */
export const labelOf = (todo: Pick<Todo, 'id' | 'title'>) =>
	todo.title.trim() === '' ? `${todo.id}.md` : todo.title;

/** Open todos first, then done ones, each oldest first (ids sort by when they were made). */
export const openFirst = (a: Todo, b: Todo) =>
	Number(a.done) - Number(b.done) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The one list over `device` (this browser's files, or the desktop's
 * folder) and `repository` (null signed out, and on the desktop, whose
 * folder Epicenter syncs). `outbox` is the device's when its new todos
 * upload (the browser), else null.
 */
export const createTodoList = ({
	device,
	repository,
	outbox,
}: {
	device: ReactiveNotes<TodoNotes>;
	repository: ReactiveNotes<TodoNotes> | null;
	outbox: CaptureQueue | null;
}) => oneList(todos, 'todos', { device, repository, outbox, order: openFirst });

export type TodoList = OneList<TodoNotes>;
