/**
 * The Todos product state over one opened folder, kept in a TanStack Query
 * cache (ADR-0528).
 *
 * Reads are queries: the todo listing (`folder.tables.todos.list()`), the
 * folder listing the file browser shows, the text of each file opened as
 * text, and Git status. They are read when a screen opens, when the window
 * regains focus, and after the app's own actions. Nothing follows the
 * folder's change reports.
 *
 * An edit goes straight into the cache: one immutable `map` over the listing
 * changes one row, and one replacement changes a file's text. Each edit is
 * written by a mutation scoped to its file, so writes to one file run one at
 * a time while writes to different files run side by side. A write reads the
 * cache when it runs, so it saves the newest row and is guarded by the
 * newest confirmed `sha256`; a file has at most one write running and one
 * waiting. A write that succeeds moves the guard forward and keeps what was
 * typed meanwhile. A write that fails reads the file again, which rolls the
 * edit back, and reports what was lost.
 *
 * Every other action is a mutation too: create, rename, delete, Save
 * version, Sync and its Apply, incoming recovery, and terminal commands.
 * Leaving and closing fence new input, then wait until nothing is mutating.
 * Saves never commit (ADR-0529); a version is recorded by Sync or by Save
 * version.
 */
import type { DepartureParticipant } from '@epicenter/epicenter/departure/page';
import {
	type CommitOutcome,
	type FileCapture,
	type FileError,
	type FileListing,
	type FilesObservation,
	formatRow,
	type GitError,
	type MoveError,
	type PullError,
	type RecoverOutcome,
	type Row,
	type RowReadError,
	rowPath,
	rowStemOf,
	type StoredRow,
	type SyncAttempt,
	type SyncChoices,
	SyncError,
	type SyncOutcome,
	type TableCreateError,
	type TableError,
	type TableListing,
} from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
	type OpenedFile,
} from '@epicenter/folder/file-browser';
import type {
	MutationFilters,
	MutationKey,
	QueryClient,
} from '@tanstack/svelte-query';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import {
	createQueryFactories,
	defineKeys,
	resultMutationOptions,
	resultQueryOptions,
} from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type TodoFields, todosDefinition } from './definition.js';
import { nameProblem, readTextFile } from './files.js';
import type { TodosFolder } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Todos = ReturnType<typeof createTodos>;

/** Every todo row file, as the table lists it: a row, or why it is not one. */
export type TodoListing = TableListing<TodoFields>;

/** A todo row that reads as a todo. */
export type TodoEntry = StoredRow<TodoFields> & { readonly stem: string };

/** A row file the list cannot edit, and why, for the person to repair as text. */
export type Repair = { readonly path: string; readonly reason: string };

/**
 * What the detail shows: a todo's fields (`todos`), a file's complete text
 * (`files`), or a todo whose text does not read as a todo, opened as text
 * from the list (`repair`).
 */
export type Selection = {
	readonly path: string;
	readonly as: 'todos' | 'files' | 'repair';
};

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion =
	| { readonly kind: 'folder'; readonly path: string }
	| {
			readonly kind: 'todo' | 'file';
			readonly path: string;
			/** What the dialog names: a todo's title, or the file's name. */
			readonly title: string;
			/** The file as it was when the person was asked, for a file no view holds. */
			readonly capture: FileCapture;
			/**
			 * Whether the file has changes that are in no saved version, as Git
			 * status last checked; `undefined` when the check failed.
			 */
			readonly unversioned: boolean | undefined;
	  };

/** A write that failed and was rolled back to the file. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError;
	/** The text that was in the editor and is not in the file. */
	readonly lost: string;
};

/** Why an action did not start: the page is closing, or Epicenter asks to leave. */
export const TodosError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type TodosError = InferErrors<typeof TodosError>;

/** Why input or a command was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now.';
const CLOSING = 'Todos is closing, so nothing was changed.';

/**
 * Every query and mutation reads or writes local files, so none waits for a
 * network connection, and a read that failed is shown rather than retried.
 */
