/**
 * `todos.rows`: the todo listing, an edit to one todo in the cache, the write
 * that saves it, and adding a todo (ADR-0528).
 *
 * An edit is one immutable `map` over the cached listing. Each todo's writes
 * run one at a time in its file's queue, and each saves the row the cache
 * holds when it runs, guarded by the hash the cache last confirmed. A write
 * that fails reads the file again, which rolls the edit back.
 */
import {
	type FileError,
	formatRow,
	type Row,
	type StoredRow,
	type TableCreateError,
	type TableError,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type TodoFields, todosDefinition } from './definition.js';
import { type Session, type TodosError, todosKeys } from './session.js';
import { type TodoListing, todoPath, todoStem } from './todo-listing.js';

export function createRows({
	folder,
	queryClient,
	defineQuery,
	defineMutation,
	invalidate,
	refused,
	moving,
	afterWrite,
	onWriteFailed,
	selection,
}: Session) {
	const table = folder.tables.todos;
	/**
	 * Todos whose cached row holds an edit no write has sent. A write sends
	 * only these, so the write waiting behind one that failed does not write
	 * back the file it just reread.
	 */
	const unsent = new Set<string>();

	/** The row the cache holds for `stem`, if it reads as a todo. */
	function rowOf(stem: string): StoredRow<TodoFields> | undefined {
		const result = queryClient
			.getQueryData<TodoListing>(todosKeys.rows)
			?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Change the row at `stem` in the cache: one immutable `map` over the listing. */
	function mapRow(
		stem: string,
		change: (stored: StoredRow<TodoFields>) => StoredRow<TodoFields>,
	): boolean {
		let changed = false;
		queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
			entries?.map((entry) => {
				if (entry.stem !== stem || entry.result.error !== null) return entry;
				changed = true;
				return { ...entry, result: Ok(change(entry.result.data)) };
			}),
		);
		return changed;
	}

	return {
		/** Every todo row file, as the table lists it. Narrow it with `select` where it is shown. */
		list: defineQuery({
			queryKey: todosKeys.rows,
			queryFn: () => table.list(),
		}),
		/**
		 * Change the todo at `stem` in the cache. Answers whether the caller
		 * should queue a write: an edit queues one only when fewer than two are
		 * running or waiting for that file, since the waiting one saves whatever
		 * the cache holds when it runs. Refused, changing nothing, while
		 * Epicenter asks to leave and while a rename or delete of the file runs.
		 */
		edit(stem: string, change: (row: Row<TodoFields>) => Row<TodoFields>) {
			if (refused() !== undefined || moving(todoPath(stem))) return false;
			// A read still running could replace this edit when it lands.
			void queryClient.cancelQueries({ queryKey: todosKeys.rows, exact: true });
			const changed = mapRow(stem, (stored) => ({
				...stored,
				row: change(stored.row),
			}));
			if (!changed) return false;
			unsent.add(stem);
			return (
				queryClient.isMutating({
					mutationKey: todosKeys.write(todoPath(stem)),
					exact: true,
				}) < 2
			);
		},
		/**
		 * The write of one todo. Each view that edits it creates its own
		 * mutation from `.options`. It saves the row the cache holds when it
		 * runs, guarded by the hash the cache last confirmed.
		 */
		write(stem: string) {
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.write(path),
				// Row and text writes of one file share its queue.
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<
						StoredRow<TodoFields> | undefined,
						| Extract<TableError, { name: 'Conflict' | 'InvalidValues' }>
						| FileError
					>
				> => {
					const stored = rowOf(stem);
					if (stored === undefined || !unsent.delete(stem))
						return Ok(undefined);
					return table.replace(stored, stored.row);
				},
				onSuccess: (saved) => {
					if (saved === undefined) return;
					// TanStack awaits this before the next write in the scope runs.
					mapRow(stem, (stored) => ({
						...stored,
						path: saved.path,
						sha256: saved.sha256,
					}));
				},
				// Roll back: the cache takes the row as the file holds it now.
				// TanStack awaits this before the next write of the file runs, so
				// that write finds no unsent edit and writes nothing.
				onError: async (error) => {
					const lost = rowOf(stem)?.row;
					unsent.delete(stem);
					await queryClient.cancelQueries({
						queryKey: todosKeys.rows,
						exact: true,
					});
					const { data: stored, error: readError } = await table.get(stem);
					queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
						entries?.flatMap((entry) => {
							if (entry.stem !== stem) return [entry];
							if (readError !== null) return [{ stem, result: Err(readError) }];
							return stored === undefined ? [] : [{ stem, result: Ok(stored) }];
						}),
					);
					onWriteFailed({
						path,
						error,
						lost:
							lost === undefined
								? ''
								: (formatRow(todosDefinition.tables.todos, lost).data ??
									lost.fields.title),
					});
				},
				onSettled: afterWrite,
			});
		},
		/** Add a todo and show it. */
		create: defineMutation({
			mutationKey: ['todos', 'create'],
			mutationFn: async (
				title: string,
			): Promise<
				Result<StoredRow<TodoFields>, TableCreateError | TodosError>
			> =>
				table.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				),
			onSuccess: (created) => {
				const stem = todoStem(created.path);
				if (stem !== undefined)
					queryClient.setQueryData<TodoListing>(
						todosKeys.rows,
						(entries) => entries && [...entries, { stem, result: Ok(created) }],
					);
				selection.set({ path: created.path, as: 'todos' });
			},
			onSettled: () =>
				Promise.all([invalidate(todosKeys.rows), invalidate(todosKeys.files)]),
		}),
	};
}
