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
 * A field edit sets fields of the file as it is now (`set`, ADR-0576): a
 * note's title, folder, and pin, a list action on any note, and a folder's
 * name each set their fields and keep every field another writer changed.
 * The open note holds a title typed and not yet sent. A note's body, from
 * rich text or Source, is a document: a body editor (`createBodyEditor`),
 * one per note, which keeps the row it started from and is saved a second
 * after the last change, or at once when the view leaves it, merged by line
 * with whatever changed since. A file open as its exact text has a text
 * editor of its own (`createTextEditor`), saved the same way with the
 * folder's write. Writes to one file run one at a time, in the order made. A
 * body save that fails keeps the body on screen and reports the failure. A
 * delete beats an edit that never saw it: a body or a text whose file was
 * deleted elsewhere writes nothing, and is dropped with its text offered.
 * Where a save meets another writer's change to the same lines, the save
 * wins (ADR-0576).
 *
 * Every other action is a mutation: create, rename (`folder.move` for a file
 * that is not a row), delete (a write to no file, whatever the file holds
 * by then), deleting a folder, and Save version. Closing the notes fences new input, then waits
 * until every save and action settled before it releases the folder. Saves never commit (ADR-0529); a version is recorded only by
 * Save version.
 */
import { InstantString } from '@epicenter/definition';
import {
	type CommitOutcome,
	FileError,
	type FileListing,
	type GitError,
	type Row,
	type RowReadError,
	rowPath,
	rowStemOf,
	type StoredRow,
	type TableError,
	type TableListing,
	type WriteError,
	type Written,
	type WrittenRow,
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
	createBodyEditor,
	createTextEditor,
	type TextEditor,
} from '@epicenter/folder/svelte';
import {
	hashKey,
	type Mutation,
	type MutationFilters,
	type QueryClient,
} from '@tanstack/svelte-query';
import { useDebounce } from 'runed';
import { createSubscriber, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result, unwrap } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	NOTES,
	type NoteEntry,
	type NoteFields,
	noteIdOf,
} from './data.js';
import type { NoteBody } from './editor/rich-text.js';
import { nameProblem } from './files.js';
import { displayTitle } from './note-source.js';
import type { NotesFolder } from './platform/types.js';

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
			/**
			 * Whether the file has changes that are in no saved version, as Git
			 * status last checked; `undefined` when the check failed.
			 */
			readonly unversioned: boolean | undefined;
	  };

/** A save that failed. */
export type WriteFailure = {
	readonly path: string;
	readonly error:
		| WriteError
		| Extract<FileError, { name: 'NotFound' }>
		| Extract<NotesError, { name: 'NoteDeleted' }>;
	/** The text of the edit the file does not hold. */
	readonly unsaved: string;
	/**
	 * Whether the edit stays on screen, to be saved again. Otherwise the view
	 * shows the file: the note is gone, or a text save failed.
	 */
	readonly kept: boolean;
};

