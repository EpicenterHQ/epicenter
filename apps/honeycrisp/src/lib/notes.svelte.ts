/**
 * The Honeycrisp product state over one opened notes folder, read through a
 * TanStack Query cache (ADR-0548).
 *
 * Reads are queries from `folderOptions(folder)`: the note rows, the folder
 * rows, the file listing the file browser shows, Git status, and the text of
 * each file opened as text. The cache changes in two ways only. Changes the
 * page did not make arrive on `folder.onFilesChanged`, which makes exactly
 * the queries they name stale (the one line in `createNotes`). The page's own
 * writes put their result in the cache, or make what they changed stale.
 * Nothing rereads on focus.
 *
 * An edit holds its own starting version. The title, folder, pin, rich text,
 * and Source of a note, a list action on any note, and a folder's name are
 * all edits of a row's draft (`createDraftState`), one draft per row, which
 * the open note and the lists share. A draft captures the cached row at its
 * first change and keeps the edited row outside the cache, so a read never
 * replaces typing. Each change saves at once; one save runs at a time per
 * row, and changes made meanwhile are sent next. `table.save` merges with
 * whatever changed in the file since the draft began. A save that fails
 * keeps the draft on screen and reports the failure; a note deleted
 * elsewhere drops it. A file open as its exact text has a text draft of its
 * own (`createTextDraftState`), saved over the version it started from and
 * merged by line with whatever changed since (ADR-0551). A save that
 * replaced another writer's change names it, with a way to put theirs back.
 *
 * Every other action is a mutation: create, rename, delete, deleting a
 * folder, Save version, and terminal commands. Closing the notes fences new
 * input, then waits until every save and action settled before it releases
 * the folder. Saves never commit (ADR-0529); a version is recorded only by
 * Save version.
 */
import {
	type CommitOutcome,
	type FileCapture,
	type FileError,
	type FileListing,
	type FileSaveError,
	formatRow,
	type GitError,
	type MoveError,
	parseRow,
	type Replaced,
	type Row,
	type RowReadError,
	rowPath,
	rowStemOf,
	type SavedRow,
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
	readTextFile,
} from '@epicenter/folder/file-browser';
import {
	folderOptions,
	runMutation,
	type TableOptions,
	whenIdle,
} from '@epicenter/folder/query';
import {
	createDraftState,
	createTextDraftState,
	type DraftState,
	type TextDraftState,
} from '@epicenter/folder/svelte';
import type { MutationFilters, QueryClient } from '@tanstack/svelte-query';
import { createSubscriber, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result, unwrap } from 'wellcrafted/result';
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
import { nameProblem } from './files.js';
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

/** A save that failed. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | FileSaveError;
	/** The text of the edit the file does not hold. */
	readonly unsaved: string;
	/**
	 * Whether the edit stays on screen, to be saved again. Otherwise the view
	 * shows the file: the note is gone, or a text save failed.
	 */
	readonly kept: boolean;
};

/**
 * A save that replaced another writer's change to the same values, and the
 * one more save that puts theirs back.
 */
