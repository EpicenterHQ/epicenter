/**
 * `todos.rows`: the todo table, read through the folder's options and
 * written through its edit layer (ADR-0548). The listing is the one query,
 * read through views of the same cache entry; the rest are adding and
 * delete.
 *
 * - A field edit is a `set` of one todo: fields set on the file as it is
 *   now (ADR-0576), so it keeps every field another writer changed and
 *   wins only the fields it set. The notes are the row's body draft
 *   (`edits.body`), merged by line with whatever changed since.
 * - A file that does not read as a todo is listed with why; Todos does not
 *   edit its text. Another editor fixes it, and the folder's change report
 *   shows the result.
 * - Todos does not rename files: a file's name is the file system's, Git's,
 *   or another program's to change. A delete beats edits that never saw it
 *   (ADR-0576): it runs once this app's drafts and saves of the todo have
 *   landed and deletes what is there, whatever another writer changed
 *   meanwhile.
 */
import type { WriteError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import {
	repairsOf,
	type TodoListing,
	todoPath,
	todosOf,
	unreadableOf,
} from './todo-listing.js';
import type { TodosParts } from './todos.svelte.js';

export function createRows({
	queries,
	queryClient,
	defineMutation,
	edits,
}: TodosParts) {
	const listing = queries.todos.list.queryOptions();

	/** Whether the cache lists `stem`: as a row, or as text that is not one. */
	const isListed = (stem: string) =>
		queryClient
			.getQueryData<TodoListing>(listing.queryKey)
			?.some((entry) => entry.stem === stem) ?? false;

	return {
		/** The todos that read as todos, as the list shows them: open first, then done. */
		todos: { ...listing, select: todosOf },
		/** The files in `todos/` that do not read as a todo, each with why. */
		repairs: { ...listing, select: repairsOf },
		unreadable: { ...listing, select: unreadableOf },
		/** The listing entry of `stem`: its row, or why it is not one; `undefined` when absent. */
		entry(stem: string) {
			return {
				...listing,
				select: (entries: TodoListing) =>
					entries.find((entry) => entry.stem === stem),
			};
		},
		/** Add a todo titled `title`. The caller decides whether to show it. */
		create: defineMutation({
			mutationKey: ['todos', 'create'],
			mutationFn: (title: string) =>
				edits.writes.tables.todos.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				),
		}),
		/**
		 * Whether `stem` is listed once what is typed is sent and running
		 * saves have landed. Ask when the person opens the delete
		 * confirmation.
		 */
		async listed(stem: string): Promise<boolean> {
			await edits.settled(todoPath(stem));
			return isListed(stem);
		},
		/**
		 * Delete a todo's file once its drafts and saves have landed,
		 * whatever it holds then. A file that shares the stem stays.
		 */
		delete(stem: string): Promise<Result<undefined, WriteError>> {
			return edits.exclusive(todoPath(stem), () =>
				edits.writes.tables.todos.delete(stem),
			);
		},
	};
}
