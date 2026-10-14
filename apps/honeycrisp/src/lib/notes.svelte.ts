/**
 * The Honeycrisp product state over one opened notes folder, kept in a
 * TanStack Query cache (ADR-0528).
 *
 * Reads are queries: the note rows, the folder rows, the file listing the
 * file browser shows, the text of each file opened as text, and Git status.
 * They are read when the page opens, when the window regains focus, and
 * after the app's own actions and terminal commands. Nothing follows the
 * folder's change reports.
 *
 * An edit goes straight into the cache: one immutable `map` over a table's
 * listing changes one row, and one replacement changes a file's text. The
 * title, folder, pin, rich text, and Source of an open note, a list action
 * on any note, and a folder's name are all such edits. Each is written by a
 * mutation keyed and scoped by its file's path, so writes to one file run
 * one at a time while writes to different files run side by side. A write
 * reads the cache when it runs, so it saves the newest row, guarded by the
 * newest confirmed `sha256`; a file has at most one write running and one
 * waiting. A write that succeeds moves the guard forward and keeps what was
 * typed meanwhile. A write that fails reads that one file again, which rolls
 * the edit back, and reports what was lost.
 *
 * No read starts while a write runs: an edit cancels reads in flight,
 * nothing goes stale on its own, focus does not read while writing, and
 * everything is read again once the last write settles.
 *
 * Every other action is a mutation too: create, rename, delete, deleting a
 * folder, Save version, and terminal commands. Closing fences new input,
 * then waits until nothing is mutating; nothing is ever discarded. Saves
 * never commit (ADR-0529); a version is recorded only by Save version.
 */
import {
	type CommitOutcome,
	type FileCapture,
	type FileError,
	type FileListing,
	type FilesObservation,
	type FileTable,
	formatRow,
	type GitError,
	type MoveError,
	parseRow,
	type Row,
	type RowReadError,
	rowPath,
	rowStemOf,
	type StoredRow,
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
	MutationOptions,
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
import {
	type FolderEntry,
	type FolderFields,
	honeycrispDefinition,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
	instantNow as now,
} from './data.js';
import type { NoteBody } from './editor/rich-text.js';
import { nameProblem, readTextFile } from './files.js';
import { displayTitle } from './note-source.js';
import type { NotesHost, NotesTerminal } from './platform/types.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Notes = ReturnType<typeof createNotes>;

/** How a path opens: as the note it is, or as its exact text. */
export type OpenAs = 'note' | 'text';

/**
 * What the detail shows. `id` names one opening: a rename keeps it, so the
 * view, and the rich-text editor's undo history, stay.
 */
export type Selection = {
	readonly path: string;
	readonly as: OpenAs;
	readonly id: number;
};

/** The two row tables, by directory. */
type TableName = 'notes' | 'folders';
const FOLDERS = 'folders';

/** Every note row file, as the table lists it: a row, or why it is not one. */
export type NoteListing = TableListing<NoteFields>;
/** Every folder row file, as the table lists it. */
export type FolderListing = TableListing<FolderFields>;

/** A listed file the lists cannot show as a row, and why. */
export type Problem = { readonly path: string; readonly message: string };

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion =
	| { readonly kind: 'folder'; readonly path: string }
	| {
			readonly kind: 'file';
			readonly path: string;
			/** The note's name, when the file is a note that reads as one. */
			readonly title: string | undefined;
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

/** Why an action did not start, or stopped before it changed anything. */
export const NotesError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type NotesError = InferErrors<typeof NotesError>;

const CLOSING = 'The app is closing, so nothing was changed.';
const BUSY =
	'This file is being renamed or deleted. Try again when it finishes.';
const OPEN_AS_TEXT =
	'This file is open as text. Change it there, or open it as a note.';
const NOT_LISTED =
	'This file is not in the list as last read. Check again and retry.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** Cache identity for every query and mutation the app runs. */
export const notesKeys = defineKeys({
	/** Every query the app keeps; read again after actions and terminal commands. */
	all: ['honeycrisp'],
	rows: (table: TableName) => ['honeycrisp', 'rows', table] as const,
	files: ['honeycrisp', 'files'],
	status: ['honeycrisp', 'status'],
	text: (path: string) => ['honeycrisp', 'text', path] as const,
	/** Every write of a row or a file's text. */
	writes: ['honeycrisp', 'write'],
	write: (path: string) => ['honeycrisp', 'write', 'row', path] as const,
	writeText: (path: string) => ['honeycrisp', 'write', 'text', path] as const,
	move: (path: string) => ['honeycrisp', 'move', path] as const,
	remove: (path: string) => ['honeycrisp', 'remove', path] as const,
	saveVersion: ['honeycrisp', 'save-version'],
});

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error: FileError | MoveError | TableError | NotesError | GitError,
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
		case 'NotFound':
			return 'This file is no longer in the folder.';
		default:
			return error.message;
	}
}

