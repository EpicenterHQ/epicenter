/**
 * `todos.rows`: the todo table. The listing is the one query; every other
 * member is a write of one todo's file (ADR-0528).
 *
 * An edit is one immutable `map` over the cached listing. Each todo's writes
 * run one at a time in its file's queue, and each saves the row the cache
 * holds when it runs, guarded by the hash the cache last confirmed. A write
 * that fails reads the file again, which rolls the edit back. Rename, delete,
 * and repair join the same queue and are guarded by the same cached hash.
 */
import {
	type FileCapture,
	type FileError,
	formatRow,
	type MoveError,
	pathProblem,
	type Row,
	type StoredRow,
	type TableCreateError,
	type TableError,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type TodoFields, todosDefinition } from './definition.js';
import { type Session, TodosError, todosKeys } from './session.js';
import { type TodoListing, todoPath, todoStem } from './todo-listing.js';

/**
 * Why `stem` cannot name a todo, in words a person acts on. Any name the
 * folder can hold works, the empty stem (`todos/.md`) included.
 */
export function stemProblem(stem: string): string | undefined {
	if (stem.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(todoPath(stem));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

export function createRows({
	folder,
	queryClient,
	defineQuery,
	defineMutation,
	invalidate,
	trackMutations,
	refused,
	afterWrite,
	onWriteFailed,
}: Session) {
	const table = folder.tables.todos;
	/**
	 * Todos whose cached row holds an edit no write has sent. A write sends
	 * only these, so the write waiting behind one that failed does not write
	 * back the file it just reread.
	 */
	const unsent = new Set<string>();

	/** What the cache holds for `stem`: a row, or why it is not one. */
	function resultOf(stem: string) {
		return queryClient
			.getQueryData<TodoListing>(todosKeys.rows)
			?.find((entry) => entry.stem === stem)?.result;
	}

	/** The row the cache holds for `stem`, if it reads as a todo. */
	function rowOf(stem: string): StoredRow<TodoFields> | undefined {
		const result = resultOf(stem);
		return result?.error === null ? result.data : undefined;
	}

	/**
	 * The bytes a rename or delete of `stem` acts on, read when it runs: the
	 * hash the cache last confirmed, for a row or for text that is not one.
	 * A todo the cache cannot vouch for is read now.
	 */
	async function captureOf(
		stem: string,
	): Promise<Result<FileCapture, FileError>> {
		const result = resultOf(stem);
		if (result?.error === null) return Ok(result.data);
		if (result?.error.name === 'InvalidRow') return Ok(result.error);
		const { data: read, error } = await folder.files.read(todoPath(stem));
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
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

	/** Whether a rename or delete of `stem` runs or waits, which pauses its edits. */
	function moving(stem: string) {
		const path = todoPath(stem);
		return (
			queryClient.isMutating({
				mutationKey: todosKeys.move(path),
				exact: true,
			}) +
				queryClient.isMutating({
					mutationKey: todosKeys.remove(path),
					exact: true,
				}) >
			0
		);
	}

	return {
		/** Every todo row file, as the table lists it. Narrow it with `select` where it is shown. */
		list: defineQuery({
			queryKey: todosKeys.rows,
			queryFn: () => table.list(),
		}),
		/** Whether `stem` is being renamed or deleted, which pauses its edits; read reactively. */
		isMoving(stem: string) {
			trackMutations();
			return moving(stem);
		},
		/**
		 * Change the todo at `stem` in the cache. Answers whether the caller
		 * should queue a write: an edit queues one only when fewer than two are
		 * running or waiting for that file, since the waiting one saves whatever
		 * the cache holds when it runs. Refused, changing nothing, while
		 * Epicenter asks to leave and while a rename or delete of the file runs.
		 */
		edit(stem: string, change: (row: Row<TodoFields>) => Row<TodoFields>) {
			if (refused() !== undefined || moving(stem)) return false;
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
				// Every write, rename, delete, and repair of one file shares its queue.
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
		/**
		 * The repair of a todo whose text does not read as one: write the text
		 * typed for it, guarded by the hash of the text the listing read. The
		 * text is written as typed, valid or not; the listing then reads it
		 * again. A failure writes nothing and reports the typed text.
		 */
		repair(stem: string) {
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.repair(path),
				scope: { id: path },
				mutationFn: async (
					text: string,
				): Promise<Result<FileCapture, FileError | TodosError>> => {
					const result = resultOf(stem);
					if (result?.error?.name !== 'InvalidRow')
						return TodosError.NotStarted({
							reason: 'This file reads as a todo now, so nothing was written.',
						});
					return folder.files.replace(result.error, text);
				},
				onError: (error, text) => onWriteFailed({ path, error, lost: text }),
				onSettled: afterWrite,
			});
		},
		/** Add a todo. The caller decides whether to show it. */
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
			},
			onSettled: () => invalidate(todosKeys.rows),
		}),
		/**
		 * Rename a todo's file to `todos/<nextStem>.md`. It runs after the
		 * file's queued writes and moves what the last one confirmed; a file
		 * changed elsewhere since is refused. No other file moves with it, and
		 * edits of the todo wait meanwhile.
		 */
		async rename(
			stem: string,
			nextStem: string,
		): Promise<
			Result<
				FileCapture | undefined,
				FileError | MoveError | TableError | TodosError
			>
		> {
			const problem = stemProblem(nextStem);
			if (problem !== undefined)
				return TodosError.NotStarted({ reason: problem });
			if (nextStem === stem) return Ok(undefined);
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.move(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<FileCapture, FileError | MoveError | TableError>
				> => {
					const { data: capture, error } = await captureOf(stem);
					if (error !== null) return Err(error);
					return table.rename(capture, nextStem);
				},
				// The listing follows the file.
				onSuccess: (moved) => {
					queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
						entries?.map((entry) => {
							if (entry.stem !== stem) return entry;
							const { result } = entry;
							if (result.error === null)
								return {
									stem: nextStem,
									result: Ok({ ...result.data, path: moved.path }),
								};
							if (result.error.name === 'InvalidRow')
								return {
									stem: nextStem,
									result: Err({ ...result.error, path: moved.path }),
								};
							return { stem: nextStem, result };
						}),
					);
				},
				onSettled: () => invalidate(todosKeys.rows),
			})();
		},
		/**
		 * Delete a todo's file. It runs after the file's queued writes, so it
		 * removes what this app saved last; a file changed elsewhere since is
		 * refused. A file that shares the stem stays.
		 */
		async remove(
			stem: string,
		): Promise<Result<undefined, FileError | TableError | TodosError>> {
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.remove(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError>
				> => {
					const { data: capture, error } = await captureOf(stem);
					if (error !== null) return Err(error);
					return table.delete(capture);
				},
				onSuccess: () => {
					unsent.delete(stem);
					queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
						entries?.filter((entry) => entry.stem !== stem),
					);
				},
				onSettled: () => invalidate(todosKeys.rows),
			})();
		},
	};
}
