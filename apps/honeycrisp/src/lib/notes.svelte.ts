/**
 * The Honeycrisp product state over one opened notes folder, read through a
 * TanStack Query cache (ADR-0548) and written through the folder's edit
 * layer (`edits`, ADR-0576).
 *
 * Reads are queries from the folder's query layer (`queries`): the note rows, the folder
 * rows, the file listing the file browser shows, Git status, and the text of
 * each file opened as text. The cache changes in two ways only. Changes the
 * page did not make arrive on `folder.onFilesChanged`, which makes exactly
 * the queries they name stale (`<FolderApp>` wires it once). The page's own
 * writes put their result in the cache, or make what they changed stale.
 * Nothing rereads on focus.
 *
 * A field edit sets fields of the file as it is now (`set`, ADR-0576): a
 * note's title, folder, and pin, a list action on any note, and a folder's
 * name each set their fields and keep every field another writer changed.
 * A note's body, from rich text or Source, is the row's body draft, and a
 * file open as its exact text is its text draft: the edit layer holds each
 * until it is in the file, saves it a second after the last change or at
 * once when the view leaves it, keeps it on screen when a save fails, and
 * offers its text when the file was deleted elsewhere. Writes to one file
 * run one at a time, in the order made. Where a save meets another writer's
 * change to the same lines, the save wins (ADR-0576).
 *
 * Every other action is a mutation: create, rename (`folder.move` for a file
 * that is not a row), delete (a write to no file, whatever the file holds
 * by then), deleting a folder, and Save version. A rename or delete runs
 * once the file's drafts and saves landed, and its edits wait meanwhile.
 * When the folder starts closing, the edit layer fences new input and sends
 * what is typed; `<FolderApp>` then waits for every save and action and
 * releases the folder. Saves never commit (ADR-0529); a version is recorded
 * only by Save version.
 */
import { InstantString } from '@epicenter/definition';
import {
	type CommitOutcome,
	type FileError,
	type FileListing,
	type Row,
	type RowReadError,
	type RowWriteError,
	rowPath,
	rowStemOf,
	type StoredRow,
	type TableListing,
	type WriteError,
	type Written,
	type WrittenRow,
} from '@epicenter/folder';
import {
	ancestors,
	basename,
	dirname,
	joinPath,
	type OpenedFile,
	readTextFile,
} from '@epicenter/folder/file-browser';
import { CLOSING } from '@epicenter/svelte/edits';
import type { FolderContext } from '@epicenter/svelte/folder';
import {
	ActionError,
	type DescribedError,
	describeWriteError,
} from '@epicenter/svelte/write-failure';
import type { MutationFilters } from '@tanstack/svelte-query';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result, unwrap } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	type honeycrispDefinition,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
} from './data.js';
import type { NoteBody } from './editor/rich-text.js';
import { nameProblem } from './files.js';
import { displayTitle } from './note-source.js';

export type Notes = ReturnType<typeof createNotes>;

/**
 * The opened notes folder, as `getFolder()` answers it. Its own
 * `definition` is `honeycrispDefinition` for Honeycrisp's own folder, and the
 * folder's declaration for any other folder Epicenter hands it. The app
 * never syncs; remotes are outside it.
 */
export type NotesFolder = FolderContext<typeof honeycrispDefinition>;

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
			/**
			 * Whether the file has changes that are in no saved version, as Git
			 * status last checked; `undefined` when the check failed.
			 */
			readonly unversioned: boolean | undefined;
	  };

const OPEN_AS_TEXT =
	'This file is open as text. Change it there, or open it as a note.';
const NOT_LISTED = 'This file is not in the list, so nothing was changed.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** Cache identity for the app's own actions; the folder's reads are `queries`'. */
export const notesKeys = defineKeys({
	saveVersion: ['honeycrisp', 'save-version'],
});

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