/** Why a listed row file cannot be shown as a row. */
function problemOf(path: string, error: RowReadError): Problem {
	if (error.name === 'InvalidRow')
		return {
			path,
			message: error.issues.map((issue) => issue.message).join(' '),
		};
	if (error.name === 'InvalidUtf8')
		return {
			path,
			message: 'It is not UTF-8 text, so it cannot be opened here.',
		};
	return { path, message: error.message };
}

/** The rows of a listing that read, each with its stem. */
function rowsOf<TFields>(
	listing: TableListing<TFields>,
): (StoredRow<TFields> & { readonly stem: string })[] {
	const rows: (StoredRow<TFields> & { readonly stem: string })[] = [];
	for (const { stem, result } of listing)
		if (result.error === null) rows.push({ ...result.data, stem });
	return rows;
}

/** The note rows that read as notes. */
export const notesOf = (listing: NoteListing): NoteEntry[] => rowsOf(listing);
/** The folder rows that read as folders. */
export const foldersOf = (listing: FolderListing): FolderEntry[] =>
	rowsOf(listing);

/** Note files whose text does not read as a note: each opens as text for repair. */
export function repairsOf(listing: NoteListing): Problem[] {
	const repairs: Problem[] = [];
	for (const { stem, result } of listing)
		if (result.error?.name === 'InvalidRow')
			repairs.push(problemOf(rowPath(NOTES, stem), result.error));
	return repairs;
}

