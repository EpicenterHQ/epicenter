/**
 * `todos.rows`: the todo table. The listing is the one query, read through
 * views of the same cache entry; every other member is a write of one todo's
 * file (ADR-0528).
 *
 * Every write carries the hash of the version the person acted on, taken
 * when they acted:
 *
 * - An edit is one immutable `map` over the cached listing. Each todo's
 *   writes run one at a time in its file's queue, and each saves the row the
 *   cache holds when it runs, guarded by the hash the cache last confirmed:
 *   the file the person was editing. A write that fails reads the file
 *   again, which rolls the edit back.
 * - A repair draft records the text it repairs, with its hash, at the first
 *   keystroke, and its Save is guarded by that hash.
 * - Rename and delete carry the capture the view showed when the person
 *   asked. They join the file's queue and run only on that version, or on
 *   one this app's own writes produced from it since.
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
	type TextCapture,
} from '@epicenter/folder';
import { hashKey } from '@tanstack/query-core';
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type TodoFields, todosDefinition } from './definition.js';
import { type Session, TodosError, todosKeys } from './session.js';
import {
	repairsOf,
	type TodoListing,
	todoPath,
	todoStem,
	todosOf,
} from './todo-listing.js';

/**
 * Why `stem` cannot name a todo, in words a person acts on. Any name the
 * folder can hold works, the empty stem (`todos/.md`) included.
 */