export function createNotes(opened: NotesFolder) {
	const { folder, queries, queryClient, edits } = opened;
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

	/** Why no action starts now, if one does not: the folder is closing. */
	const refused = () => edits.refusal();

	/**
	 * After the app's own action: what it changed at `paths` is read again,
	 * Git status included. The folder does not report a page's own writes
	 * to it.
	 */
	const changed = (...paths: string[]) =>
		queryClient.invalidateQueries(queries.pathFilter(paths));

	/** Whether `path` is open as its exact text, so its text is what saves. */
	const asText = (path: string) =>
		selected?.path === path && selected.as === 'text';

	/** One table's listing, as the cache holds it now. */
	const listingOf = <TFields>(table: TableName) =>
		queryClient.getQueryData<TableListing<TFields>>(
			queries.tables[table].list.queryKey(),
		);

	/** The row the cache holds for `stem` in `table`, if it reads as one. */
	function storedOf<TFields>(
		table: TableName,
		stem: string,
	): StoredRow<TFields> | undefined {
		const result = listingOf<TFields>(table)?.find(
			(entry) => entry.stem === stem,
		)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/**
	 * Why fields of the row at `stem` take no set or body now, if they do
	 * not: closing, a rename or delete of the file, the file open as text,
	 * or a row the list does not hold.
	 */
	function refusalAt(table: TableName, stem: string): string | undefined {
		const path = rowPath(table, stem);
		const why = edits.refusal(path);
		if (why !== undefined) return why;
		if (asText(path)) return OPEN_AS_TEXT;
		if (storedOf(table, stem) === undefined) return NOT_LISTED;
		return undefined;
	}

	/**
	 * Set fields of the row at `stem` as its file is now; answers why not, if
	 * not. A typed title or folder name is offered to copy when the set
	 * fails; a pin, a move, or a trash carries no text the person typed.
	 */
	function set<K extends TableName>(
		table: K,
		stem: string,
		fields: Partial<K extends 'notes' ? NoteFields : FolderFields>,
		unsaved: string,
	): string | undefined {
		return (
			refusalAt(table, stem) ??
			edits.set(table, stem, fields as never, { unsaved })
		);
	}

	/** The row table `path` is in, and its stem, if it is a row file. */
	function rowAt(path: string) {
		const noteStem = rowStemOf(NOTES, path);
		if (noteStem !== undefined)
			return { table: 'notes' as const, stem: noteStem };
		const folderStem = rowStemOf(FOLDERS, path);
		if (folderStem !== undefined)
			return { table: 'folders' as const, stem: folderStem };
		return undefined;
	}

	/** The note at `stem` as shown: its body typed while one is held, else as the cache holds it. */
	function noteRowOf(stem: string): Row<NoteFields> | undefined {
		const stored = storedOf<NoteFields>('notes', stem);
		if (stored === undefined) return undefined;
		const typed = edits.body('notes', stem).typed;
		return typed === undefined
			? stored.row
			: { fields: stored.row.fields, body: typed };
	}

	/**
	 * Type `body` as the body of the note at `path`; it saves after a pause.
	 * Answers why the change was refused, changing nothing, if it was.
	 */
	function editBody(path: string, body: string): string | undefined {
		const stem = noteIdOf(path);
		if (stem === undefined) return NOT_LISTED;
		const why = refusalAt('notes', stem);
		if (why !== undefined) return why;
		return edits.body('notes', stem).change(body) ? undefined : NOT_LISTED;
	}

	/** Save the body of the note at `path` now, as leaving it does. */
	function saveBody(path: string): Promise<void> {
		const stem = noteIdOf(path);
		return stem === undefined
			? Promise.resolve()
			: edits.body('notes', stem).save();
	}

	const textKey = (path: string) => queries.files.text.queryKey(path);

	/** The text of `path` as the cache holds it, when it opens as text. */
	const shownText = (path: string) => {
		const opened = queryClient.getQueryData<OpenedFile>(textKey(path));
		return opened?.kind === 'text' ? opened.text : undefined;
	};

	/** Set some fields of a note as its file is now: pin, move to a folder, trash, restore. */
	function patchNote(path: string, fields: Partial<NoteFields>) {
		const stem = noteIdOf(path);
		if (stem === undefined) return NOT_LISTED;
		return set('notes', stem, fields, fields.title ?? '');
	}

	/** After a rename: the open item follows the file. */
	function moved(from: string, to: string) {
		queryClient.removeQueries({ queryKey: textKey(from), exact: true });
		if (selected?.path === from) selected = { ...selected, path: to };
	}

	/** After a delete: the open item lets the file go. */
	function deleted(path: string) {
		queryClient.removeQueries({ queryKey: textKey(path), exact: true });
		if (selected?.path === path) selected = undefined;
	}

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		const stem = noteIdOf(path);
		if (stem === undefined) return 'text';
		const result = listingOf<NoteFields>('notes')?.find(
			(entry) => entry.stem === stem,
		)?.result;
		return result === undefined || result.error === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. Opening never waits, writes, or asks. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as, id: ++openings };
	}

	/** What a person reads about an action's outcome: nothing, or why it failed. */
	function problem(result: Result<unknown, DescribedError>) {
		return result.error === null ? undefined : describeWriteError(result.error);
	}

	/** Why a file named `name` in `directory` cannot be made, if it cannot. */
	function placeProblem(directory: string, name: string) {
		const why = refused() ?? nameProblem(directory, name);
		if (why !== undefined) return why;
		const path = joinPath(directory, name);
		const listing = queryClient.getQueryData<FileListing>(
			queries.files.list.queryKey(),
		);
		if (
			listing?.directories.includes(path) ||
			listing?.files.some((file) => file.path === path)
		)
			return `"${name}" already exists here.`;
		return undefined;
	}

	const createNote = defineMutation({
		mutationKey: ['honeycrisp', 'create-note'],
		mutationFn: async (
			stem: string,
		): Promise<Result<WrittenRow<NoteFields>, RowWriteError | ActionError>> => {
			const why = refused();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			return edits.writes.tables.notes.create(
				{
					fields: {
						folderId: view.deleted ? null : view.folderId,
						title: '',
						pinned: false,
						createdAt: InstantString.now(),
						deletedAt: null,
					},
					body: '',
				},
				{ stem },
			);
		},
		onSuccess: (_, stem) => open(rowPath(NOTES, stem), 'note'),
	});

	const createFolder = defineMutation({
		mutationKey: ['honeycrisp', 'create-folder'],
		mutationFn: async ({
			stem,
			name,
		}: {
			stem: string;
			name: string;
		}): Promise<
			Result<WrittenRow<FolderFields>, RowWriteError | ActionError>
		> => {
			const why = refused();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			return edits.writes.tables.folders.create(
				{ fields: { name, icon: null }, body: '' },
				{ stem },
			);
		},
	});

	const createFile = defineMutation({
		mutationKey: ['honeycrisp', 'create-file'],
		mutationFn: async ({
			directory,
			name,
		}: {
			directory: string;
			name: string;
		}): Promise<Result<Written, WriteError | ActionError>> => {
			const why = placeProblem(directory, name);
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			// A write from no file places it only where none is.
			return edits.writes.write(joinPath(directory, name), null, '');
		},
		onSuccess: (created) => open(created.path, 'text'),
	});

	const createDirectory = defineMutation({
		mutationKey: ['honeycrisp', 'create-directory'],
		mutationFn: async ({
			directory,
			name,
		}: {
			directory: string;
			name: string;
		}): Promise<Result<undefined, FileError | ActionError>> => {
			const why = placeProblem(directory, name);
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			return folder.files.mkdir(joinPath(directory, name));
		},
		onSuccess: (_, { directory, name }) => {
			if (directory !== '') expanded.add(directory);
			return changed(joinPath(directory, name));
		},
	});

	/**
	 * Delete a folder after moving its notes out. Refused while any note
	 * cannot say which folder it is in. What is typed and the writes running
	 * land first; each note then moves out by a set, like any list action;
	 * once every write landed, the notes are read again, and the folder's
	 * file goes only when none is still in it. Not one atomic step: a note
	 * already moved out stays moved out if the delete stops, and another
	 * program can still put a note in the folder after the last read.
	 */
	async function deleteFolder(
		entry: FolderEntry,
	): Promise<Result<undefined, WriteError | FileError | ActionError>> {
		const why = refused();
		if (why !== undefined) return ActionError.NotStarted({ reason: why });
		const deleting = await edits.exclusive(entry.path, async () => {
			// Every write lands first, so the listing says where each note is.
			await edits.settled();
			const listing = listingOf<NoteFields>('notes');
			if (listing === undefined)
				return ActionError.NotStarted({
					reason:
						'The notes could not be listed, so it is not known which are in this folder.',
				});
			const unknown = [...repairsOf(listing), ...unreadableOf(listing, [])];
			if (unknown.length > 0)
				return ActionError.NotStarted({
					reason: `Some notes cannot be read well enough to tell which folder they are in (${unknown
						.slice(0, 3)
						.map((item) => basename(item.path))
						.join(', ')}). Repair or remove them first.`,
				});
			const id = entry.stem;
			for (const note of notesOf(listing)) {
				if (note.row.fields.folderId !== id) continue;
				const refusal = patchNote(note.path, { folderId: null });
				if (refusal !== undefined)
					return ActionError.NotStarted({
						reason: `A note could not be moved out of the folder: ${refusal}`,
					});
			}
			await edits.settled();
			const reread = await folder.tables.notes.list();
			if (reread.error !== null) return Err(reread.error);
			const remaining = notesOf(reread.data).filter(
				(note) => note.row.fields.folderId === id,
			);
			if (remaining.length > 0)
				return ActionError.NotStarted({
					reason: `Some notes are still in this folder (${remaining
						.slice(0, 3)
						.map((note) => basename(note.path))
						.join(', ')}), so it was kept. Delete it again to move them out.`,
				});
			return edits.writes.tables.folders.delete(entry.stem);
		});
		if (deleting.error !== null) return deleting;
		deleted(entry.path);
		if (view.folderId === entry.stem) view = { ...view, folderId: null };
		return deleting;
	}

	/**
	 * Rename a file within its folder, through the folder's one move: a row
	 * and any other file alike move as exact bytes, a row to the path of its
	 * new stem. It waits for the file's drafts and saves to land and moves
	 * what the file holds then. Edits of the file wait meanwhile.
	 */
	async function rename(
		path: string,
		name: string,
	): Promise<Result<Written | undefined, WriteError | ActionError>> {
		const directory = dirname(path);
		const to = joinPath(directory, name);
		const why = refused() ?? nameProblem(directory, name);
		if (why !== undefined) return ActionError.NotStarted({ reason: why });
		if (to === path) return Ok(undefined);
		const at = rowAt(path);
		const nextStem = at === undefined ? undefined : rowStemOf(at.table, to);
		if (at !== undefined && nextStem === undefined)
			return ActionError.NotStarted({
				reason: `A ${at.table === NOTES ? 'note' : 'folder'} file keeps its .md extension.`,
			});
		const renamed = await edits.exclusive(path, async () =>
			// A close that began meanwhile stops the move.
			edits.fenced
				? ActionError.NotStarted({ reason: CLOSING })
				: edits.writes.move(path, to),
		);
		if (renamed.error !== null) return renamed;
		// The listings take the new name before the open item follows it.
		await changed(path, to);
		moved(path, to);
		return renamed;
	}

	/**
	 * Delete what was confirmed. It waits for the file's drafts and saves to
	 * land, so what this app saved last goes with it, and deletes the file
	 * whatever another program changed in it since: the deleter wins
	 * (ADR-0576).
	 */
	async function deleteConfirmed(
		deletion: Deletion,
	): Promise<Result<unknown, FileError | WriteError | ActionError>> {
		const why = refused();
		if (why !== undefined) return ActionError.NotStarted({ reason: why });
		const removed =
			deletion.kind === 'folder'
				? await folder.files.rmdir(deletion.path)
				: await edits.exclusive(deletion.path, () =>
						edits.writes.write(deletion.path, null, null),
					);
		if (removed.error !== null) return removed;
		deleted(deletion.path);
		await changed(deletion.path);
		return removed;
	}

	return {
		/** The opened folder; `<FolderApp>` releases it. */
		folder,
		queryClient,
		/** The folder's query options; views read through these. */
		queries,
		/** The folder's edit layer: every draft, set, and write. */
		edits,
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
				...queries.files.text.queryOptions(path),
				// A note opened as its file while its row is being saved is read
				// once that save lands, never under it.
				queryFn: async () => {
					await edits.settled(path);
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
				queryClient.prefetchQuery(queries.notes.list.queryOptions()),
				queryClient.prefetchQuery(queries.folders.list.queryOptions()),
				queryClient.prefetchQuery(queries.files.list.queryOptions()),
				queryClient.prefetchQuery(queries.history.status.queryOptions()),
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

		/** Whether a save of a row or a file's text is running, or typing waits to be sent. */
		get saving() {
			return edits.writing();
		},
		/** Whether text typed did not save, with no save running or waiting. */
		get unsaved() {
			return edits.unsaved();
		},
		/** Whether anything is saving or mutating: a save or an action. */
		get busy() {
			return edits.busy;
		},
		/** How many mutations match `filters`. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a write of `path` is running, or typing there waits to be sent. */
		isWriting: (path: string) => edits.writing(path),
		/** Whether the body typed at `path` did not save, with no save running. */
		isUnsaved(path: string) {
			const stem = noteIdOf(path);
			return stem !== undefined && edits.body('notes', stem).failed;
		},
		/** Whether edits of `path` are refused now: closing, or a rename or delete runs. */
		isLocked: (path: string) => edits.locked(path),
		/** Whether input and actions are held back because the notes are closing. */
		get fenced() {
			return edits.fenced;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		/** Why the note at `path` takes no set or body now, if it does not. */
		refusalAt(path: string): string | undefined {
			const stem = noteIdOf(path);
			return stem === undefined ? NOT_LISTED : refusalAt('notes', stem);
		},
		/**
		 * Type `body` as the note's body; it saves a second after the last
		 * change, or at once with `saveBody`. Answers why not, if not.
		 */
		editBody,
		/** Send the body typed at `path` now, as leaving it does; resolves once no save of it runs. */
		saveBody,
		/**
		 * The note at `path` as the rich-text editor uses it: the row shown
		 * now, read reactively, with the body typed while one is held;
		 * whether it takes edits; and `edit`, which types a body and answers
		 * whether it was taken.
		 */
		noteBody(path: string): NoteBody {
			const row = () => {
				trackQueries();
				const stem = noteIdOf(path);
				return stem === undefined ? undefined : noteRowOf(stem);
			};
			return {
				get row() {
					return row();
				},
				get locked() {
					return edits.locked(path);
				},
				edit(body) {
					const shown = row();
					if (shown === undefined) return false;
					if (body === shown.body) return true;
					return editBody(path, body) === undefined;
				},
			};
		},
		/** Save again a body of `path` whose save failed. */
		saveAgain(path: string) {
			if (edits.fenced) return;
			void saveBody(path);
		},
		/** Set some fields of a note as its file is now: pin, move to a folder, trash, restore. */
		patchNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) =>
			patchNote(path, { deletedAt: InstantString.now() }),
		restoreNote: (path: string) => patchNote(path, { deletedAt: null }),
		/** Set a folder's fields as its file is now; answers why not, if not. */
		patchFolder(path: string, fields: Partial<FolderFields>) {
			const stem = rowStemOf(FOLDERS, path);
			if (stem === undefined) return NOT_LISTED;
			return set('folders', stem, fields, fields.name ?? '');
		},
		/** The text typed into `path` and not yet written, read reactively. */
		typedText: (path: string) => edits.text(path).typed,
		/**
		 * Type `text` as the whole text of `path`; it is written a second after
		 * the last change, or at once with `saveText`. Answers whether the
		 * change was taken.
		 */
		editText(path: string, text: string): boolean {
			if (shownText(path) === undefined && edits.text(path).typed === undefined)
				return false;
			return edits.text(path).change(text);
		},
		/** Write the text typed into `path` now, as leaving it does; resolves once no write of it runs. */
		saveText: (path: string) => edits.text(path).save(),

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it. */
		createNote: async () => problem(await createNote(newId())),
		createFolder: async (name: string) =>
			problem(await createFolder({ stem: newId(), name })),
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
				queries.files.list.queryKey(),
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
			const { error } = await folder.files.read(path);
			if (error !== null) return Err(describeWriteError(error));
			const status = await queryClient
				.fetchQuery(queries.history.status.queryOptions())
				.then(
					(observed) => observed,
					() => undefined,
				);
			const stem = noteIdOf(path);
			const row = stem === undefined ? undefined : noteRowOf(stem);
			return Ok({
				kind: 'file',
				path,
				title: row && displayTitle(row.fields.title, row.body),
				unversioned: status?.changes.some((change) => change.path === path),
			});
		},
		delete: async (deletion: Deletion) =>
			problem(await deleteConfirmed(deletion)),
		/**
		 * Record a version: commit the saved files (ADR-0529). What is typed
		 * and the saves still running land first.
		 */
		saveVersion: defineMutation({
			mutationKey: notesKeys.saveVersion,
			mutationFn: (): Promise<Result<CommitOutcome, ActionError>> =>
				edits.saveVersion(),
		}),
	};
}
