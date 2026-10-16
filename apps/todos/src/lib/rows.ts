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
 *   or another program's to change. Delete carries the version the person
 *   confirmed: `shown` waits for running saves to land before it reads the
 *   version, so nothing this app does changes the file while the person
 *   decides; a different version in the cache when the delete runs came
 *   from elsewhere, and is refused. The folder's delete itself takes no
 *   version: what is there when it lands is deleted.
 */
import type { FileCapture, WriteError } from '@epicenter/folder';
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
	): Result<undefined, TodosError> {
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
		return Ok(undefined);
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
		set: {
			...folder$.todos.set.mutationOptions(),
			onError: (error, { stem }) =>
				onWriteFailed({ path: todoPath(stem), error, unsaved: '' }),
		} satisfies ReturnType<typeof folder$.todos.set.mutationOptions>,
		/**
		 * Write one todo's notes: the change from the row the edit started
		 * from to the typed body, merged by line into the file as it is now
		 * (`table.write`, ADR-0576), for the view's body editor. A failure is
		 * reported with the notes as text.
		 */
		write: {
			...folder$.todos.write.mutationOptions(),
			onError: (error, { stem, to }) =>
				onWriteFailed({
					path: todoPath(stem),
					error,
					unsaved: to?.body ?? '',
				}),
		} satisfies ReturnType<typeof folder$.todos.write.mutationOptions>,
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
		 * to `delete`.
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
		async delete(
			stem: string,
			shown: FileCapture,
		): Promise<Result<undefined, WriteError | TodosError>> {
			return defineMutation({
				mutationKey: todosKeys.delete(todoPath(stem)),
				mutationFn: async (): Promise<
					Result<undefined, WriteError | TodosError>
				> => {
					await writesSettled();
					const { error } = confirmed(stem, shown);
					if (error !== null) return Err(error);
					return folder.tables.todos.delete(stem);
				},
				onSettled: () => invalidate(listing.queryKey),
			})();
		},
	};
}