/** Note files that are not text, and folder files that do not read as folders. */
export function unreadableOf(
	notes: NoteListing | undefined,
	folders: FolderListing | undefined,
): Problem[] {
	const unreadable: Problem[] = [];
	for (const { stem, result } of notes ?? [])
		if (result.error !== null && result.error.name !== 'InvalidRow')
			unreadable.push(problemOf(rowPath(NOTES, stem), result.error));
	for (const { stem, result } of folders ?? [])
		if (result.error !== null)
			unreadable.push(problemOf(rowPath(FOLDERS, stem), result.error));
	return unreadable;
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

export function createNotes(
	host: NotesHost,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
	}: {
		/** A write failed and was rolled back; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
	} = {},
) {
	const { folder } = host;
	const { defineMutation } = createQueryFactories(queryClient);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe(update),
	);

	/** Which notes the list shows; input not yet committed, like a search. */
	let view = $state<{
		folderId: string | null;
		deleted: boolean;
		query: string;
	}>({ folderId: null, deleted: false, query: '' });
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([NOTES]);
	/** What the detail shows. */
	let selected = $state.raw<Selection | undefined>();
	let openings = 0;
	/** Bumped when a note is opened, so its editor takes focus. */
	let focusRequest = $state(0);
	/** Set while a close is answered: no edit and no action starts. */
	let fenced = $state(false);
	/** Set once `close` begins. Nothing starts after it, and the fence stays. */
	let closing: Promise<void> | undefined;
	/** Set once the folder is being released: nothing reads it after. */
	let released = false;

	/** Why no edit or action starts now, if one does not. */
	const refused = () => (fenced || closing !== undefined ? CLOSING : undefined);

	// Every read and write is local: nothing waits for a network, and nothing retries.
	queryClient.setQueryDefaults(notesKeys.all, {
		networkMode: 'always',
		retry: false,
		// Nothing goes stale on its own: a view that mounts shows what the cache
		// holds, and reads happen only when asked for, never while a write runs.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: () => (released || writing() ? false : 'always'),
	});
	queryClient.setMutationDefaults(notesKeys.all, {
		networkMode: 'always',
		retry: false,
	});

	/** Whether a write of a row or a file's text is running or waiting. */
	const writing = () =>
		queryClient.isMutating({ mutationKey: notesKeys.writes }) > 0;

	/** Resolves once no write of a row or a file's text is running or waiting. */
	const writesSettled = () =>
		whenIdle(queryClient, { mutationKey: notesKeys.writes });

	/** How many writes of `path` are running or waiting. */
	const writesOf = (path: string) =>
		queryClient.isMutating({
			mutationKey: notesKeys.write(path),
			exact: true,
		}) +
		queryClient.isMutating({
			mutationKey: notesKeys.writeText(path),
			exact: true,
		});

	/** Whether a rename or delete of `path` is running or waiting, which pauses its edits. */
	const moving = (path: string) =>
		queryClient.isMutating({ mutationKey: notesKeys.move(path), exact: true }) +
			queryClient.isMutating({
				mutationKey: notesKeys.remove(path),
				exact: true,
			}) >
		0;

	/** Whether `path` is open as its exact text, so its text is what saves. */
	const asText = (path: string) =>
		selected?.path === path && selected.as === 'text';

	/** Start one write from `options`; its outcome arrives through the options' callbacks. */
	function run<TData, TError>(
		options: MutationOptions<TData, TError, void, unknown>,
	) {
		void queryClient
			.getMutationCache()
			.build(queryClient, options)
			.execute(undefined)
			.catch(() => {});
	}

	/**
	 * Read again what an action may have changed. While a write runs nothing
	 * is read: the last write to settle reads everything again.
	 */
	const invalidate = (queryKey: readonly unknown[] = notesKeys.all) =>
		writing() || released
			? Promise.resolve()
			: queryClient.invalidateQueries({ queryKey });

	/**
	 * After a write settles: once it is the last one, everything is read
	 * again. The write does not wait for that read; a text read waits for the
	 * file's row write, so waiting here would wait on itself.
	 */
	const afterWrite = () => {
		// The write settling still counts as running here.
		if (
			queryClient.isMutating({ mutationKey: notesKeys.writes }) <= 1 &&
			!released
		)
			void queryClient.invalidateQueries({ queryKey: notesKeys.all });
	};

	/**
	 * One table's rows in the cache: reading them, editing one with an
	 * immutable `map`, writing it, and taking it back from its file after a
	 * failed write.
	 */
	function rowCache<TFields>(name: TableName, table: FileTable<TFields>) {
		const key = notesKeys.rows(name);
		const declared = honeycrispDefinition.tables[name];
		const data = () => queryClient.getQueryData<TableListing<TFields>>(key);

		/** The row the cache holds for `stem`, if it reads as one. */
		function rowOf(stem: string): StoredRow<TFields> | undefined {
			const result = data()?.find((entry) => entry.stem === stem)?.result;
			return result?.error === null ? result.data : undefined;
		}

		/** Change the row at `stem` in the cache. Answers whether a row was there. */
		function map(
			stem: string,
			change: (stored: StoredRow<TFields>) => StoredRow<TFields>,
		): boolean {
			let found = false;
			queryClient.setQueryData<TableListing<TFields>>(key, (entries) =>
				entries?.map((entry) => {
					if (entry.stem !== stem || entry.result.error !== null) return entry;
					found = true;
					return { ...entry, result: Ok(change(entry.result.data)) };
				}),
			);
			return found;
		}

		/**
		 * After a failed write, the cache takes the row as the file holds it
		 * now. TanStack awaits this before the next write of the file runs, so
		 * that write saves the file's own bytes instead of the failed edit.
		 */
		async function reload(stem: string) {
			await queryClient.cancelQueries({ queryKey: key, exact: true });
			const { data: stored, error } = await table.get(stem);
			queryClient.setQueryData<TableListing<TFields>>(key, (entries) =>
				entries?.flatMap((entry) => {
					if (entry.stem !== stem) return [entry];
					if (error !== null) return [{ stem, result: Err(error) }];
					return stored === undefined ? [] : [{ stem, result: Ok(stored) }];
				}),
			);
		}

		/** The text a person loses with a row that could not be written. */
		function rowText(row: Row<TFields>) {
			return formatRow(declared, row).data ?? (row as Row<unknown>).body;
		}

		/**
		 * The write of one row. It saves the row the cache holds when it
		 * runs, guarded by the hash the cache last confirmed.
		 */
		function write(stem: string) {
			const path = rowPath(name, stem);
			return resultMutationOptions({
				mutationKey: notesKeys.write(path),
				// Row and text writes, renames, and deletes of one file share its queue.
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<StoredRow<TFields> | undefined, TableError | FileError>
				> => {
					const stored = rowOf(stem);
					if (stored === undefined) return Ok(undefined);
					return table.replace(stored, stored.row);
				},
				onSuccess: (saved) => {
					if (saved === undefined) return;
					// TanStack awaits this before the next write in the scope runs.
					map(stem, (stored) => ({
						...stored,
						path: saved.path,
						sha256: saved.sha256,
					}));
					// The same file's text, if a view read it, is read again.
					void invalidate(notesKeys.text(path));
				},
				onError: async (error) => {
					const lost = rowOf(stem);
					await reload(stem);
					onWriteFailed({
						path,
						error,
						lost: lost === undefined ? '' : rowText(lost.row),
					});
				},
				onSettled: afterWrite,
			});
		}

		/**
		 * Change the row at `stem` in the cache, and queue its write when one
		 * is needed: only when fewer than two are running or waiting for the
		 * file, since the waiting one saves whatever the cache holds when it
		 * runs. Answers why the change was refused, changing nothing: while a
		 * close is answered, while a rename or delete of the file runs, and
		 * while the file is open as text.
		 */
		function edit(
			stem: string,
			change: (row: Row<TFields>) => Row<TFields>,
		): string | undefined {
			const path = rowPath(name, stem);
			const why = refused();
			if (why !== undefined) return why;
			if (moving(path)) return BUSY;
			if (asText(path)) return OPEN_AS_TEXT;
			if (rowOf(stem) === undefined) return NOT_LISTED;
			// A read still running could replace this edit when it lands.
			void queryClient.cancelQueries({ queryKey: key, exact: true });
			let changed = false;
			map(stem, (stored) => {
				const row = change(stored.row);
				if (row === stored.row) return stored;
				changed = true;
				return { ...stored, row };
			});
			if (changed && writesOf(path) < 2) run(write(stem));
			return undefined;
		}

		return {
			name,
			table,
			key,
			data,
			rowOf,
			reload,
			edit,
			/** The listing, narrowed by `select` for one view. */
			query<TData = TableListing<TFields>>(
				select?: (listing: TableListing<TFields>) => TData,
			) {
				return resultQueryOptions({
					queryKey: key,
					queryFn: () => table.list(),
					select,
				});
			},
			/** The capture the cache holds for `stem`: a row's, or a row that does not read's own bytes. */
			capture(stem: string): FileCapture | undefined {
				const result = data()?.find((entry) => entry.stem === stem)?.result;
				if (result?.error === null) return result.data;
				if (result?.error.name === 'InvalidRow') return result.error;
				return undefined;
			},
			/** After a rename: the row follows its file, or leaves the table. */
			moved(stem: string, nextStem: string | undefined, to: string) {
				queryClient.setQueryData<TableListing<TFields>>(key, (entries) =>
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
			},
			/** After a delete: the row leaves the table. */
			deleted(stem: string) {
				queryClient.setQueryData<TableListing<TFields>>(key, (entries) =>
					entries?.filter((entry) => entry.stem !== stem),
				);
			},
			/** After a create: the new row joins the table. */
			created(stem: string, stored: StoredRow<TFields>) {
				queryClient.setQueryData<TableListing<TFields>>(
					key,
					(entries) => entries && [...entries, { stem, result: Ok(stored) }],
				);
			},
		};
	}

	const noteRows = rowCache('notes', folder.tables.notes);
	const folderRows = rowCache('folders', folder.tables.folders);

	/** The row table `path` is in, and its stem, if it is a row file. */
	function rowAt(path: string) {
		const noteStem = rowStemOf(NOTES, path);
		if (noteStem !== undefined) return { rows: noteRows, stem: noteStem };
		const folderStem = rowStemOf(FOLDERS, path);
		if (folderStem !== undefined) return { rows: folderRows, stem: folderStem };
		return undefined;
	}

	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(notesKeys.text(path));

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
		queryClient.setQueryData<OpenedFile>(notesKeys.text(path), (opened) => {
			if (opened?.kind !== 'text') return opened;
			changed = true;
			return { kind: 'text', file: change(opened.file) };
		});
		return changed;
	}

	/** After a failed write of a file's text, the cache takes the file as it is now. */
	async function reloadText(path: string) {
		const key = notesKeys.text(path);
		await queryClient.cancelQueries({ queryKey: key, exact: true });
		const read = await readTextFile(folder.files, path);
		if (read.error === null) queryClient.setQueryData(key, read.data);
		else await queryClient.invalidateQueries({ queryKey: key, exact: true });
	}

	/** The write of one file's text, as a row table's `write` is for a row. */
	function textWrite(path: string) {
		return resultMutationOptions({
			mutationKey: notesKeys.writeText(path),
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<FileCapture | undefined, FileError>
			> => {
				const opened = textData(path);
				if (opened?.kind !== 'text') return Ok(undefined);
				return folder.files.replace(opened.file, opened.file.text);
			},
			onSuccess: (saved) => {
				if (saved === undefined) return;
				mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
				// A row file's text decides whether it reads as a row.
				const at = rowAt(path);
				if (at !== undefined) void invalidate(at.rows.key);
			},
			onError: async (error) => {
				const lost = textData(path);
				await reloadText(path);
				onWriteFailed({
					path,
					error,
					lost: lost?.kind === 'text' ? lost.file.text : '',
				});
			},
			onSettled: afterWrite,
		});
	}

	/** Change the note at `path` in the cache, which writes it; answers why not, if not. */
	function editNote(
		path: string,
		change: (row: Row<NoteFields>) => Row<NoteFields>,
	): string | undefined {
		const stem = noteIdOf(path);
		if (stem === undefined) return NOT_LISTED;
		return noteRows.edit(stem, change);
	}

	/** Change some fields of a note from a list: pin, move to a folder, trash, restore. */
	function patchNote(path: string, fields: Partial<NoteFields>) {
		return editNote(path, (row) => ({
			...row,
			fields: { ...row.fields, ...fields },
		}));
	}

	/** Whether edits to `path` are refused now: closing, or a rename or delete runs. */
	const lockedAt = (path: string) =>
		fenced || closing !== undefined || moving(path);

	/** The same file as captured now, for a file no view holds. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/**
	 * The capture a rename or delete of `path` acts on, read when it runs: the
	 * newest hash the cache confirmed for what the app edits, if it holds one.
	 */
	function heldCapture(path: string): FileCapture | undefined {
		const at = rowAt(path);
		if (at !== undefined && !asText(path)) {
			const capture = at.rows.capture(at.stem);
			if (capture !== undefined) return capture;
		}
		const opened = textData(path);
		return opened?.kind === 'text' ? opened.file : undefined;
	}

	/** After a rename: the caches and the open item follow the file. */
	function moved(from: string, to: string) {
		const at = rowAt(from);
		if (at !== undefined)
			at.rows.moved(at.stem, rowStemOf(at.rows.name, to), to);
		queryClient.removeQueries({ queryKey: notesKeys.text(from), exact: true });
		if (selected?.path === from) selected = { ...selected, path: to };
	}

	/** After a delete: the caches and the open item let the file go. */
	function deleted(path: string) {
		const at = rowAt(path);
		if (at !== undefined) at.rows.deleted(at.stem);
		queryClient.removeQueries({ queryKey: notesKeys.text(path), exact: true });
		if (selected?.path === path) selected = undefined;
	}

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		const stem = noteIdOf(path);
		if (stem === undefined) return 'text';
		const result = noteRows
			.data()
			?.find((entry) => entry.stem === stem)?.result;
		return result === undefined || result.error === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. Opening never waits, writes, or asks. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as, id: ++openings };
		// Text read on an earlier opening is read again: no view watched it since.
		if (as === 'text') void invalidate(notesKeys.text(path));
	}

	/** The file listing the file browser shows. */
	function filesQuery() {
		return resultQueryOptions({
			queryKey: notesKeys.files,
			queryFn: () => folder.files.list(),
		});
	}

	/** Git status: changes since the last version. */
	function statusQuery() {
		return resultQueryOptions({
			queryKey: notesKeys.status,
			queryFn: (): Promise<Result<FilesObservation, GitError>> =>
				folder.git.status(),
		});
	}

	/** What a person reads about an action's outcome: nothing, or why it failed. */
	function problem(
		result: Result<unknown, Parameters<typeof describeError>[0]>,
	) {
		return result.error === null ? undefined : describeError(result.error);
	}

	/** A terminal command may write anything, so it is a mutation, and everything is read again after it. */
	const runCommand = defineMutation({
		mutationKey: ['honeycrisp', 'terminal'],
		mutationFn: async ({
			shell,
			command,
		}: {
			shell: NotesTerminal;
			command: string;
		}) => Ok(await shell.exec(command)),
		onSettled: () => invalidate(),
	});
	const shell = host.terminal;
	const terminal =
		shell === undefined
			? undefined
			: createTerminalSession(
					{
						get cwd() {
							return shell.cwd;
						},
						description: shell.description,
						async exec(command) {
							// A command that throws is shown in the terminal's output.
							const ran = await runCommand({ shell, command });
							if (ran.data === null) throw ran.error;
							return ran.data;
						},
					},
					() => refused() === undefined,
				);

	const createNote = defineMutation({
		mutationKey: ['honeycrisp', 'create-note'],
		mutationFn: async (): Promise<
			Result<StoredRow<NoteFields>, TableCreateError | NotesError>
		> => {
			const why = refused();
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			const at = now();
			return folder.tables.notes.create(
				{
					fields: {
						folderId: view.deleted ? null : view.folderId,
						title: '',
						pinned: false,
						createdAt: at,
						updatedAt: at,
						deletedAt: null,
					},
					body: '',
				},
				{ stem: newId() },
			);
		},
		onSuccess: (created) => {
			const stem = noteIdOf(created.path);
			if (stem !== undefined) noteRows.created(stem, created);
			open(created.path, 'note');
		},
		onSettled: () =>
			Promise.all([invalidate(noteRows.key), invalidate(notesKeys.files)]),
	});

	const createFolder = defineMutation({
		mutationKey: ['honeycrisp', 'create-folder'],
		mutationFn: async (
			name: string,
		): Promise<
			Result<StoredRow<FolderFields>, TableCreateError | NotesError>
		> => {
			const why = refused();
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			return folder.tables.folders.create(
				{ fields: { name, icon: null }, body: '' },
				{ stem: newId() },
			);
		},
		onSuccess: (created) => {
			const stem = rowStemOf(FOLDERS, created.path);
			if (stem !== undefined) folderRows.created(stem, created);
		},
		onSettled: () =>
			Promise.all([invalidate(folderRows.key), invalidate(notesKeys.files)]),
	});

	const createFile = defineMutation({
		mutationKey: ['honeycrisp', 'create-file'],
		mutationFn: async ({
			directory,
			name,
		}: {
			directory: string;
			name: string;
		}): Promise<Result<FileCapture, FileError | NotesError>> => {
			const why = refused() ?? nameProblem(directory, name);
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			return folder.files.create(joinPath(directory, name), '');
		},
		onSuccess: (created) => open(created.path, 'text'),
		onSettled: () => invalidate(),
	});

	const createDirectory = defineMutation({
		mutationKey: ['honeycrisp', 'create-directory'],
		mutationFn: async ({
			directory,
			name,
		}: {
			directory: string;
			name: string;
		}): Promise<Result<undefined, FileError | NotesError>> => {
			const why = refused() ?? nameProblem(directory, name);
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			const path = joinPath(directory, name);
			const listing = queryClient.getQueryData<FileListing>(notesKeys.files);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return NotesError.NotStarted({
					reason: `"${name}" already exists here.`,
				});
			return folder.files.mkdir(path);
		},
		onSuccess: (_, { directory }) => {
			if (directory !== '') expanded.add(directory);
		},
		onSettled: () => invalidate(notesKeys.files),
	});

	/**
	 * Delete a folder after moving its notes out. Refused while any note
	 * cannot say which folder it is in. Each note moves out by an edit, like
	 * any list action; once every write settled, the notes are read again,
	 * and the folder's file goes only when none is still in it. Not one
	 * atomic step: a note already moved out stays moved out if the delete
	 * stops, and another program can still put a note in the folder after
	 * the last read.
	 */
	function deleteFolder(entry: FolderEntry) {
		return defineMutation({
			mutationKey: notesKeys.remove(entry.path),
			mutationFn: async (): Promise<
				Result<undefined, TableError | FileError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				const listing = noteRows.data();
				if (listing === undefined)
					return NotesError.NotStarted({
						reason:
							'The notes could not be listed, so it is not known which are in this folder.',
					});
				const unknown = [...repairsOf(listing), ...unreadableOf(listing, [])];
				if (unknown.length > 0)
					return NotesError.NotStarted({
						reason: `Some notes cannot be read well enough to tell which folder they are in (${unknown
							.slice(0, 3)
							.map((item) => basename(item.path))
							.join(', ')}). Repair or remove them first.`,
					});
				const id = entry.stem;
				for (const note of notesOf(listing)) {
					if (note.row.fields.folderId !== id) continue;
					const refusal = editNote(note.path, (row) => ({
						...row,
						fields: { ...row.fields, folderId: null },
					}));
					if (refusal !== undefined)
						return NotesError.NotStarted({
							reason: `A note could not be moved out of the folder: ${refusal}`,
						});
				}
				await writesSettled();
				const reread = await folder.tables.notes.list();
				if (reread.error !== null) return Err(reread.error);
				const remaining = notesOf(reread.data).filter(
					(note) => note.row.fields.folderId === id,
				);
				if (remaining.length > 0)
					return NotesError.NotStarted({
						reason: `Some notes are still in this folder (${remaining
							.slice(0, 3)
							.map((note) => basename(note.path))
							.join(', ')}), so it was kept. Delete it again to move them out.`,
					});
				return folder.tables.folders.delete(heldCapture(entry.path) ?? entry);
			},
			onSuccess: () => {
				deleted(entry.path);
				if (view.folderId === entry.stem) view = { ...view, folderId: null };
			},
			onSettled: () => invalidate(),
		})();
	}

	/**
	 * Rename a file within its folder. A row renames through its table,
	 * unless it is open as text; any other file moves as exact bytes. It
	 * runs after the file's queued writes and moves what the last one
	 * confirmed. Edits of the file wait meanwhile.
	 */
	function rename(path: string, name: string) {
		const directory = dirname(path);
		const to = joinPath(directory, name);
		return defineMutation({
			mutationKey: notesKeys.move(path),
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<
					FileCapture | undefined,
					FileError | MoveError | NotesError | TableError
				>
			> => {
				const why = refused() ?? nameProblem(directory, name);
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				if (to === path) return Ok(undefined);
				const at = rowAt(path);
				const nextStem =
					at === undefined ? undefined : rowStemOf(at.rows.name, to);
				if (at !== undefined && nextStem === undefined)
					return NotesError.NotStarted({
						reason: `A ${at.rows.name === NOTES ? 'note' : 'folder'} file keeps its .md extension.`,
					});
				let capture = heldCapture(path);
				if (capture === undefined) {
					const { data, error } = await captureNow(path);
					if (error !== null) return Err(error);
					capture = data;
				}
				// A close that began during the read stops the move.
				const late = refused();
				if (late !== undefined) return NotesError.NotStarted({ reason: late });
				return at !== undefined && nextStem !== undefined && !asText(path)
					? at.rows.table.rename(capture, nextStem)
					: folder.files.move(capture, to);
			},
			onSuccess: (renamed) => {
				if (renamed !== undefined) moved(path, to);
			},
			onSettled: () => invalidate(),
		})();
	}

	/**
	 * Delete what was confirmed. It runs after the file's queued writes, so
	 * it removes what this app saved last; a file another program changed
	 * since is refused.
	 */
	function remove(deletion: Deletion) {
		return defineMutation({
			mutationKey: notesKeys.remove(deletion.path),
			scope: { id: deletion.path },
			mutationFn: async (): Promise<
				Result<undefined, FileError | TableError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				if (deletion.kind === 'folder')
					return folder.files.rmdir(deletion.path);
				const capture = heldCapture(deletion.path) ?? deletion.capture;
				return folder.files.remove(capture);
			},
			onSuccess: () => deleted(deletion.path),
			onSettled: () => invalidate(),
		})();
	}

	return {
		host,
		queryClient,
		terminal,
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The note listing, narrowed by `select` for one view. */
		notesQuery: noteRows.query,
		/** The folder listing, narrowed by `select` for one view. */
		foldersQuery: folderRows.query,
		filesQuery,
		/** One file's complete text, or its type and size when it is not editable text. */
		textQuery(path: string) {
			return resultQueryOptions({
				queryKey: notesKeys.text(path),
				queryFn: async () => {
					// A note opened as its file while its row is still being
					// written is read once that write lands, never under it.
					await whenIdle(queryClient, {
						mutationKey: notesKeys.write(path),
						exact: true,
					});
					return readTextFile(folder.files, path);
				},
			});
		},
		statusQuery,
		/**
		 * Read the listings and Git status when the page opens. A listing that
		 * fails is shown where it is used.
		 */
		async load() {
			await Promise.all([
				queryClient.prefetchQuery(noteRows.query()),
				queryClient.prefetchQuery(folderRows.query()),
				queryClient.prefetchQuery(filesQuery()),
				queryClient.prefetchQuery(statusQuery()),
			]);
		},
		/** Read everything again: the person's "Check again". Nothing is read while a write runs. */
		refresh: () => invalidate(),

		// ------------------------------------------------------------------
		// What the lists and the detail show
		// ------------------------------------------------------------------

		get view() {
			return view;
		},
		showFolder(folderId: string | null) {
			view = { ...view, folderId, deleted: false };
		},
		showDeleted() {
			view = { ...view, folderId: null, deleted: true };
		},
		setQuery(query: string) {
			view = { ...view, query };
		},
		get selected() {
			return selected;
		},
		get focusRequest() {
			return focusRequest;
		},
		open,

		// ------------------------------------------------------------------
		// State read reactively
		// ------------------------------------------------------------------

		/** Whether a write of a row or a file's text is running or waiting. */
		get saving() {
			trackMutations();
			return writing();
		},
		/** Whether anything is mutating: a write, an action, or a terminal command. */
		get busy() {
			trackMutations();
			return queryClient.isMutating() > 0;
		},
		/** How many mutations match `filters`. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a write of `path` is running or waiting. */
		isWriting(path: string) {
			trackMutations();
			return writesOf(path) > 0;
		},
		/** Whether edits of `path` are refused now: closing, or a rename or delete runs. */
		isLocked(path: string) {
			trackMutations();
			return lockedAt(path);
		},
		/** Whether input and actions are held back while a close is answered. */
		get fenced() {
			return fenced;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		/**
		 * Change the note at `path` in the cache, which writes it at once.
		 * Answers why the change was refused, changing nothing, if it was.
		 */
		editNote,
		/**
		 * The note at `path` as the rich-text editor uses it: the row the
		 * cache holds now, read reactively; whether it takes edits; and
		 * `edit`, which answers whether the change was taken.
		 */
		noteBody(path: string): NoteBody {
			return {
				get row() {
					trackQueries();
					const stem = noteIdOf(path);
					return stem === undefined ? undefined : noteRows.rowOf(stem)?.row;
				},
				get locked() {
					trackMutations();
					return lockedAt(path);
				},
				edit: (change) => editNote(path, change) === undefined,
			};
		},
		/** Change some fields of a note from a list: pin, move to a folder, trash, restore. */
		patchNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) => patchNote(path, { deletedAt: now() }),
		restoreNote: (path: string) => patchNote(path, { deletedAt: null }),
		/** Change a folder's fields; answers why not, if not. */
		patchFolder(path: string, fields: Partial<FolderFields>) {
			const stem = rowStemOf(FOLDERS, path);
			if (stem === undefined) return NOT_LISTED;
			return folderRows.edit(stem, (row) => ({
				...row,
				fields: { ...row.fields, ...fields },
			}));
		},
		/**
		 * Replace the text of `path` in the cache, which writes it at once.
		 * Answers whether the change was taken.
		 */
		editText(path: string, text: string): boolean {
			if (refused() !== undefined || moving(path)) return false;
			void queryClient.cancelQueries({
				queryKey: notesKeys.text(path),
				exact: true,
			});
			if (!mapText(path, (file) => ({ ...file, text }))) return false;
			if (writesOf(path) < 2) run(textWrite(path));
			return true;
		},
		/**
		 * Put a committed version of a note in the note: the version's fields
		 * over the note's, and its body. It writes at once, like any edit. A
		 * version that does not read as a note is refused.
		 */
		useVersion(path: string, source: string): string | undefined {
			const { data: version, error } = parseRow(
				honeycrispDefinition.tables.notes,
				source,
			);
			if (error !== null)
				return `This version does not read as a note (${error[0].message}). Use Edit as file to change the text by hand.`;
			return editNote(path, (row) => ({
				fields: { ...row.fields, ...version.fields },
				body: version.body,
			}));
		},

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it. */
		createNote: async () => problem(await createNote()),
		createFolder: async (name: string) => problem(await createFolder(name)),
		/** A new empty text file, opened; it never replaces an existing one. */
		createFile: async (directory: string, name: string) =>
			problem(await createFile({ directory, name })),
		createDirectory: async (directory: string, name: string) =>
			problem(await createDirectory({ directory, name })),
		deleteFolder: async (entry: FolderEntry) =>
			problem(await deleteFolder(entry)),
		rename: async (path: string, name: string) =>
			problem(await rename(path, name)),
		/**
		 * What deleting `path` would remove, for the person to confirm, and
		 * whether its latest changes are in no saved version. Only empty
		 * folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
			const listing = queryClient.getQueryData<FileListing>(notesKeys.files);
			if (listing?.directories.includes(path)) {
				const prefix = `${path}/`;
				const occupied =
					listing.files.some((file) => file.path.startsWith(prefix)) ||
					listing.directories.some((directory) => directory.startsWith(prefix));
				if (occupied)
					return Err(
						'Only empty folders can be deleted here. Delete or move what is inside first.',
					);
				return Ok({ kind: 'folder', path });
			}
			const { data: capture, error } = await captureNow(path);
			if (error !== null) return Err(describeError(error));
			const status = await queryClient.fetchQuery(statusQuery()).then(
				(observed) => observed,
				() => undefined,
			);
			const stem = noteIdOf(path);
			const row = stem === undefined ? undefined : noteRows.rowOf(stem)?.row;
			return Ok({
				kind: 'file',
				path,
				title: row && displayTitle(row.fields.title, row.body),
				capture,
				unversioned: status?.changes.some((change) => change.path === path),
			});
		},
		remove: async (deletion: Deletion) => problem(await remove(deletion)),
		/**
		 * Record a version: commit the saved files (ADR-0529). Writes still
		 * running land first.
		 */
		saveVersion: defineMutation({
			mutationKey: notesKeys.saveVersion,
			mutationFn: async (): Promise<Result<CommitOutcome, NotesError>> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				await writesSettled();
				return Ok(await folder.git.commit());
			},
			onSettled: () => invalidate(notesKeys.status),
		}),

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		/**
		 * Stop taking input and actions, before a close is answered. Returns
		 * the release, for an approval the gate refused.
		 */
		fenceInput(): () => void {
			fenced = true;
			return () => {
				// A close keeps its fence for good.
				if (closing === undefined) fenced = false;
			};
		},
		/**
		 * Resolves once nothing is mutating: every write, action, and terminal
		 * command has landed. A write that failed was already rolled back and
		 * reported, so nothing is left to lose.
		 */
		settle: () => whenIdle(queryClient),
		/**
		 * Fence input for good, wait until nothing is mutating, then release
		 * the folder. Every call answers the same completion.
		 */
		close(): Promise<void> {
			closing ??= (async () => {
				fenced = true;
				await whenIdle(queryClient);
				released = true;
				await queryClient.cancelQueries({ queryKey: notesKeys.all });
				await host.close();
			})();
			return closing;
		},
	};
}
