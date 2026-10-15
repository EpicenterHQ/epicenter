/**
 * `todos.rows`: the todo table, read and written through the folder's
 * options (ADR-0548). The listing is the one query, read through views of
 * the same cache entry; the rest are the save, adding, and delete.
 *
 * - A field edit is an `update` of one todo: a change `table.update`
 *   applies to the file as it is now (ADR-0554), so it keeps every field
 *   another writer changed and wins only the fields it set. The editing
 *   view holds typed text until it is sent. The notes are a document: the
 *   view's body draft keeps the version it started from and `saveNotes`
 *   saves over it, merged by line with whatever changed since. Every write
 *   puts the row it wrote in the cache; a failure is reported, and the view
 *   keeps what was typed.
 * - A file that does not read as a todo is listed with why; Todos does not
 *   edit its text. Another editor fixes it, and the folder's change report
 *   shows the result.
 * - Todos does not rename files: a file's name is the file system's, Git's,
 *   or another program's to change. Delete carries the version the person
 *   confirmed: `shown` waits for running saves to land before it reads the
 *   version, so nothing this app does changes the file while the person
 *   decides; a different version when the delete runs came from elsewhere,
 *   and is refused.
 */
import type { FileCapture, FileError, TableError } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type Session, TodosError, todosKeys } from './session.js';
import {
	repairsOf,
	type TodoListing,
	todoPath,
	todosOf,
	unreadableOf,
} from './todo-listing.js';

export function createRows({
	folder,
	folder$,
	queryClient,
	defineMutation,
	invalidate,
	writesSettled,
	onWriteFailed,
}: Session) {
	const listing = folder$.todos.list.queryOptions();

	/** The bytes the cache holds for `stem`: a row's, or text that is not one. */
	function capturedOf(stem: string): FileCapture | undefined {
		const result = queryClient
			.getQueryData<TodoListing>(listing.queryKey)
			?.find((entry) => entry.stem === stem)?.result;
		if (result === undefined) return undefined;
		if (result.error === null) return result.data;
		return result.error.name === 'InvalidRow' ? result.error : undefined;
	}

	/**
	 * What a delete of `stem` acts on, decided when it runs: the bytes the
	 * cache holds, if they are the version the person confirmed. Anything
	 * else is refused.
	 */
	function confirmed(
		stem: string,
		shown: FileCapture,
	): Result<FileCapture, TodosError> {
		const current = capturedOf(stem);
		if (current === undefined)
			return TodosError.NotStarted({
				reason:
					'This file is not in the list as Todos last read it, so nothing was deleted.',
			});
		if (current.sha256 !== shown.sha256)
			return TodosError.NotStarted({
				reason:
					'The file changed after you chose this, so nothing was deleted. Its current version is shown.',
			});
		return Ok(current);
	}

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
		update: {
			...folder$.todos.update.mutationOptions(),
			onError: (error, { stem }) =>
				onWriteFailed({ path: todoPath(stem), error, unsaved: '' }),
		} satisfies ReturnType<typeof folder$.todos.update.mutationOptions>,
		/**
		 * Save one todo's notes over the version the edit started from, for
		 * the view's body draft. A failure is reported with the notes as text.
		 */
		saveNotes: {
			...folder$.todos.save.mutationOptions(),
			onError: (error, { base, row }) =>
				onWriteFailed({ path: base.path, error, unsaved: row.body }),
		} satisfies ReturnType<typeof folder$.todos.save.mutationOptions>,
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
		 * The version of `stem` a delete confirms: what the cache holds once
		 * running saves have landed. Ask for it when the person opens the
		 * confirmation, after what the view holds typed is sent, and pass it
		 * to `remove`.
		 */
		async shown(stem: string): Promise<FileCapture | undefined> {
			await writesSettled();
			return capturedOf(stem);
		},
		/**
		 * Delete a todo's file once running saves have landed. `shown` is the
		 * version the view showed when the person asked; anything else is
		 * refused. A file that shares the stem stays.
		 */
		async remove(
			stem: string,
			shown: FileCapture,
		): Promise<Result<undefined, FileError | TableError | TodosError>> {
			return defineMutation({
				mutationKey: todosKeys.remove(todoPath(stem)),
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | TodosError>
				> => {
					await writesSettled();
					const { data: capture, error } = confirmed(stem, shown);
					if (error !== null) return Err(error);
					return folder.tables.todos.delete(capture);
				},
				onSettled: () => invalidate(listing.queryKey),
			})();
		},
	};
}
