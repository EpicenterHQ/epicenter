/**
 * What Todos knows of a todo: its file, its label and its order. The list
 * the views read (`getTodos`) is one client's todos: this device's on the
 * "On this device" page, the repository's on the "Synced" page (decision
 * 76); `TodosApp` sets it.
 */
import type { NoteOf } from '@epicenter/definition/contract';
import type { ReactiveNotes } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import { type Todos, todos } from './contract.js';

/** Todos' one collection: a note per todo. */
export type TodoNotes = Todos['collections']['todos'];

export type Todo = NoteOf<TodoNotes>;

/** The file of the todo `id`. */
export const todoPath = (id: string) =>
	todos.collections.todos.path.replace('{id}', id);

/** The todo's label: its title, or its file's name when it has none. */
export const labelOf = (todo: Pick<Todo, 'id' | 'title'>) =>
	todo.title.trim() === '' ? `${todo.id}.md` : todo.title;

/** Open todos first, then done ones, each oldest first (ids sort by when they were made). */
export const openFirst = (a: Todo, b: Todo) =>
	Number(a.done) - Number(b.done) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Which of Todos' two views a page is: this device's files, or the repository's. */
export type View = 'device' | 'synced';

/** The list every component of a view reads and edits: that view's client's todos. */
export const [getTodos, setTodos] = createContext<ReactiveNotes<TodoNotes>>();