function stemProblem(stem: string): string | undefined {
	if (stem.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(todoPath(stem));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

/**
 * Repair text typed for a file that does not read as a todo. `base` is the
 * file's text and hash when the person first typed: the version the repair
 * replaces.
 */
export type RepairDraft = {
	readonly base: TextCapture;
	readonly text: string;
};

/** How many of a todo's own writes a rename or delete can look back through. */
const OWN_WRITES_KEPT = 8;

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
	/** Repair text typed and not saved, by stem. It lives as long as the folder is open. */
	const drafts = new SvelteMap<string, RepairDraft>();
	/**
	 * For each todo, the hashes this app's own writes produced, each mapped to
	 * the hash it replaced: newest last, at most `OWN_WRITES_KEPT`.
	 */
	const ownWrites = new Map<string, Map<string, string>>();

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

	/** The bytes the cache holds for `stem`: a row's, or text that is not one. */
	function capturedOf(stem: string): FileCapture | undefined {
		const result = resultOf(stem);
		if (result === undefined) return undefined;
		if (result.error === null) return result.data;
		return result.error.name === 'InvalidRow' ? result.error : undefined;
	}

	/** This app wrote `sha256` over `base` at `stem`. */
	function wrote(stem: string, base: string, sha256: string) {
		let links = ownWrites.get(stem);
		if (links === undefined) {
			links = new Map();
			ownWrites.set(stem, links);
		}
		links.delete(sha256);
		links.set(sha256, base);
		if (links.size > OWN_WRITES_KEPT) {
			const [oldest] = links.keys();
			if (oldest !== undefined) links.delete(oldest);
		}
	}

	/** Whether `sha256` is `shown`, or this app's own writes produced it from `shown`. */
	function descends(stem: string, sha256: string, shown: string) {
		const links = ownWrites.get(stem);
		let current: string | undefined = sha256;
		for (let hops = 0; hops <= OWN_WRITES_KEPT; hops++) {
			if (current === shown) return true;
			current = links?.get(current);
			if (current === undefined) return false;
		}
		return false;
	}

	/**
	 * What a rename or delete of `stem` acts on, decided when it runs: the
	 * bytes the cache holds, if they are the version the person was `shown`
	 * or one this app wrote from it since. Anything else is refused.
	 */
	function confirmed(
		stem: string,
		shown: FileCapture,
		done: 'renamed' | 'deleted',
	): Result<FileCapture, TodosError> {
		const current = capturedOf(stem);
		if (current === undefined)
			return TodosError.NotStarted({
				reason: `This file is not in the list as Todos last read it, so nothing was ${done}.`,
			});
		if (!descends(stem, current.sha256, shown.sha256))
			return TodosError.NotStarted({
				reason: `The file changed after you chose this, so nothing was ${done}. Its current version is shown.`,
			});
		return Ok(current);
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

	/**
	 * Read the file at `stem` again into the cache, whatever else is
	 * writing. A read of the listing still running could land over it, so it
	 * is cancelled first.
	 */
	async function rereadRow(stem: string) {
		await queryClient.cancelQueries({ queryKey: todosKeys.rows, exact: true });
		const { data: stored, error } = await table.get(stem);
		queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
			entries?.flatMap((entry) => {
				if (entry.stem !== stem) return [entry];
				if (error !== null) return [{ stem, result: Err(error) }];
				return stored === undefined ? [] : [{ stem, result: Ok(stored) }];
			}),
		);
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

	// A draft goes once its file reads as a todo or leaves the folder. A
	// file that only failed to read keeps its draft.
	const rowsHash = hashKey(todosKeys.rows);
	queryClient.getQueryCache().subscribe((event) => {
		if (
			drafts.size === 0 ||
			event.type !== 'updated' ||
			event.action.type !== 'success' ||
			event.query.queryHash !== rowsHash
		)
			return;
		const listing = event.query.state.data as TodoListing | undefined;
		if (listing === undefined) return;
		for (const stem of [...drafts.keys()]) {
			const entry = listing.find((candidate) => candidate.stem === stem);
			if (entry === undefined || entry.result.error === null)
				drafts.delete(stem);
		}
	});

	/** The listing query: one cache entry, each view narrowing it with `select`. */
	const listing = { queryKey: todosKeys.rows, queryFn: () => table.list() };

	return {
		/** The todos that read as todos, as the list shows them: open first, then done. */
		todos: defineQuery({ ...listing, select: todosOf }),
		/** The files in `todos/` that do not read as a todo, each with why. */
		repairs: defineQuery({ ...listing, select: repairsOf }),
		/** The listing entry of `stem`: its row, or why it is not one; `undefined` when absent. */
		entry(stem: string) {
			return defineQuery({
				...listing,
				select: (entries) => entries.find((entry) => entry.stem === stem),
			});
		},
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
					// The stem leaves `unsent` whether or not there is a row to send.
					const edited = unsent.delete(stem);
					if (stored === undefined || !edited) return Ok(undefined);
					const saved = await table.replace(stored, stored.row);
					if (saved.error === null)
						wrote(stem, stored.sha256, saved.data.sha256);
					return saved;
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
					await rereadRow(stem);
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
		/** The repair text typed for `stem` and not saved, read reactively. */
		draft(stem: string): RepairDraft | undefined {
			return drafts.get(stem);
		},
		/**
		 * Keep `text` as the repair typed for `stem`. The first keystroke
		 * records the text the cache holds, with its hash, as the draft's base.
		 * Refused, keeping nothing, while Epicenter asks to leave, while the
		 * file is renamed or deleted, and when the file reads as a todo.
		 */
		setDraft(stem: string, text: string): boolean {
			if (refused() !== undefined || moving(stem)) return false;
			const kept = drafts.get(stem);
			if (kept !== undefined) {
				drafts.set(stem, { base: kept.base, text });
				return true;
			}
			const result = resultOf(stem);
			if (result?.error?.name !== 'InvalidRow') return false;
			const { path, sha256, text: read } = result.error;
			drafts.set(stem, { base: { path, sha256, text: read }, text });
			return true;
		},
		/** Forget the repair typed for `stem`; the view shows the file's text again. */
		discardDraft(stem: string) {
			drafts.delete(stem);
		},
		/** How many repairs are typed and not saved, read reactively. */
		get drafted() {
			return drafts.size;
		},
		/**
		 * The repair of a todo whose text does not read as one: write `text`
		 * over `base`, the version the person typed over. The text is written
		 * as typed, valid or not, and the file is read again. A file changed
		 * since is the folder's `Conflict`: nothing is written, the typed text
		 * is reported, and the draft stays.
		 */
		repair(stem: string) {
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.repair(path),
				scope: { id: path },
				mutationFn: async ({
					text,
					base,
				}: {
					text: string;
					base: FileCapture;
				}): Promise<Result<FileCapture, FileError | TodosError>> => {
					const saved = await folder.files.replace(base, text);
					if (saved.error === null) wrote(stem, base.sha256, saved.data.sha256);
					return saved;
				},
				// The view shows the written text before the draft goes.
				onSuccess: async () => {
					await rereadRow(stem);
					drafts.delete(stem);
				},
				onError: (error, { text }) =>
					onWriteFailed({ path, error, lost: text }),
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
		 * Rename a todo's file to `todos/<nextStem>.md`. `shown` is the version
		 * the view showed when the person asked. It runs after the file's
		 * queued writes, and only on that version or one this app wrote from
		 * it since; anything else is refused. No other file moves with it, and
		 * edits of the todo wait meanwhile.
		 */
		async rename(
			stem: string,
			nextStem: string,
			shown: FileCapture,
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
					Result<FileCapture, FileError | MoveError | TableError | TodosError>
				> => {
					const { data: capture, error } = confirmed(stem, shown, 'renamed');
					if (error !== null) return Err(error);
					return table.rename(capture, nextStem);
				},
				// The listing, a typed repair, and the app's own writes follow the
				// file. The draft moves first: the listing's update drops a draft
				// whose stem it no longer holds.
				onSuccess: (moved) => {
					const draft = drafts.get(stem);
					if (draft !== undefined) {
						drafts.delete(stem);
						drafts.set(nextStem, {
							...draft,
							base: { ...draft.base, path: moved.path },
						});
					}
					const links = ownWrites.get(stem);
					ownWrites.delete(stem);
					if (links !== undefined) ownWrites.set(nextStem, links);
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
		 * Delete a todo's file. `shown` is the version the view showed when the
		 * person asked. It runs after the file's queued writes, and only on
		 * that version or one this app wrote from it since; anything else is
		 * refused. A file that shares the stem stays.
		 */
		async remove(
			stem: string,
			shown: FileCapture,
		): Promise<Result<undefined, FileError | TableError | TodosError>> {
			const path = todoPath(stem);
			return defineMutation({
				mutationKey: todosKeys.remove(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | TodosError>
				> => {
					const { data: capture, error } = confirmed(stem, shown, 'deleted');
					if (error !== null) return Err(error);
					return table.delete(capture);
				},
				onSuccess: () => {
					unsent.delete(stem);
					ownWrites.delete(stem);
					queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
						entries?.filter((entry) => entry.stem !== stem),
					);
				},
				onSettled: () => invalidate(todosKeys.rows),
			})();
		},
	};
}