export type ReplacedChange = {
	readonly path: string;
	readonly replaced: readonly Replaced[];
	readonly restore: () => void;
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
const NOT_LISTED = 'This file is not in the list, so nothing was changed.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** Cache identity for the app's own actions; the folder's reads and writes are `folder$`'s. */
export const notesKeys = defineKeys({
	all: ['honeycrisp'],
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
		case 'KeptChanging':
			return 'The file kept changing elsewhere while it was saved, so the edit is not saved yet.';
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

export function createNotes(
	host: NotesHost,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
		onReplaced = () => {},
	}: {
		/** A save failed; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
		/** A save replaced another writer's change to the same values; the app may say so. */
		onReplaced?: (change: ReplacedChange) => void;
	} = {},
) {
	const { folder } = host;
	const folder$ = folderOptions(folder);
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
	/** Set once `close` begins: no edit and no action starts after it. */
	let fenced = $state(false);
	/** The one completion every `close` call answers. */
	let closing: Promise<void> | undefined;
	/** Set once the folder is being released: nothing reads it after. */
	let released = false;

	/** Why no edit or action starts now, if one does not. */
	const refused = () => (fenced ? CLOSING : undefined);

	// The app's own actions are local like the folder's writes: nothing
	// waits for a network or retries.
	queryClient.setMutationDefaults(notesKeys.all, {
		networkMode: 'always',
		retry: false,
	});

	// Changes the page did not make arrive here, and make exactly the queries
	// they name stale. Stopped when the notes close.
	const stopChanges = folder.onFilesChanged((change) =>
		queryClient.invalidateQueries(folder$.pathFilter(change)),
	);

	/**
	 * After the app's own action: what it changed at `paths` is read again,
	 * Git status included. The folder does not report a page's own writes
	 * to it.
	 */
	const changed = (...paths: string[]) =>
		released
			? Promise.resolve()
			: queryClient.invalidateQueries(folder$.pathFilter(paths));

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

	/**
	 * One table's rows: the listing in the cache, and the drafts of the rows
	 * being edited, by stem.
	 */
	function rowTable<TFields>(name: TableName, options: TableOptions<TFields>) {
		const declared = honeycrispDefinition.tables[name];
		const drafts = new SvelteMap<string, DraftState<TFields>>();
		const listing = () =>
			queryClient.getQueryData<TableListing<TFields>>(options.list.queryKey());

		/** The row the cache holds for `stem`, if it reads as one. */
		function storedOf(stem: string): StoredRow<TFields> | undefined {
			const result = listing()?.find((entry) => entry.stem === stem)?.result;
			return result?.error === null ? result.data : undefined;
		}

		/** The text a person would lose with a row that could not be saved. */
		function rowText(row: Row<TFields>) {
			return formatRow(declared, row).data ?? (row as Row<unknown>).body;
		}

		const save = {
			...options.save.mutationOptions(),
			onError: (error, { base, row }) => {
				const stem = rowStemOf(name, base.path);
				// A row deleted elsewhere is not written back: its edit leaves the
				// screen, the lists, read again, let it go, and the person is
				// offered its text.
				const gone = error.name === 'NotFound';
				if (gone && stem !== undefined) {
					drafts.get(stem)?.discard();
					drafts.delete(stem);
				}
				onWriteFailed({
					path: base.path,
					error,
					unsaved: rowText(row),
					kept: !gone,
				});
			},
		} satisfies ReturnType<TableOptions<TFields>['save']['mutationOptions']>;

		/** Name what a row's save replaced, and offer theirs back as one more save. */
		function report(saved: SavedRow<TFields>, restore: () => void) {
			// Both sides moving `updatedAt` is not a change worth a notice.
			const told = saved.replaced.filter(
				(entry) => !(entry.kind === 'field' && entry.field === 'updatedAt'),
			);
			if (told.length > 0)
				onReplaced({ path: saved.stored.path, replaced: told, restore });
		}

		function draftOf(stem: string) {
			const existing = drafts.get(stem);
			if (existing !== undefined) return existing;
			const draft = createDraftState<TFields>({
				save: (sent) => runMutation(queryClient, save, sent),
				onSaved: report,
			});
			drafts.set(stem, draft);
			return draft;
		}

		/**
		 * Save the draft of `stem` until no change is left; then a draft with
		 * nothing left is let go.
		 */
		function saveDraft(stem: string): Promise<void> {
			const draft = drafts.get(stem);
			if (draft === undefined) return Promise.resolve();
			if (draft.saving) return draft.save();
			return draft.save().then(() => {
				if (
					draft.row === undefined &&
					!draft.saving &&
					drafts.get(stem) === draft
				)
					drafts.delete(stem);
			});
		}

		/**
		 * Change the row at `stem` through its draft, which saves it. Answers
		 * why the change was refused, changing nothing: once the notes are
		 * closing, while a rename or delete of the file runs, and while the
		 * file is open as text.
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
			const current = storedOf(stem);
			if (current === undefined) return NOT_LISTED;
			const from = drafts.get(stem)?.row ?? current.row;
			const next = change(from);
			if (next === from) return undefined;
			const { fields, body } = structuredClone(next);
			draftOf(stem).change(current, (row) => {
				row.fields = fields;
				row.body = body;
			});
			void saveDraft(stem);
			return undefined;
		}

		/** The drafts of this table whose saves are running, each until its loop ends. */
		const running = () =>
			[...drafts.values()]
				.filter((draft) => draft.saving)
				.map((draft) => draft.save());

		return {
			name,
			table: folder.tables[name],
			listing,
			storedOf,
			edit,
			running,
			/** The row as shown: its draft while one is held, else as the cache holds it. */
			rowOf(stem: string): Row<TFields> | undefined {
				const draft = drafts.get(stem)?.row;
				// A copy, so a view that compares rows sees each change.
				if (draft !== undefined)
					return { fields: { ...draft.fields }, body: draft.body };
				return storedOf(stem)?.row;
			},
			/** Whether a save of `stem` is running. */
			saving: (stem: string) => drafts.get(stem)?.saving === true,
			/** Whether `stem` holds an edit that is not saved and no save is running. */
			unsaved(stem: string) {
				const draft = drafts.get(stem);
				return draft !== undefined && !draft.saving && draft.row !== undefined;
			},
			/** Whether any row of this table holds an edit that is not saved. */
			anyUnsaved: () =>
				[...drafts.values()].some(
					(draft) => !draft.saving && draft.row !== undefined,
				),
			anySaving: () => [...drafts.values()].some((draft) => draft.saving),
			saveDraft,
			/** Resolves once the save of `stem`, if one runs, landed or failed. */
			settled(stem: string) {
				const draft = drafts.get(stem);
				return draft?.saving ? draft.save() : Promise.resolve();
			},
			/** The capture the cache holds for `stem`: a row's, or a row that does not read's own bytes. */
			capture(stem: string): FileCapture | undefined {
				const result = listing()?.find((entry) => entry.stem === stem)?.result;
				if (result?.error === null) return result.data;
				if (result?.error.name === 'InvalidRow') return result.error;
				return undefined;
			},
			/** Drop the draft of `stem`: its file was renamed or deleted. */
			forget(stem: string) {
				drafts.get(stem)?.discard();
				drafts.delete(stem);
			},
		};
	}

	const noteRows = rowTable<NoteFields>('notes', folder$.notes);
	const folderRows = rowTable<FolderFields>('folders', folder$.folders);

	/** The row table `path` is in, and its stem, if it is a row file. */
	function rowAt(path: string) {
		const noteStem = rowStemOf(NOTES, path);
		if (noteStem !== undefined) return { rows: noteRows, stem: noteStem };
		const folderStem = rowStemOf(FOLDERS, path);
		if (folderStem !== undefined) return { rows: folderRows, stem: folderStem };
		return undefined;
	}

	const textKey = (path: string) => folder$.files.text.queryKey(path);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(textKey(path));

	/** Text edits in progress, by path. */
	const textDrafts = new SvelteMap<string, TextDraftState>();

	const writeText = {
		...folder$.files.write.mutationOptions(),
		// The save merges with a change made elsewhere, so this is a failure
		// that saved nothing: the view takes the file as it is now, read
		// again, and the person is offered what they typed.
		onError: (error, { path, content }) => {
			textDrafts.get(path)?.discard();
			textDrafts.delete(path);
			onWriteFailed({
				path,
				error,
				unsaved: typeof content === 'string' ? content : '',
				kept: false,
			});
		},
	} satisfies ReturnType<typeof folder$.files.write.mutationOptions>;

	/** An edit of one file's exact text, saved one write at a time; what a save replaced is named. */
	function createTextDraft(path: string) {
		return createTextDraftState({
			save: (sent) => runMutation(queryClient, writeText, { path, ...sent }),
			onSaved: ({ replaced }, restore) => {
				if (replaced.length > 0) onReplaced({ path, replaced, restore });
			},
			definition: folder.definition,
		});
	}

	/** Write the text draft of `path`; once it is written, it is let go. */
	function saveText(path: string): Promise<void> {
		const draft = textDrafts.get(path);
		if (draft === undefined) return Promise.resolve();
		if (draft.saving) return draft.save();
		return draft.save().then(() => {
			if (draft.text === undefined && textDrafts.get(path) === draft)
				textDrafts.delete(path);
		});
	}

	/** Whether a save of a row or a file's text is running. */
	const saving = () =>
		noteRows.anySaving() ||
		folderRows.anySaving() ||
		[...textDrafts.values()].some((draft) => draft.saving);

	/** Resolves once every save running now, and every save it leads to, landed or failed. */
	async function writesSettled() {
		for (;;) {
			const running = [
				...noteRows.running(),
				...folderRows.running(),
				...[...textDrafts.values()]
					.filter((draft) => draft.saving)
					.map((draft) => draft.save()),
			];
			if (running.length === 0) return;
			await Promise.all(running);
		}
	}

	/** Resolves once the save of `path`, as a row or as text, landed or failed. */
	function settledAt(path: string) {
		const at = rowAt(path);
		return Promise.all([
			at?.rows.settled(at.stem),
			textDrafts.get(path)?.saving ? textDrafts.get(path)?.save() : undefined,
		]);
	}

	/** Change the note at `path` through its draft, which saves it; answers why not, if not. */
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
	const lockedAt = (path: string) => fenced || moving(path);

	/** The same file as captured now, for a file no view holds. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/**
	 * The capture a rename or delete of `path` acts on, read when it runs,
	 * after the file's saves landed: the version the cache holds for what the
	 * app edits, if it holds one.
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

	/** After a rename: the drafts let the old path go, and the open item follows the file. */
	function moved(from: string, to: string) {
		const at = rowAt(from);
		if (at !== undefined) at.rows.forget(at.stem);
		textDrafts.delete(from);
		queryClient.removeQueries({ queryKey: textKey(from), exact: true });
		if (selected?.path === from) selected = { ...selected, path: to };
	}

	/** After a delete: the drafts and the open item let the file go. */
	function deleted(path: string) {
		const at = rowAt(path);
		if (at !== undefined) at.rows.forget(at.stem);
		textDrafts.delete(path);
		queryClient.removeQueries({ queryKey: textKey(path), exact: true });
		if (selected?.path === path) selected = undefined;
	}

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		const stem = noteIdOf(path);
		if (stem === undefined) return 'text';
		const result = noteRows
			.listing()
			?.find((entry) => entry.stem === stem)?.result;
		return result === undefined || result.error === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. Opening never waits, writes, or asks. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as, id: ++openings };
	}

	/** What a person reads about an action's outcome: nothing, or why it failed. */
	function problem(
		result: Result<unknown, Parameters<typeof describeError>[0]>,
	) {
		return result.error === null ? undefined : describeError(result.error);
	}

	/**
	 * A terminal command may write anything, so it is a mutation that closing
	 * waits for. What it wrote reaches the cache as any outside change does.
	 */
	const runCommand = defineMutation({
		mutationKey: ['honeycrisp', 'terminal'],
		mutationFn: async ({
			shell,
			command,
		}: {
			shell: NotesTerminal;
			command: string;
		}) => Ok(await shell.exec(command)),
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
		onSuccess: async (created) => {
			await changed(created.path);
			open(created.path, 'note');
		},
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
		onSuccess: (created) => changed(created.path),
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
		onSuccess: async (created) => {
			await changed(created.path);
			open(created.path, 'text');
		},
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
			const listing = queryClient.getQueryData<FileListing>(
				folder$.files.list.queryKey(),
			);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return NotesError.NotStarted({
					reason: `"${name}" already exists here.`,
				});
			return folder.files.mkdir(path);
		},
		onSuccess: (_, { directory, name }) => {
			if (directory !== '') expanded.add(directory);
			return changed(joinPath(directory, name));
		},
	});

	/**
	 * Delete a folder after moving its notes out. Refused while any note
	 * cannot say which folder it is in. Each note moves out by an edit, like
	 * any list action; once every save landed, the notes are read again, and
	 * the folder's file goes only when none is still in it. Not one atomic
	 * step: a note already moved out stays moved out if the delete stops,
	 * and another program can still put a note in the folder after the last
	 * read.
	 */
	function deleteFolder(entry: FolderEntry) {
		return defineMutation({
			mutationKey: notesKeys.remove(entry.path),
			mutationFn: async (): Promise<
				Result<undefined, TableError | FileError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				const listing = noteRows.listing();
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
					// An edit not saved yet counts: its draft is what is shown.
					const shown = noteRows.rowOf(note.stem) ?? note.row;
					if (shown.fields.folderId !== id) continue;
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
				return changed(entry.path);
			},
		})();
	}

	/**
	 * Rename a file within its folder. A row renames through its table,
	 * unless it is open as text; any other file moves as exact bytes. It
	 * waits for the file's saves to land and moves what the last one wrote.
	 * Edits of the file wait meanwhile.
	 */
	function rename(path: string, name: string) {
		const directory = dirname(path);
		const to = joinPath(directory, name);
		return defineMutation({
			mutationKey: notesKeys.move(path),
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
				await settledAt(path);
				let capture = heldCapture(path);
				if (capture === undefined) {
					const { data, error } = await captureNow(path);
					if (error !== null) return Err(error);
					capture = data;
				}
				// A close that began meanwhile stops the move.
				const late = refused();
				if (late !== undefined) return NotesError.NotStarted({ reason: late });
				return at !== undefined && nextStem !== undefined && !asText(path)
					? at.rows.table.rename(capture, nextStem)
					: folder.files.move(capture, to);
			},
			onSuccess: async (renamed) => {
				if (renamed === undefined) return;
				// The listings take the new name before the open item follows it.
				await changed(path, to);
				moved(path, to);
			},
		})();
	}

	/**
	 * Delete what was confirmed. It waits for the file's saves to land, so
	 * it removes what this app saved last; a file another program changed
	 * since is refused.
	 */
	function remove(deletion: Deletion) {
		return defineMutation({
			mutationKey: notesKeys.remove(deletion.path),
			mutationFn: async (): Promise<
				Result<undefined, FileError | TableError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				if (deletion.kind === 'folder')
					return folder.files.rmdir(deletion.path);
				await settledAt(deletion.path);
				const capture = heldCapture(deletion.path) ?? deletion.capture;
				return folder.files.remove(capture);
			},
			onSuccess: () => {
				deleted(deletion.path);
				return changed(deletion.path);
			},
		})();
	}

	return {
		host,
		queryClient,
		/** The folder's query and mutation options; views read through these. */
		folder$,
		terminal,
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** One file's complete text, or its type and size when it is not editable text. */
		textQuery(path: string) {
			return {
				...folder$.files.text.queryOptions(path),
				// A note opened as its file while its row is being saved is read
				// once that save lands, never under it.
				queryFn: async () => {
					const at = rowAt(path);
					if (at !== undefined) await at.rows.settled(at.stem);
					return unwrap(await readTextFile(folder.files, path));
				},
			};
		},
		/**
		 * Read the listings and Git status when the page opens. A listing that
		 * fails is shown where it is used.
		 */
		async load() {
			await Promise.all([
				queryClient.prefetchQuery(folder$.notes.list.queryOptions()),
				queryClient.prefetchQuery(folder$.folders.list.queryOptions()),
				queryClient.prefetchQuery(folder$.files.list.queryOptions()),
				queryClient.prefetchQuery(folder$.history.status.queryOptions()),
			]);
		},

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

		/** Whether a save of a row or a file's text is running. */
		get saving() {
			return saving();
		},
		/** Whether a row holds an edit whose save failed and that no save is running for. */
		get unsaved() {
			return noteRows.anyUnsaved() || folderRows.anyUnsaved();
		},
		/** Whether anything is saving or mutating: a save, an action, or a terminal command. */
		get busy() {
			trackMutations();
			return saving() || queryClient.isMutating() > 0;
		},
		/** How many mutations match `filters`. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a save of `path` is running. */
		isWriting(path: string) {
			const at = rowAt(path);
			return (
				at?.rows.saving(at.stem) === true ||
				textDrafts.get(path)?.saving === true
			);
		},
		/** Whether `path` holds an edit whose save failed, with no save running. */
		isUnsaved(path: string) {
			const at = rowAt(path);
			return at?.rows.unsaved(at.stem) === true;
		},
		/** Whether edits of `path` are refused now: closing, or a rename or delete runs. */
		isLocked(path: string) {
			trackMutations();
			return lockedAt(path);
		},
		/** Whether input and actions are held back because the notes are closing. */
		get fenced() {
			return fenced;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		/**
		 * Change the note at `path` through its draft, which saves it at once.
		 * Answers why the change was refused, changing nothing, if it was.
		 */
		editNote,
		/**
		 * The note at `path` as the rich-text editor uses it: the row shown
		 * now, read reactively, which is its draft while one is held; whether
		 * it takes edits; and `edit`, which answers whether the change was
		 * taken.
		 */
		noteBody(path: string): NoteBody {
			return {
				get row() {
					trackQueries();
					const stem = noteIdOf(path);
					return stem === undefined ? undefined : noteRows.rowOf(stem);
				},
				get locked() {
					trackMutations();
					return lockedAt(path);
				},
				edit: (change) => editNote(path, change) === undefined,
			};
		},
		/** Save again an edit of `path` whose save failed. */
		saveAgain(path: string) {
			if (refused() !== undefined) return;
			const at = rowAt(path);
			if (at !== undefined) void at.rows.saveDraft(at.stem);
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
		/** The text typed into `path` and not yet written, read reactively. */
		typedText(path: string): string | undefined {
			return textDrafts.get(path)?.text;
		},
		/**
		 * Type `text` as the whole text of `path`, which writes it at once.
		 * Answers whether the change was taken.
		 */
		editText(path: string, text: string): boolean {
			if (refused() !== undefined || moving(path)) return false;
			const opened = textData(path);
			if (opened?.kind !== 'text') return false;
			let draft = textDrafts.get(path);
			if (draft === undefined) {
				draft = createTextDraft(path);
				textDrafts.set(path, draft);
			}
			draft.change(opened.file, text);
			void saveText(path);
			return true;
		},
		/**
		 * Put a committed version of a note in the note: the version's fields
		 * over the note's, and its body. It saves at once, like any edit. A
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
			const listing = queryClient.getQueryData<FileListing>(
				folder$.files.list.queryKey(),
			);
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
			const status = await queryClient
				.fetchQuery(folder$.history.status.queryOptions())
				.then(
					(observed) => observed,
					() => undefined,
				);
			const stem = noteIdOf(path);
			const row = stem === undefined ? undefined : noteRows.rowOf(stem);
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
		 * Record a version: commit the saved files (ADR-0529). Saves still
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
			onSettled: () =>
				queryClient.invalidateQueries({
					queryKey: folder$.history.status.queryKey(),
				}),
		}),

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		/**
		 * Fence input for good, wait until every save and action settled, then
		 * release the folder. Every call answers the same completion.
		 */
		close(): Promise<void> {
			closing ??= (async () => {
				fenced = true;
				await writesSettled();
				await whenIdle(queryClient);
				released = true;
				stopChanges();
				await queryClient.cancelQueries({ queryKey: folder$.key });
				await host.close();
			})();
			return closing;
		},
	};
}