const LOCAL = { networkMode: 'always', retry: false } as const;

/** Cache identity for every query and mutation the app runs. */
export const todosKeys = defineKeys({
	/** Every query the app keeps; invalidated after sync, Apply, and recovery. */
	all: ['todos'],
	rows: ['todos', 'rows'],
	files: ['todos', 'files'],
	status: ['todos', 'status'],
	text: (path: string) => ['todos', 'text', path] as const,
	write: (stem: string) => ['todos', 'write', stem] as const,
	writeText: (path: string) => ['todos', 'write-text', path] as const,
	move: (path: string) => ['todos', 'move', path] as const,
	remove: (path: string) => ['todos', 'remove', path] as const,
});

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error: FileError | MoveError | TableError | TodosError,
): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'Exists':
			return `"${basename(error.path)}" already exists here.`;
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Its current version is shown.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${error.to}, but ${error.from} could not be removed, so the folder now has both. Delete whichever you do not want.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`;
		case 'InvalidValues':
			return error.issues.map((issue) => issue.message).join(' ');
		default:
			return error.message;
	}
}

/** Why a listed row file is not a todo the list can edit. */
function repairOf(path: string, error: RowReadError): Repair {
	if (error.name === 'InvalidRow')
		return {
			path,
			reason: error.issues.map((issue) => issue.message).join(' '),
		};
	return { path, reason: `It could not be read as text: ${error.message}` };
}

function byPath(a: { path: string }, b: { path: string }) {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The listing as the list shows it: open todos first, then done, each by path. */
export function todosOf(listing: TodoListing): TodoEntry[] {
	const entries: TodoEntry[] = [];
	for (const { stem, result } of listing)
		if (result.error === null) entries.push({ ...result.data, stem });
	return entries.sort(
		(a, b) =>
			Number(a.row.fields.done) - Number(b.row.fields.done) || byPath(a, b),
	);
}

/** The row files the list does not offer, each with why. */
export function repairsOf(listing: TodoListing): Repair[] {
	const repairs: Repair[] = [];
	for (const { stem, result } of listing)
		if (result.error !== null)
			repairs.push(repairOf(rowPath('todos', stem), result.error));
	return repairs.sort(byPath);
}

/**
 * Resolves once nothing matching `filters` is mutating. It watches the
 * mutation cache, so a mutation that starts meanwhile is waited for too.
 */
export function whenIdle(
	queryClient: QueryClient,
	filters?: MutationFilters,
): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating(filters) > 0) return;
			unsubscribe();
			resolve();
		}
		check();
	});
}

/** Whether a mutation key names a write of a todo row or a file's text. */
function isWrite(key: MutationKey | undefined) {
	return (
		key?.[0] === 'todos' && (key[1] === 'write' || key[1] === 'write-text')
	);
}

/**
 * What one kind of write has done, so a read that ran while a file was
 * being written does not replace what the cache holds for it.
 *
 * `unsaved` names files with an edit no write has taken yet. `savedAt`
 * orders each file's last confirmed write against the start of a read: a
 * read that began before it may hold the file's previous bytes. A file
 * whose write failed is `rollingBack` until the read that rolls it back has
 * landed; that read always wins.
 */
function createWriteLog(busy: (id: string) => boolean) {
	let sequence = 0;
	const savedAt = new Map<string, number>();
	const unsaved = new Set<string>();
	const rollingBack = new Set<string>();
	return {
		unsaved,
		rollingBack,
		/** A mark to take before a read starts. */
		get sequence() {
			return sequence;
		},
		saved(id: string) {
			savedAt.set(id, ++sequence);
		},
		/** The file was renamed or deleted: nothing about it is kept. */
		forget(id: string) {
			savedAt.delete(id);
			unsaved.delete(id);
		},
		/** Whether the cache holds something for `id` newer than a read that began at `since`. */
		newer(id: string, since: number) {
			if (rollingBack.has(id)) return false;
			return unsaved.has(id) || busy(id) || (savedAt.get(id) ?? 0) > since;
		},
	};
}

export function createTodos(
	folder: TodosFolder,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
	}: {
		/** A write failed and was rolled back; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
	} = {},
) {
	const table = folder.tables.todos;
	const { defineMutation } = createQueryFactories(queryClient);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['todos']);
	/** What the detail shows. */
	let selected = $state.raw<Selection | undefined>();
	/** The title typed for a new todo and not yet added. */
	let newTitle = $state('');
	/**
	 * Epicenter asks to quit or restart. From `departure.fence` until
	 * `departure.resume`, no edit or action starts; writes already queued go on.
	 */
	let departing = $state(false);
	let closing: Promise<void> | undefined;
	let closed = $state(false);

	/** Why no edit or action starts now, if one does not. */
	function refused(): string | undefined {
		if (closed) return CLOSING;
		if (departing) return DEPARTING;
		return undefined;
	}

	const rowWrites = createWriteLog(
		(stem) =>
			queryClient.isMutating({
				mutationKey: todosKeys.write(stem),
				exact: true,
			}) > 0,
	);
	const textWrites = createWriteLog(
		(path) =>
			queryClient.isMutating({
				mutationKey: todosKeys.writeText(path),
				exact: true,
			}) > 0,
	);

	/** Resolves once no write of a row or a file's text is running or waiting. */
	const writesSettled = () =>
		whenIdle(queryClient, {
			predicate: (mutation) => isWrite(mutation.options.mutationKey),
		});

	const rowsData = () => queryClient.getQueryData<TodoListing>(todosKeys.rows);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(todosKeys.text(path));

	/** The row the cache holds for `stem`, if it reads as a todo. */
	function rowOf(stem: string): StoredRow<TodoFields> | undefined {
		const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/**
	 * Every row file, read through the table. A row with an edit not yet
	 * written, a write running, or a write confirmed since this read began
	 * keeps what the cache holds; the read may have seen its previous bytes.
	 */
	async function listRows() {
		const since = rowWrites.sequence;
		const { data: listed, error } = await table.list();
		if (error !== null) return Err(error);
		const cached = rowsData();
		const kept = new Map(
			(cached ?? [])
				.filter((entry) => rowWrites.newer(entry.stem, since))
				.map((entry) => [entry.stem, entry]),
		);
		if (kept.size === 0) return Ok(listed);
		const merged = listed.map((entry) => kept.get(entry.stem) ?? entry);
		for (const [stem, entry] of kept)
			if (!listed.some((read) => read.stem === stem)) merged.push(entry);
		return Ok(merged as TodoListing);
	}

	/** One file's text, or its type and size; the same rule as `listRows` for writes. */
	async function readText(path: string) {
		const since = textWrites.sequence;
		const read = await readTextFile(folder.files, path);
		const cached = textData(path);
		if (cached !== undefined && textWrites.newer(path, since))
			return Ok(cached);
		return read;
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

	/** Change the text of `path` in the cache, if it holds text. */
	function mapText(
		path: string,
		change: (file: { path: string; sha256: string; text: string }) => {
			path: string;
			sha256: string;
			text: string;
		},
	): boolean {
		let changed = false;
		queryClient.setQueryData<OpenedFile>(todosKeys.text(path), (opened) => {
			if (opened?.kind !== 'text') return opened;
			changed = true;
			return { kind: 'text', file: change(opened.file) };
		});
		return changed;
	}

	/** Whether a rename or delete of `path` is running or waiting, which pauses its edits. */
	const moving = (path: string) =>
		queryClient.isMutating({ mutationKey: todosKeys.move(path), exact: true }) +
			queryClient.isMutating({
				mutationKey: todosKeys.remove(path),
				exact: true,
			}) >
		0;

	/** The text a person loses with a row that could not be written. */
	function rowText(row: Row<TodoFields>) {
		return (
			formatRow(todosDefinition.tables.todos, row).data ?? row.fields.title
		);
	}

	/**
	 * Read again after a write failed. The read wins over the failed edit
	 * and anything typed after it, and a write still waiting finds nothing
	 * new to save.
	 */
	async function rollBack(
		log: ReturnType<typeof createWriteLog>,
		id: string,
		queryKey: readonly unknown[],
	) {
		log.unsaved.delete(id);
		log.rollingBack.add(id);
		try {
			await queryClient.invalidateQueries({ queryKey, exact: true });
		} finally {
			log.rollingBack.delete(id);
		}
	}

	/** Invalidate after an action: what it may have changed is read again. */
	const invalidate = (queryKey: readonly unknown[] = todosKeys.all) =>
		queryClient.invalidateQueries({ queryKey });

	/** The same file as captured now, for a file no view holds. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/**
	 * Whether the fields of the todo at `path` are what the app edits now,
	 * rather than its text: its rename or delete then joins the row's writes.
	 */
	const editsRow = (path: string) =>
		rowStemOf(table.name, path) !== undefined &&
		!(selected?.path === path && selected.as !== 'todos');

	/** The scope a rename or delete of `path` joins: its row's writes, or its text's. */
	const scopeOf = (path: string) =>
		editsRow(path) ? (rowStemOf(table.name, path) as string) : path;

	/**
	 * The capture a rename or delete of `path` acts on, read when it runs:
	 * the newest hash the cache confirmed for what the app edits, if it holds
	 * one. An invalid row is a capture of its bytes too.
	 */
	function heldCapture(path: string): FileCapture | undefined {
		if (editsRow(path)) {
			const stem = rowStemOf(table.name, path);
			const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
			if (result?.error === null) return result.data;
			if (result?.error.name === 'InvalidRow') return result.error;
		}
		const opened = textData(path);
		return opened?.kind === 'text' ? opened.file : undefined;
	}

	/** After a rename: the caches, the open item, and the write logs follow the file. */
	function moved(from: string, to: string) {
		const stem = rowStemOf(table.name, from);
		const nextStem = rowStemOf(table.name, to);
		if (stem !== undefined) {
			rowWrites.forget(stem);
			queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
				entries?.flatMap((entry) => {
					if (entry.stem !== stem) return [entry];
					if (nextStem === undefined) return [];
					const result =
						entry.result.error === null
							? Ok({ ...entry.result.data, path: to })
							: entry.result;
					return [{ stem: nextStem, result }];
				}),
			);
		}
		textWrites.forget(from);
		queryClient.removeQueries({ queryKey: todosKeys.text(from), exact: true });
		if (selected?.path === from) selected = { ...selected, path: to };
	}

	/** After a delete: the caches and the open item let the file go. */
	function deleted(path: string) {
		const stem = rowStemOf(table.name, path);
		if (stem !== undefined) {
			rowWrites.forget(stem);
			queryClient.setQueryData<TodoListing>(todosKeys.rows, (entries) =>
				entries?.filter((entry) => entry.stem !== stem),
			);
		}
		textWrites.forget(path);
		queryClient.removeQueries({ queryKey: todosKeys.text(path), exact: true });
		if (selected?.path === path) selected = undefined;
	}

	/** The todo listing, narrowed by `select` for one view. */
	function rowsQuery<TData = TodoListing>(
		select?: (listing: TodoListing) => TData,
	) {
		return resultQueryOptions({
			queryKey: todosKeys.rows,
			queryFn: listRows,
			...LOCAL,
			select,
		});
	}

	/** Git status: changes since the last version, and local and remote heads. */
	function statusQuery() {
		return resultQueryOptions({
			queryKey: todosKeys.status,
			queryFn: (): Promise<Result<FilesObservation, GitError>> =>
				folder.git.status(),
			...LOCAL,
		});
	}

	const shell = folder.terminal();
	/** A terminal command may write anything, so it is a mutation, and every listing is read again after it. */
	const runCommand = defineMutation({
		mutationKey: ['todos', 'terminal'],
		...LOCAL,
		mutationFn: async ({
			command,
			options,
		}: {
			command: string;
			options?: { signal?: AbortSignal };
		}) => Ok(await shell.exec(command, options)),
		onSettled: () => invalidate(),
	});
	const terminal = createTerminalSession(
		{
			get cwd() {
				return shell.cwd;
			},
			async exec(command, options) {
				const why = refused();
				if (why !== undefined)
					return { stdout: '', stderr: `${why}\n`, exitCode: 1 };
				// A command that throws is shown in the terminal's output.
				const ran = await runCommand({ command, options });
				if (ran.data === null) throw ran.error;
				return ran.data;
			},
		},
		() => departing,
	);

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		queryClient,
		terminal,
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		get departing() {
			return departing;
		},
		/** How many mutations match `filters`, read reactively. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a write of a row or a file's text is running or waiting, read reactively. */
		get saving() {
			trackMutations();
			return (
				queryClient.isMutating({
					predicate: (mutation) => isWrite(mutation.options.mutationKey),
				}) > 0
			);
		},
		/** Whether `path` is being renamed or deleted, which pauses its edits; read reactively. */
		isMoving(path: string) {
			trackMutations();
			return moving(path);
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		rowsQuery,
		/** The folder listing the file browser shows. */
		filesQuery() {
			return resultQueryOptions({
				queryKey: todosKeys.files,
				queryFn: () => folder.files.list(),
				...LOCAL,
			});
		},
		/** One file's complete text, or its type and size when it is not editable text. */
		textQuery(path: string) {
			return resultQueryOptions({
				queryKey: todosKeys.text(path),
				queryFn: () => readText(path),
				...LOCAL,
			});
		},
		statusQuery,

		// ------------------------------------------------------------------
		// What the detail shows
		// ------------------------------------------------------------------

		get selected() {
			return selected;
		},
		/** Show `path` in the detail, as `as` edits it. Opening never waits or asks. */
		select(path: string, as: Selection['as']) {
			selected = { path, as };
			if (as === 'files')
				for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		},

		// ------------------------------------------------------------------
		// Edits and writes
		// ------------------------------------------------------------------

		/**
		 * Change the todo at `stem` in the cache. Answers whether the caller
		 * should queue a write: an edit queues one only when fewer than two
		 * are running or waiting for that file, since the waiting one saves
		 * whatever the cache holds when it runs. Refused, changing nothing,
		 * while Epicenter asks to leave, while closing, and while a rename or
		 * delete of the file runs.
		 */
		edit(stem: string, change: (row: Row<TodoFields>) => Row<TodoFields>) {
			if (refused() !== undefined || moving(rowPath(table.name, stem)))
				return false;
			const changed = mapRow(stem, (stored) => ({
				...stored,
				row: change(stored.row),
			}));
			if (!changed) return false;
			rowWrites.unsaved.add(stem);
			return (
				queryClient.isMutating({
					mutationKey: todosKeys.write(stem),
					exact: true,
				}) < 2
			);
		},
		/** Replace the text of `path` in the cache; answers as `edit` does. */
		editText(path: string, text: string) {
			if (refused() !== undefined || moving(path)) return false;
			const changed = mapText(path, (file) => ({ ...file, text }));
			if (!changed) return false;
			textWrites.unsaved.add(path);
			return (
				queryClient.isMutating({
					mutationKey: todosKeys.writeText(path),
					exact: true,
				}) < 2
			);
		},
		/**
		 * The write of one todo. Each view that edits it creates its own
		 * mutation from these options. It saves the row the cache holds when
		 * it runs, guarded by the hash the cache last confirmed.
		 */
		rowWrite(stem: string) {
			const path = rowPath(table.name, stem);
			return resultMutationOptions({
				mutationKey: todosKeys.write(stem),
				...LOCAL,
				scope: { id: stem },
				mutationFn: async (): Promise<
					Result<
						StoredRow<TodoFields> | undefined,
						| Extract<TableError, { name: 'Conflict' | 'InvalidValues' }>
						| FileError
					>
				> => {
					// A write that finds nothing new, as after a rollback, saves nothing.
					if (!rowWrites.unsaved.delete(stem)) return Ok(undefined);
					const stored = rowOf(stem);
					if (stored === undefined) return Ok(undefined);
					return table.replace(stored, stored.row);
				},
				onSuccess: (saved) => {
					if (saved === undefined) return;
					rowWrites.saved(stem);
					// TanStack awaits this before the next write in the scope runs.
					mapRow(stem, (stored) => ({
						...stored,
						path: saved.path,
						sha256: saved.sha256,
					}));
					// The same file's text, if a view read it, is read again.
					void invalidate(todosKeys.text(path));
				},
				onError: async (error) => {
					const lost = rowOf(stem);
					await rollBack(rowWrites, stem, todosKeys.rows);
					onWriteFailed({
						path,
						error,
						lost: lost === undefined ? '' : rowText(lost.row),
					});
				},
			});
		},
		/** The write of one file's text, as `rowWrite` is for a todo. */
		textWrite(path: string) {
			return resultMutationOptions({
				mutationKey: todosKeys.writeText(path),
				...LOCAL,
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<FileCapture | undefined, FileError>
				> => {
					if (!textWrites.unsaved.delete(path)) return Ok(undefined);
					const opened = textData(path);
					if (opened?.kind !== 'text') return Ok(undefined);
					return folder.files.replace(opened.file, opened.file.text);
				},
				onSuccess: (saved) => {
					if (saved === undefined) return;
					textWrites.saved(path);
					mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
					// A row file's text decides whether it reads as a todo.
					if (rowStemOf(table.name, path) !== undefined)
						void invalidate(todosKeys.rows);
				},
				onError: async (error) => {
					const lost = textData(path);
					await rollBack(textWrites, path, todosKeys.text(path));
					onWriteFailed({
						path,
						error,
						lost: lost?.kind === 'text' ? lost.file.text : '',
					});
				},
			});
		},

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		/** Add a todo and show it. */
		create: defineMutation({
			mutationKey: ['todos', 'create'],
			...LOCAL,
			mutationFn: async (
				title: string,
			): Promise<
				Result<StoredRow<TodoFields>, TableCreateError | TodosError>
			> => {
				const why = refused();
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				return table.create(
					{ fields: { title, done: false }, body: '' },
					{ stem: crypto.randomUUID() },
				);
			},
			onSuccess: (created, title) => {
				const stem = rowStemOf(table.name, created.path);
				if (stem !== undefined)
					queryClient.setQueryData<TodoListing>(
						todosKeys.rows,
						(entries) => entries && [...entries, { stem, result: Ok(created) }],
					);
				if (newTitle.trim() === title) newTitle = '';
				selected = { path: created.path, as: 'todos' };
			},
			onSettled: () =>
				Promise.all([invalidate(todosKeys.rows), invalidate(todosKeys.files)]),
		}),
		/** A new empty text file, shown; it never replaces an existing one. */
		createFile: defineMutation({
			mutationKey: ['todos', 'create-file'],
			...LOCAL,
			mutationFn: async ({
				directory,
				name,
			}: {
				directory: string;
				name: string;
			}): Promise<Result<FileCapture, FileError | TodosError>> => {
				const why = refused() ?? nameProblem(directory, name);
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				return folder.files.create(joinPath(directory, name), '');
			},
			onSuccess: (created) => {
				selected = { path: created.path, as: 'files' };
				for (const ancestor of ancestorsOf(created.path))
					expanded.add(ancestor);
			},
			onSettled: () =>
				Promise.all([invalidate(todosKeys.rows), invalidate(todosKeys.files)]),
		}),
		createFolder: defineMutation({
			mutationKey: ['todos', 'create-folder'],
			...LOCAL,
			mutationFn: async ({
				directory,
				name,
			}: {
				directory: string;
				name: string;
			}): Promise<Result<undefined, FileError | TodosError>> => {
				const why = refused() ?? nameProblem(directory, name);
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				const path = joinPath(directory, name);
				const listing = queryClient.getQueryData<FileListing>(todosKeys.files);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return TodosError.NotStarted({
						reason: `"${name}" already exists here.`,
					});
				return folder.files.mkdir(path);
			},
			onSuccess: (_, { directory }) => {
				if (directory !== '') expanded.add(directory);
			},
			onSettled: () => invalidate(todosKeys.files),
		}),
		/**
		 * Rename a file within its folder. A todo row renames through its
		 * table; any other file moves as exact bytes. It runs after the
		 * file's queued writes and moves what the last one confirmed. No
		 * other file moves with it, and edits of the file wait meanwhile.
		 */
		async rename(
			path: string,
			name: string,
		): Promise<
			Result<
				FileCapture | undefined,
				FileError | MoveError | TableError | TodosError
			>
		> {
			const directory = dirname(path);
			const to = joinPath(directory, name);
			const problem = nameProblem(directory, name);
			if (problem !== undefined)
				return TodosError.NotStarted({ reason: problem });
			if (to === path) return Ok(undefined);
			const nextStem = rowStemOf(table.name, to);
			if (rowStemOf(table.name, path) !== undefined && nextStem === undefined)
				return TodosError.NotStarted({
					reason: 'A todo file keeps its .md extension.',
				});
			return defineMutation({
				mutationKey: todosKeys.move(path),
				...LOCAL,
				scope: { id: scopeOf(path) },
				mutationFn: async (): Promise<
					Result<FileCapture, FileError | MoveError | TableError | TodosError>
				> => {
					const why = refused();
					if (why !== undefined) return TodosError.NotStarted({ reason: why });
					let capture = heldCapture(path);
					if (capture === undefined) {
						const { data, error } = await captureNow(path);
						if (error !== null) return Err(error);
						capture = data;
					}
					return nextStem !== undefined &&
						rowStemOf(table.name, path) !== undefined
						? table.rename(capture, nextStem)
						: folder.files.move(capture, to);
				},
				onSuccess: () => moved(path, to),
				onSettled: () =>
					Promise.all([
						invalidate(todosKeys.rows),
						invalidate(todosKeys.files),
					]),
			})();
		},
		/**
		 * What deleting `path` would remove, for the person to confirm, and
		 * whether its latest changes are in no saved version. Only empty
		 * folders can be deleted.
		 */
		async deletionFor(
			path: string,
		): Promise<Result<Deletion, FileError | TodosError>> {
			const why = refused();
			if (why !== undefined) return TodosError.NotStarted({ reason: why });
			const listing = queryClient.getQueryData<FileListing>(todosKeys.files);
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return TodosError.NotStarted({
						reason:
							'Only empty folders can be deleted here. Delete or move what is inside first.',
					});
				return Ok({ kind: 'folder', path });
			}
			const { data: capture, error } = await captureNow(path);
			if (error !== null) return Err(error);
			const status = await queryClient.fetchQuery(statusQuery()).then(
				(observed) => observed,
				() => undefined,
			);
			const unversioned = status?.changes.some(
				(change) => change.path === path,
			);
			const stem = rowStemOf(table.name, path);
			const title =
				stem === undefined ? undefined : rowOf(stem)?.row.fields.title;
			return Ok({
				kind: stem === undefined || title === undefined ? 'file' : 'todo',
				path,
				title: title?.trim() ? title : basename(path),
				capture,
				unversioned,
			});
		},
		/**
		 * Delete what was confirmed. It runs after the file's queued writes,
		 * so it removes what this app saved last; a file another program
		 * changed since is refused.
		 */
		remove(deletion: Deletion) {
			return defineMutation({
				mutationKey: todosKeys.remove(deletion.path),
				...LOCAL,
				scope: { id: scopeOf(deletion.path) },
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | TodosError>
				> => {
					const why = refused();
					if (why !== undefined) return TodosError.NotStarted({ reason: why });
					if (deletion.kind === 'folder')
						return folder.files.rmdir(deletion.path);
					const capture = heldCapture(deletion.path) ?? deletion.capture;
					return rowStemOf(table.name, deletion.path) !== undefined
						? table.delete(capture)
						: folder.files.remove(capture);
				},
				onSuccess: () => deleted(deletion.path),
				onSettled: () =>
					Promise.all([
						invalidate(todosKeys.rows),
						invalidate(todosKeys.files),
					]),
			})();
		},
		/**
		 * Record a version: commit the saved files (ADR-0529). Writes still
		 * running land first. Never pushes.
		 */
		saveVersion: defineMutation({
			mutationKey: ['todos', 'save-version'],
			...LOCAL,
			mutationFn: async (): Promise<Result<CommitOutcome, TodosError>> => {
				const why = refused();
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				await writesSettled();
				return Ok(await folder.git.commit());
			},
			onSettled: () => invalidate(todosKeys.status),
		}),
		/**
		 * Commit the saved files, fetch, merge, and push. Conflicts are
		 * `NeedsChoices`, whose attempt the review answers with `apply`.
		 */
		sync: defineMutation({
			mutationKey: ['todos', 'sync'],
			...LOCAL,
			mutationFn: async (): Promise<Result<SyncOutcome, SyncError>> => {
				const why = refused();
				if (why !== undefined) return SyncError.Failed({ cause: why });
				await writesSettled();
				return folder.sync.run();
			},
			onSettled: () => invalidate(),
		}),
		/** Answer a sync's review. Refused choices are `InvalidChoices` and keep the attempt. */
		apply: defineMutation({
			mutationKey: ['todos', 'apply'],
			...LOCAL,
			mutationFn: async ({
				attempt,
				choices,
			}: {
				attempt: SyncAttempt;
				choices: SyncChoices;
			}): Promise<Result<SyncOutcome, SyncError>> => {
				const why = refused();
				if (why !== undefined) return SyncError.Failed({ cause: why });
				await writesSettled();
				return folder.sync.resolve(attempt, choices);
			},
			onSettled: () => invalidate(),
		}),
		/**
		 * Recover the incoming update in `git.pendingIncoming`, only because
		 * the person asked. Writes still running land first; afterward every
		 * listing and open file is read again.
		 */
		recoverIncoming: defineMutation({
			mutationKey: ['todos', 'recover-incoming'],
			...LOCAL,
			mutationFn: async (): Promise<
				Result<RecoverOutcome, PullError | GitError | TodosError>
			> => {
				const why = refused();
				if (why !== undefined) return TodosError.NotStarted({ reason: why });
				await writesSettled();
				return folder.git.recoverIncoming();
			},
			onSettled: () => invalidate(),
		}),

		// ------------------------------------------------------------------
		// Input not yet committed, leaving, and closing
		// ------------------------------------------------------------------

		get newTitle() {
			return newTitle;
		},
		set newTitle(title: string) {
			if (refused() !== undefined) return;
			newTitle = title;
		},
		/**
		 * The page's part in leaving Epicenter
		 * (`@epicenter/epicenter/departure/page`). `fence` runs before anything
		 * is awaited; `settle` waits until nothing is mutating and answers how
		 * many things would be lost: a typed title not added. `resume` gives
		 * everything back.
		 */
		departure: {
			/**
			 * Whether leaving now could lose anything: a write or another
			 * action still running, or a new todo's title typed and not added.
			 */
			get holdsUnsaved() {
				return queryClient.isMutating() > 0 || newTitle.trim() !== '';
			},
			fence() {
				departing = true;
			},
			async settle(): Promise<number> {
				await whenIdle(queryClient);
				return newTitle.trim() === '' ? 0 : 1;
			},
			resume() {
				departing = false;
			},
		} satisfies DepartureParticipant,
		/**
		 * Fence new input, wait until nothing is mutating, then release the
		 * folder. Every call answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			closing = (async () => {
				await whenIdle(queryClient);
				await queryClient.cancelQueries({ queryKey: todosKeys.all });
				await folder.close();
			})();
			return closing;
		},
	};
}