/** Why an action did not start, or stopped before it changed anything. */
export const NotesError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
	/** A body was typed into a note that another program deleted. */
	NoteDeleted: ({ path }: { path: string }) => ({
		message: 'This note was deleted elsewhere, so your edit was not saved.',
		path,
	}),
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
	delete: (path: string) => ['honeycrisp', 'delete', path] as const,
	saveVersion: ['honeycrisp', 'save-version'],
});

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error: FileError | TableError | NotesError | GitError,
): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'KeptChanging':
			return 'The file kept changing elsewhere while it was saved, so the edit is not saved yet.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
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
	folder: NotesFolder,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
	}: {
		/** A save failed; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
	} = {},
) {
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
	const stopChanges = folder$.invalidateOnChange(queryClient);

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
				mutationKey: notesKeys.delete(path),
				exact: true,
			}) >
		0;

	/** Whether `path` is open as its exact text, so its text is what saves. */
	const asText = (path: string) =>
		selected?.path === path && selected.as === 'text';

	/**
	 * The path a folder write is to: a body write's or field set's stem in
	 * its table, or a file write's path.
	 */
	function writePath(mutation: Pick<Mutation, 'state' | 'options'>) {
		const sent = mutation.state.variables as
			| { stem?: string; path?: string }
			| undefined;
		if (sent?.path !== undefined) return sent.path;
		const key = mutation.options.mutationKey;
		const verb = key?.at(-1);
		if (sent?.stem === undefined || (verb !== 'write' && verb !== 'set'))
			return undefined;
		return rowPath(String(key?.at(-2)), sent.stem);
	}
	const writing = (path?: string) =>
		queryClient.isMutating({
			predicate: (mutation) => {
				const at = writePath(mutation);
				return at !== undefined && (path === undefined || at === path);
			},
		}) > 0;

	/**
	 * One table's rows: the listing in the cache, and the set of a row's
	 * fields as its file is now (ADR-0576).
	 */
	function rowTable<TFields>(name: TableName, options: TableOptions<TFields>) {
		const listing = () =>
			queryClient.getQueryData<TableListing<TFields>>(options.list.queryKey());

		/** The row the cache holds for `stem`, if it reads as one. */
		function storedOf(stem: string): StoredRow<TFields> | undefined {
			const result = listing()?.find((entry) => entry.stem === stem)?.result;
			return result?.error === null ? result.data : undefined;
		}

		const setRow = {
			...options.set.mutationOptions(),
			// What was typed stays on screen, to be sent again.
			onError: (error, { stem }) =>
				onWriteFailed({
					path: rowPath(name, stem),
					error,
					unsaved: '',
					kept: true,
				}),
		} satisfies ReturnType<TableOptions<TFields>['set']['mutationOptions']>;

		/**
		 * Why fields of the row at `stem` take no set now, if they do not:
		 * closing, a rename or delete of the file, the file open as text, or a
		 * row the list does not hold.
		 */
		function refusalAt(stem: string): string | undefined {
			const path = rowPath(name, stem);
			const why = refused();
			if (why !== undefined) return why;
			if (moving(path)) return BUSY;
			if (asText(path)) return OPEN_AS_TEXT;
			if (storedOf(stem) === undefined) return NOT_LISTED;
			return undefined;
		}

		/** Set fields of the row at `stem` as its file is now; answers why not, if not. */
		function set(stem: string, fields: Partial<TFields>): string | undefined {
			const why = refusalAt(stem);
			if (why !== undefined) return why;
			void runMutation(queryClient, setRow, { stem, fields }).catch(() => {});
			return undefined;
		}

		return {
			name,
			table: folder.tables[name],
			listing,
			storedOf,
			setRow,
			refusalAt,
			set,
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

	/**
	 * A document being typed: its draft, the text typed and not yet saved,
	 * and the save that runs after a pause.
	 */
	type Typed<TDraft> = {
		readonly draft: TDraft;
		readonly typed: () => string | undefined;
		readonly later: ReturnType<typeof useDebounce<[], Promise<void>>>;
	};

	/**
	 * Save the draft of `typed` now, as leaving it does, until no change is
	 * left; then a draft with nothing left is let go from `held`.
	 */
	async function saveTyped<
		TDraft extends { readonly saving: boolean; save(): Promise<void> },
	>(held: SvelteMap<string, Typed<TDraft>>, key: string): Promise<void> {
		const typed = held.get(key);
		if (typed === undefined) return;
		if (typed.later.pending) void typed.later.runScheduledNow();
		await typed.draft.save();
		if (
			typed.typed() === undefined &&
			!typed.draft.saving &&
			held.get(key) === typed
		)
			held.delete(key);
	}

	/**
	 * Note bodies being typed, by stem (ADR-0576). A body is opened: its
	 * editor keeps the row it started from, and its save merges by line
	 * with whatever changed since. It saves a second after the last change,
	 * and at once when the view leaves it (`saveBody`). It saves nothing
	 * while the list does not hold its note.
	 */
	const bodies = new SvelteMap<string, Typed<TextEditor>>();

	const writeNote = {
		...folder$.notes.write.mutationOptions(),
		// What was typed stays on screen, to be sent again.
		onError: (error, { stem, to }) =>
			onWriteFailed({
				path: rowPath(NOTES, stem),
				error,
				unsaved: to?.body ?? '',
				kept: true,
			}),
	} satisfies ReturnType<typeof folder$.notes.write.mutationOptions>;

	/** Stems whose body save found the note deleted, so it wrote nothing. */
	const savedOverDelete = new Set<string>();

	/**
	 * Let go of the body held for `stem` and offer its text once, as a failed
	 * save, when its note was deleted elsewhere: a save found it gone, or the
	 * listing no longer holds it. A delete beats an edit that never saw it
	 * (ADR-0576), so nothing writes the note again. A body whose save is
	 * running is left to it.
	 */
	function dropIfDeleted(stem: string) {
		const typed = bodies.get(stem);
		if (typed === undefined || typed.draft.saving) return;
		const listed = noteRows.listing();
		const deleted =
			savedOverDelete.has(stem) ||
			(listed !== undefined && !listed.some((entry) => entry.stem === stem));
		if (!deleted) return;
		savedOverDelete.delete(stem);
		const unsaved = typed.typed();
		if (unsaved === undefined) return;
		// A save scheduled after a pause still runs, and finds no body.
		typed.draft.discard();
		bodies.delete(stem);
		const path = rowPath(NOTES, stem);
		onWriteFailed({
			path,
			error: NotesError.NoteDeleted({ path }).error,
			unsaved,
			kept: false,
		});
	}

	function dropDeletedBodies() {
		for (const stem of [...bodies.keys()]) dropIfDeleted(stem);
	}

	/** Save the body of `stem` now, as leaving it does; a note deleted since lets it go. */
	async function saveBodyOf(stem: string) {
		await saveTyped(bodies, stem);
		dropIfDeleted(stem);
	}
	const noteListHash = hashKey(folder$.notes.list.queryKey());
	const stopDeletedBodies = queryClient.getQueryCache().subscribe((event) => {
		if (
			event.type === 'updated' &&
			event.action.type === 'success' &&
			event.query.queryHash === noteListHash
		)
			dropDeletedBodies();
	});

	function bodyOf(stem: string) {
		const known = bodies.get(stem);
		if (known !== undefined) return known;
		const draft = createBodyEditor<NoteFields>({
			row: () => noteRows.storedOf(stem),
			write: async (change) => {
				const written = await runMutation(queryClient, writeNote, {
					stem,
					...change,
				});
				if (written === null) savedOverDelete.add(stem);
				return written;
			},
		});
		const typed = {
			draft,
			typed: () => draft.typed,
			later: useDebounce(() => saveBodyOf(stem), 1000),
		};
		bodies.set(stem, typed);
		return typed;
	}

	/** The note at `stem` as shown: its body typed while one is held, else as the cache holds it. */
	function noteRowOf(stem: string): Row<NoteFields> | undefined {
		const stored = noteRows.storedOf(stem);
		if (stored === undefined) return undefined;
		const typed = bodies.get(stem)?.typed();
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
		const why = noteRows.refusalAt(stem);
		if (why !== undefined) return why;
		const typed = bodyOf(stem);
		typed.draft.change(body);
		void typed.later();
		return undefined;
	}

	const textKey = (path: string) => folder$.files.text.queryKey(path);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(textKey(path));

	/** The text of `path` as the cache holds it, when it opens as text. */
	const shownText = (path: string) => {
		const opened = textData(path);
		return opened?.kind === 'text' ? opened.file.text : undefined;
	};

	/** Text edits in progress, by path. */
	const textDrafts = new SvelteMap<string, Typed<TextEditor>>();

	/**
	 * Let go of the text typed into `path` and offer it: its write failed, or
	 * found the file deleted. The view takes the file as it is now, read
	 * again.
	 */
	function dropText(
		path: string,
		error: WriteFailure['error'],
		sent: string,
	): void {
		const held = textDrafts.get(path);
		const unsaved = held?.typed() ?? sent;
		held?.draft.discard();
		textDrafts.delete(path);
		onWriteFailed({ path, error, unsaved, kept: false });
	}

	const writeText = folder$.write.mutationOptions();

	/** An edit of one file's exact text, saved one write at a time after a pause. */
	function textDraftOf(path: string) {
		const known = textDrafts.get(path);
		if (known !== undefined) return known;
		const draft = createTextEditor({
			current: () => shownText(path),
			write: async (change) => {
				const written = await runMutation(queryClient, writeText, {
					path,
					...change,
				}).catch((error: WriteError) => {
					// The write merges with a change made elsewhere, so this is a
					// failure that saved nothing.
					dropText(path, error, change.to);
					throw error;
				});
				if (written.file !== null) return 'landed';
				// A delete beats an edit it never saw.
				dropText(path, FileError.NotFound({ path }).error, change.to);
				return 'gone';
			},
		});
		const typed = {
			draft,
			typed: () => draft.typed,
			later: useDebounce(() => saveTyped(textDrafts, path), 1000),
		};
		textDrafts.set(path, typed);
		return typed;
	}

	/** Whether `typed` holds text whose save failed: nothing saving it or about to. */
	const failed = ({
		draft,
		typed,
		later,
	}: Typed<{ readonly saving: boolean }>) =>
		typed() !== undefined && !draft.saving && !later.pending;

	/** Every document draft held now. */
	const typedDrafts = () => [...bodies.values(), ...textDrafts.values()];

	/** Whether a save of a row or a file's text is running, or typing waits to be sent. */
	const saving = () => {
		trackMutations();
		return (
			writing() ||
			typedDrafts().some(
				({ draft, typed, later }) =>
					draft.saving || (later.pending && typed() !== undefined),
			)
		);
	};

	/** Resolves once every document typed is sent, and every write running now and every one it leads to landed or failed. */
	async function writesSettled() {
		for (;;) {
			await Promise.all([
				...[...bodies.keys()].map((stem) => saveBodyOf(stem)),
				...[...textDrafts.keys()].map((path) => saveTyped(textDrafts, path)),
			]);
			await whenIdle(queryClient, {
				predicate: (mutation) => writePath(mutation) !== undefined,
			});
			if (typedDrafts().every(({ draft }) => !draft.saving)) return;
		}
	}

	/** Resolves once what is typed at `path` is sent, and its writes landed or failed. */
	async function settledAt(path: string) {
		const stem = noteIdOf(path);
		await Promise.all([
			stem === undefined ? undefined : saveBodyOf(stem),
			saveTyped(textDrafts, path),
		]);
		await whenIdle(queryClient, {
			predicate: (mutation) => writePath(mutation) === path,
		});
	}

	/** Set some fields of a note as its file is now: pin, move to a folder, trash, restore. */
	function patchNote(path: string, fields: Partial<NoteFields>) {
		const stem = noteIdOf(path);
		if (stem === undefined) return NOT_LISTED;
		return noteRows.set(stem, fields);
	}

	/** Whether edits to `path` are refused now: closing, or a rename or delete runs. */
	const lockedAt = (path: string) => fenced || moving(path);

	/** Drop what is typed for `path`: its file was renamed or deleted. */
	function forget(path: string) {
		const stem = noteIdOf(path);
		if (stem !== undefined) {
			bodies.get(stem)?.draft.discard();
			bodies.delete(stem);
			savedOverDelete.delete(stem);
		}
		textDrafts.get(path)?.draft.discard();
		textDrafts.delete(path);
	}

	/** After a rename: the drafts let the old path go, and the open item follows the file. */
	function moved(from: string, to: string) {
		forget(from);
		queryClient.removeQueries({ queryKey: textKey(from), exact: true });
		if (selected?.path === from) selected = { ...selected, path: to };
	}

	/** After a delete: the drafts and the open item let the file go. */
	function deleted(path: string) {
		forget(path);
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

	const createNote = defineMutation({
		mutationKey: ['honeycrisp', 'create-note'],
		mutationFn: async (
			stem: string,
		): Promise<Result<WrittenRow<NoteFields>, WriteError | NotesError>> => {
			const why = refused();
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			return folder.tables.notes.create(
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
		onSuccess: async (_, stem) => {
			const path = rowPath(NOTES, stem);
			await changed(path);
			open(path, 'note');
		},
	});

	const createFolder = defineMutation({
		mutationKey: ['honeycrisp', 'create-folder'],
		mutationFn: async ({
			stem,
			name,
		}: {
			stem: string;
			name: string;
		}): Promise<Result<WrittenRow<FolderFields>, WriteError | NotesError>> => {
			const why = refused();
			if (why !== undefined) return NotesError.NotStarted({ reason: why });
			return folder.tables.folders.create(
				{ fields: { name, icon: null }, body: '' },
				{ stem },
			);
		},
		onSuccess: (_, { stem }) => changed(rowPath(FOLDERS, stem)),
	});

	const createFile = defineMutation({
		mutationKey: ['honeycrisp', 'create-file'],
		mutationFn: async ({
			directory,
			name,
		}: {
			directory: string;
			name: string;
		}): Promise<Result<Written, WriteError | NotesError>> => {
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
			// A write from no file places it only where none is.
			return folder.write(path, null, '');
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
	 * cannot say which folder it is in. Writes running land first; each note
	 * then moves out by a set, like any list action; once every write
	 * landed, the notes are read again, and
	 * the folder's file goes only when none is still in it. Not one atomic
	 * step: a note already moved out stays moved out if the delete stops,
	 * and another program can still put a note in the folder after the last
	 * read.
	 */
	function deleteFolder(entry: FolderEntry) {
		return defineMutation({
			mutationKey: notesKeys.delete(entry.path),
			mutationFn: async (): Promise<
				Result<undefined, WriteError | FileError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				// Writes running now land first, so the listing says where each
				// note is.
				await writesSettled();
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
					if (note.row.fields.folderId !== id) continue;
					const refusal = patchNote(note.path, { folderId: null });
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
				return folder.tables.folders.delete(entry.stem);
			},
			onSuccess: () => {
				deleted(entry.path);
				if (view.folderId === entry.stem) view = { ...view, folderId: null };
				return changed(entry.path);
			},
		})();
	}

	/**
	 * Rename a file within its folder. A row renames through its table by
	 * stem, unless it is open as text; any other file moves as exact bytes.
	 * It waits for the file's saves to land and moves what the file holds
	 * then. Edits of the file wait meanwhile.
	 */
	function rename(path: string, name: string) {
		const directory = dirname(path);
		const to = joinPath(directory, name);
		return defineMutation({
			mutationKey: notesKeys.move(path),
			mutationFn: async (): Promise<
				Result<
					Written | WrittenRow<unknown> | undefined,
					WriteError | NotesError
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
				// A close that began meanwhile stops the move.
				if (at !== undefined && nextStem !== undefined && !asText(path)) {
					const late = refused();
					if (late !== undefined)
						return NotesError.NotStarted({ reason: late });
					return at.rows.table.rename(at.stem, nextStem);
				}
				const late = refused();
				if (late !== undefined) return NotesError.NotStarted({ reason: late });
				return folder.move(path, to);
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
	 * what this app saved last goes with it, and deletes the file whatever
	 * another program changed in it since: the deleter wins (ADR-0576).
	 */
	function deleteConfirmed(deletion: Deletion) {
		return defineMutation({
			mutationKey: notesKeys.delete(deletion.path),
			mutationFn: async (): Promise<
				Result<unknown, FileError | WriteError | NotesError>
			> => {
				const why = refused();
				if (why !== undefined) return NotesError.NotStarted({ reason: why });
				if (deletion.kind === 'folder')
					return folder.files.rmdir(deletion.path);
				await settledAt(deletion.path);
				return folder.write(deletion.path, null, null);
			},
			onSuccess: () => {
				deleted(deletion.path);
				return changed(deletion.path);
			},
		})();
	}

	return {
		/** The opened folder; `close` releases it. */
		folder,
		queryClient,
		/** The folder's query and mutation options; views read through these. */
		folder$,
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
					await settledAt(path);
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

		/** Whether a save of a row or a file's text is running, or typing waits to be sent. */
		get saving() {
			return saving();
		},
		/** Whether a document typed holds text whose save failed and that no save is running for. */
		get unsaved() {
			return typedDrafts().some(failed);
		},
		/** Whether anything is saving or mutating: a save or an action. */
		get busy() {
			trackMutations();
			return saving() || queryClient.isMutating() > 0;
		},
		/** How many mutations match `filters`. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a write of `path` is running, or typing there waits to be sent. */
		isWriting(path: string) {
			trackMutations();
			const stem = noteIdOf(path);
			return (
				writing(path) ||
				[
					stem === undefined ? undefined : bodies.get(stem),
					textDrafts.get(path),
				].some(
					(typed) =>
						typed !== undefined &&
						(typed.draft.saving ||
							(typed.later.pending && typed.typed() !== undefined)),
				)
			);
		},
		/** Whether the body typed at `path` did not save, with no save running. */
		isUnsaved(path: string) {
			const stem = noteIdOf(path);
			const typed = stem === undefined ? undefined : bodies.get(stem);
			return typed !== undefined && failed(typed);
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
		 * The set a view sends a field typed into a note with: `{ stem, fields }`,
		 * set on the note as its file is now. Ask `refusalAt` first.
		 */
		setNote: noteRows.setRow,
		/** Why the note at `path` takes no set or body now, if it does not. */
		refusalAt(path: string): string | undefined {
			const stem = noteIdOf(path);
			return stem === undefined ? NOT_LISTED : noteRows.refusalAt(stem);
		},
		/**
		 * Type `body` as the note's body; it saves a second after the last
		 * change, or at once with `saveBody`. Answers why not, if not.
		 */
		editBody,
		/** Send the body typed at `path` now, as leaving it does; resolves once no save of it runs. */
		saveBody(path: string): Promise<void> {
			const stem = noteIdOf(path);
			return stem === undefined ? Promise.resolve() : saveBodyOf(stem);
		},
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
					trackMutations();
					return lockedAt(path);
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
			if (refused() !== undefined) return;
			const stem = noteIdOf(path);
			if (stem !== undefined) void bodies.get(stem)?.draft.save();
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
			return folderRows.set(stem, fields);
		},
		/** The text typed into `path` and not yet written, read reactively. */
		typedText(path: string): string | undefined {
			return textDrafts.get(path)?.draft.typed;
		},
		/**
		 * Type `text` as the whole text of `path`; it is written a second after
		 * the last change, or at once with `saveText`. Answers whether the
		 * change was taken.
		 */
		editText(path: string, text: string): boolean {
			if (refused() !== undefined || moving(path)) return false;
			if (shownText(path) === undefined) return false;
			const typed = textDraftOf(path);
			typed.draft.change(text);
			void typed.later();
			return true;
		},
		/** Write the text typed into `path` now, as leaving it does; resolves once no write of it runs. */
		saveText: (path: string) => saveTyped(textDrafts, path),

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
			const { error } = await folder.files.read(path);
			if (error !== null) return Err(describeError(error));
			const status = await queryClient
				.fetchQuery(folder$.history.status.queryOptions())
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
				stopDeletedBodies();
				await queryClient.cancelQueries({ queryKey: folder$.key });
				await folder.close();
			})();
			return closing;
		},
	};
}
