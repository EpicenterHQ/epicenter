/**
 * `todos.rows`: the todo table, read and written through the folder's
 * options (ADR-0548). The listing is the one query, read through views of
 * the same cache entry; the rest are the writes, adding, and delete.
 *
 * - A field edit is a `set` of one todo: fields set on the file as it is
 *   now (ADR-0576), so it keeps every field another writer changed and
 *   wins only the fields it set. The editing view holds typed text until
 *   it is sent. The notes are a document: the view's body editor keeps the
 *   row it started from and `write` sends the change from that row to the
 *   typed body, merged by line with whatever changed since. Every write
 *   puts the row it wrote in the cache; a failure is reported, and the view
 *   keeps what was typed.
 * - A file that does not read as a todo is listed with why; Todos does not
 *   edit its text. Another editor fixes it, and the folder's change report
 *   shows the result.
 * - Todos does not rename files: a file's name is the file system's, Git's,
 *   or another program's to change. A delete beats edits that never saw it
 *   (ADR-0576): it runs once this app's running saves have landed and
 *   deletes what is there, whatever another writer changed meanwhile. An
 *   edit that lands after it writes nothing; the view offers typed notes
 *   as text (`notesGone`).
 */
import type { WriteError } from '@epicenter/folder';
import { ActionError, unsavedFields } from '@epicenter/svelte/write-failure';
import { defineKeys } from 'wellcrafted/query';
import type { Result } from 'wellcrafted/result';
import {
	repairsOf,
	type TodoListing,
	todoPath,
	todosOf,
	unreadableOf,
} from './todo-listing.js';
import type { TodosParts } from './todos.svelte.js';

/** Cache identity for the mutations the app runs beyond the folder's own. */
export const todosKeys = defineKeys({
	/** The delete of the file at `path`, which pauses its edits. */
	delete: (path: string) => ['todos', 'delete', path] as const,
});

export function createRows({
	folder,
	queries,
	queryClient,
	defineMutation,
	invalidate,
	writesSettled,
	writeFailed,
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
		/**
		 * Change one todo's fields as its file holds them now. The todo's
		 * writes run one at a time, in the order made. A failure is
		 * reported; the view keeps what was typed.
		 */
		set: {
			...queries.todos.set.mutationOptions(),
			// A typed title is offered to copy; the view that held it may be gone.
			onError: (error, { stem, fields }) =>
				writeFailed({
					path: todoPath(stem),
					error,
					unsaved: unsavedFields(fields),
				}),
		} satisfies ReturnType<typeof queries.todos.set.mutationOptions>,
		/**
		 * Write one todo's notes: the change from the row the edit started
		 * from to the typed body, merged by line into the file as it is now
		 * (`table.write`, ADR-0576), for the view's body editor. A failure is
		 * reported with the notes as text.
		 */
		write: {
			...queries.todos.write.mutationOptions(),
			onError: (error, { stem, to }) =>
				writeFailed({
					path: todoPath(stem),
					error,
					unsaved: to?.body ?? '',
				}),
		} satisfies ReturnType<typeof queries.todos.write.mutationOptions>,
		/**
		 * Notes typed into a todo that was deleted before they were written:
		 * nothing writes them (a delete beats edits that never saw it), so
		 * they are reported as a failed write, with the notes as text.
		 */
		notesGone(stem: string, unsaved: string) {
			writeFailed({
				path: todoPath(stem),
				error: ActionError.NotStarted({
					reason: 'The todo was deleted, so your notes were not saved.',
				}).error,
				unsaved,
			});
		},
		/** Add a todo titled `title`. The caller decides whether to show it. */
		create: defineMutation({
			mutationKey: ['todos', 'create'],
			mutationFn: (title: string) =>
				folder.tables.todos.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				),
			onSettled: () => invalidate(listing.queryKey),
		}),
		/**
		 * Whether `stem` is listed once running saves have landed. Ask when
		 * the person opens the delete confirmation, after what the view holds
		 * typed is sent.
		 */
		async listed(stem: string): Promise<boolean> {
			await writesSettled();
			return isListed(stem);
		},
		/**
		 * Delete a todo's file once running saves have landed, whatever it
		 * holds then. A file that shares the stem stays.
		 */
		async delete(stem: string): Promise<Result<undefined, WriteError>> {
			return defineMutation({
				mutationKey: todosKeys.delete(todoPath(stem)),
				mutationFn: async (): Promise<Result<undefined, WriteError>> => {
					await writesSettled();
					return folder.tables.todos.delete(stem);
				},
				onSettled: () => invalidate(listing.queryKey),
			})();
		},
	};
}
