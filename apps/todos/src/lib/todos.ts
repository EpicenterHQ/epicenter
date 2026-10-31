/**
 * The one list Todos shows (decision 12): the todos still on this device
 * ("not uploaded yet") and, signed in, the ones in the repository, by id.
 *
 * A todo on both sides is mid-upload: it shows as the device's until the
 * device lets go of its copy, which it does only once the server's reply
 * shows the copy landed. Edits, deletes and repairs go to the copy shown,
 * so an edit made before the upload finishes goes up with it (the outbox
 * re-sends what changed), and an edit of a repository todo is online only.
 *
 * `createTodoList` is a note collection as Svelte state, the shape
 * `fromClient` gives one side, so `fieldEdit` binds to it unchanged and an
 * editor keeps working while its todo moves from the device to the
 * repository.
 */
import type {
	InvalidNoteOf,
	NoteOf,
	PlaceholdersOf,
} from '@epicenter/definition/contract';
import type { Outbox } from '@epicenter/folder/browser';
import type { ReactiveNotes } from '@epicenter/svelte/client';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Todos } from './contract.js';
import { todos } from './contract.js';

/** Todos' one collection: a note per todo. */
export type TodoNotes = Todos['collections']['todos'];

export type Todo = NoteOf<TodoNotes>;

type Notes = ReactiveNotes<TodoNotes>;

/** Where the copy a row shows lives: still on this device, or in the repository. */
export type Where = 'device' | 'repository';

/** A todo as the list shows it. */
export type TodoRow = Todo & { where: Where };

/** A note at a todo's path that does not read as one, with its text. */
export type InvalidRow = InvalidNoteOf<TodoNotes> & { where: Where };

/** What one side lists. */
type Listing = {
	items: readonly Todo[];
	invalid: readonly InvalidNoteOf<TodoNotes>[];
};

/** The file of the todo `id`. */
export const todoPath = (id: string) =>
	todos.collections.todos.path.replace('{id}', id);

/** Why a note does not read as a todo, in a line. */
export const describeIssues = (issues: InvalidNoteOf<TodoNotes>['issues']) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');

/** The todo's label: its title, or its file's name when it has none. */
export const labelOf = (todo: Pick<Todo, 'id' | 'title'>) =>
	todo.title.trim() === '' ? `${todo.id}.md` : todo.title;

const byId = (a: { id: string }, b: { id: string }) =>
	a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Device and repository todos as one list: an id the device holds, read or
 * not, shows the device's copy alone. Open todos come first, then done ones,
 * each oldest first (ids sort by when they were made); invalid notes by id.
 */
export function mergeTodos(device: Listing, repository: Listing | null) {
	const onDevice = new Set(
		[...device.items, ...device.invalid].map(({ id }) => id),
	);
	const repositoryOnly = <T extends { id: string }>(rows: readonly T[]) =>
		rows.filter(({ id }) => !onDevice.has(id));
	const items: TodoRow[] = [
		...device.items.map((todo) => ({ ...todo, where: 'device' as const })),
		...repositoryOnly(repository?.items ?? []).map((todo) => ({
			...todo,
			where: 'repository' as const,
		})),
	].sort((a, b) => Number(a.done) - Number(b.done) || byId(a, b));
	const invalid: InvalidRow[] = [
		...device.invalid.map((note) => ({ ...note, where: 'device' as const })),
		...repositoryOnly(repository?.invalid ?? []).map((note) => ({
			...note,
			where: 'repository' as const,
		})),
	].sort(byId);
	return { items, invalid };
}

const log = createLogger('todos/list');

const TodoListDiagnostic = defineErrors({
	NotQueued: ({ cause }: { cause: unknown }) => ({
		message:
			'A new todo is kept on this device but not queued to upload; the next upload start picks it up',
		cause,
	}),
});

/**
 * The one list over `device` (this browser's files, or the desktop's
 * folder) and `repository` (null signed out, and on the desktop, whose
 * folder Epicenter syncs). `outbox` is the device's when its new todos
 * upload (the browser), else null.
 *
 * A new todo goes to the repository when there is one; when the server
 * cannot be reached, or signed out, it stays on the device, queued in the
 * outbox to upload (decision 12).
 */
export function createTodoList({
	device,
	repository,
	outbox,
}: {
	device: Notes;
	repository: Notes | null;
	outbox: Outbox<Todos> | null;
}) {
	const merged = () => mergeTodos(device, repository);

	/** The side whose copy shows: the device while it holds one, read or not. */
	const sideOf = ({ id }: PlaceholdersOf<TodoNotes>) =>
		repository === null ||
		device.get({ id }) !== undefined ||
		device.invalid.some((note) => note.id === id)
			? device
			: repository;

	return {
		/** Every todo that reads as one, open first, each oldest first. */
		get items() {
			return merged().items;
		},
		/** The notes at a todo's path that do not read as one, with their text. */
		get invalid() {
			return merged().invalid;
		},
		/** True until both sides have listed once. */
		get loading() {
			return device.loading || (repository?.loading ?? false);
		},
		/** Why a side could not be listed; what it showed before stays. */
		get error() {
			return device.error ?? repository?.error ?? null;
		},
		get(args: PlaceholdersOf<TodoNotes>): TodoRow | undefined {
			return merged().items.find(({ id }) => id === args.id);
		},
		async create(...[value]: Parameters<Notes['create']>) {
			if (repository !== null) {
				const created = await repository.create(value);
				if (created.error?.name !== 'Unavailable') return created;
			}
			const kept = await device.create(value);
			if (kept.error !== null || outbox === null) return kept;
			const queued = await outbox.add({
				id: value.id,
				files: [
					{ collection: 'todos', id: value.id, version: kept.data.version },
				],
			});
			if (queued.error !== null)
				log.warn(TodoListDiagnostic.NotQueued({ cause: queued.error }));
			return kept;
		},
		update(...[args, patch, options]: Parameters<Notes['update']>) {
			return sideOf(args).update(args, patch, options);
		},
		replace(...[args, text]: Parameters<Notes['replace']>) {
			return sideOf(args).replace(args, text);
		},
		delete(...[args]: Parameters<Notes['delete']>) {
			return sideOf(args).delete(args);
		},
	} satisfies Notes;
}

export type TodoList = ReturnType<typeof createTodoList>;
