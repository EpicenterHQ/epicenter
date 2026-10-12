/**
 * The Honeycrisp product state over one opened notes folder.
 *
 * Three listings refresh together: the note rows, the folder rows, and the
 * file listing the file browser shows. They are read when the page opens,
 * after each of the app's own actions and terminal commands, and when the
 * person returns to the window. The latest refresh wins. The note list
 * offers the rows that read as notes and names the rest, with why, for
 * repair as text.
 *
 * One item is open at a time, in the shared open-item slot
 * (`@epicenter/svelte/open-item`), keyed by its path and how it opens. A
 * note opened from the list is a row session over its fields and body; any
 * other text file, a note whose text is not a valid row, or a note opened as
 * its file, is a text session over its exact text. Leaving an item waits for
 * its saves, then releases its session and lists again. A save that failed or
 * conflicted keeps the item open until the person discards the draft (`open`
 * answers `unsaved` with that session, and the view asks). Opening the item
 * already open, the way it is open, does nothing.
 *
 * Every save is guarded by the bytes the session last saved, so a change
 * made elsewhere is a conflict the person resolves: Reload theirs or Keep
 * mine. Returning to the window never replaces an open note's draft, so its
 * rich-text undo history survives; the next save reports the change.
 *
 * A field change from a list (pin, folder, Recently Deleted, a folder's
 * name) goes into the open note's draft when that note is open, and is
 * otherwise a guarded `replace` of the row the list read.
 */
import type {
	AutosaveError,
	FileCapture,
	FileError,
	FileListing,
	MoveError,
	RowReadError,
	StoredRow,
	TableError,
} from '@epicenter/folder';
import { parseRow, rowPath } from '@epicenter/folder';
import {
	ancestorsOf,
	basename,
	dirname,
	joinPath,
} from '@epicenter/folder/file-browser';
import { createAdmissions } from '@epicenter/svelte/admissions';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { createOpenItem, type Opening } from '@epicenter/svelte/open-item';
import { createTerminalSession } from '@epicenter/svelte/terminal-session';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
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
import { nameProblem, readTextFile } from './files.js';
import { displayTitle } from './note-source.js';
import type { NotesHost } from './platform/types.js';

const log = createLogger('honeycrisp');

export type Notes = ReturnType<typeof createNotes>;

/** How a path opens: as the note it is, or as its exact text. */
export type OpenAs = 'note' | 'text';

/** The open item's edit session: a note's row, or a file's text. */
export type Session = RowSession<NoteFields> | TextSession;

/** What a path loads as. */
type Item =
	| { readonly kind: 'note'; readonly session: RowSession<NoteFields> }
	| { readonly kind: 'text'; readonly session: TextSession }
	| { readonly kind: 'failed'; readonly path: string; readonly message: string }
	| {
			readonly kind: 'binary' | 'tooLarge';
			readonly path: string;
			readonly size: number;
	  };

/** The one open item, or the path still loading: what the detail shows. */
export type Opened = Item | { readonly kind: 'loading'; readonly path: string };

/**
 * The open-item key: a path, and how it opens. A key asked without `as`
 * opens a note as a note when its text reads as one. `reread` marks the key
 * of an item shown without a session (failed, binary, too large): no open
 * matches it, so opening it again reads it again.
 */
type Key = {
	readonly path: string;
	readonly as: OpenAs | undefined;
	readonly reread?: true;
};

/**
 * The key `item` is shown under now: its session's path, which follows a
 * rename, and the way it opened, which for a note whose text is not a valid
 * row is text.
 */
function keyOf(item: Item): Key {
	if (item.kind === 'note' || item.kind === 'text')
		return { path: item.session.path, as: item.kind };
	return { path: item.path, as: undefined, reread: true };
}

/**
 * Whether opening `key` would show `shown` again. A path asked without `as`
 * matches however the item opened.
 */
function sameKey(shown: Key, key: Key): boolean {
	return (
		shown.reread !== true &&
		shown.path === key.path &&
		(key.as === undefined || key.as === shown.as)
	);
}

/** A listed file the lists cannot show as a row, and why. */
export type Problem = { readonly path: string; readonly message: string };

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| (FileCapture & {
			readonly kind: 'file';
			/** The note's name, when the file is a note that reads as one. */
			readonly title: string | undefined;
	  })
	| { readonly kind: 'folder'; readonly path: string };

const CLOSING = 'The app is closing, so nothing was changed.';
const BUSY =
	'A change to this note is still running. Try again when it finishes.';
const OPEN_AS_TEXT =
	'This note is open as a file. Open it as a note to change it here.';
const GONE = 'This file is no longer in the folder.';
/** Why a new note did not open: the open one holds changes it could not save. */
const UNSAVED_STAYS =
	'It was added, but the open note has changes that are not saved, so it stays open.';
const FOLDERS = 'folders';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

/** The path an open item is at. */
export function pathOf(item: Opened): string {
	return item.kind === 'note' || item.kind === 'text'
		? item.session.path
		: item.path;
}

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A refusal changed nothing, a move that kept its source left both
 * files, and a lost reply leaves the outcome unknown.
 */
export function describeError(
	error:
		| FileError
		| MoveError
		| TableError
		| AutosaveError
		| { readonly name: string; readonly message: string },
): string {
	// A session's own refusals are named failures with a message of their own.
	const known = error as FileError | MoveError | TableError;
	switch (known.name) {
		case 'Exists':
			return `"${basename(known.path)}" already exists here.`;
		case 'Conflict':
			return known.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Check it and try again.';
		case 'DirectoryNotEmpty':
			return 'The folder is not empty, so nothing was deleted.';
		case 'SourceNotRemoved':
			return `The file was copied to ${known.to}, but ${known.from} could not be removed, so the folder now has both. Delete whichever you do not want.`;
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${known.message}`;
		case 'InvalidValues':
			return known.issues.map((issue) => issue.message).join(' ');
		case 'NotFound':
			return GONE;
		default:
			return known.message;
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

/**
 * One table listing: the rows that read, the files whose text is not
 * a valid row (each opens as text for repair), and the files that cannot be
 * read as text at all.
 */
function split<TFields>(
	table: string,
	listing: readonly {
		stem: string;
		result: Result<StoredRow<TFields>, RowReadError>;
	}[],
) {
	const rows: (StoredRow<TFields> & { stem: string })[] = [];
	const repairs: Problem[] = [];
	const unreadable: Problem[] = [];
	for (const { stem, result } of listing) {
		if (result.error === null) rows.push({ ...result.data, stem });
		else {
			const problem = problemOf(rowPath(table, stem), result.error);
			if (result.error.name === 'InvalidRow') repairs.push(problem);
			else unreadable.push(problem);
		}
	}
	return { rows, repairs, unreadable };
}

export function createNotes(host: NotesHost) {
	const { folder } = host;
	const notesTable = folder.tables.notes;
	const foldersTable = folder.tables.folders;

	let notes = $state.raw<NoteEntry[]>([]);
	let folders = $state.raw<FolderEntry[]>([]);
	/** Note files that do not read as notes but are text: each opens for repair. */
	let repairs = $state.raw<Problem[]>([]);
	/** Note files that are not text, and folder files that do not read as folders. */
	let unreadable = $state.raw<Problem[]>([]);
	/** Every note file in the last listing, note or not. */
	let notePaths = $state.raw<ReadonlySet<string>>(new Set());
	let listError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	/** Bumped when a note is opened, so its editor takes focus. */
	let focusRequest = $state(0);
	/** Which notes the list shows. */
	let view = $state<{
		folderId: string | null;
		deleted: boolean;
		query: string;
	}>({ folderId: null, deleted: false, query: '' });
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([NOTES]);
	let refreshSequence = 0;
	/** Set once `close` begins. Nothing opens or changes after it. */
	let closing: Promise<void> | undefined;
	/** Set once the folder is being released: nothing reads it after. */
	let released = false;
	/** Actions admitted and not finished; `close` waits for them. */
	const admissions = createAdmissions();

	/** Whether the open item refuses input now. */
	const locked = () => closing !== undefined;

	/** Why no action starts now, if one does not. */
	const refused = () => (locked() ? CLOSING : undefined);

	function sessionOf(item: Item): Session | undefined {
		return item.kind === 'note' || item.kind === 'text'
			? item.session
			: undefined;
	}

	const slot = createOpenItem<Key, Item, Session>({
		load,
		sessionOf,
		keyOf,
		sameKey,
		closed: () => closing !== undefined,
	});

	/** What the detail shows; one object per load, so the view can key on it. */
	const opened = $derived.by((): Opened | undefined => {
		const shown = slot.shown;
		if (shown === undefined) return undefined;
		return shown.status === 'open'
			? shown.item
			: { kind: 'loading', path: shown.key.path };
	});

	/** The open note's session when `path` is open as a note. */
	function noteAt(path: string) {
		const item = slot.item;
		return item?.kind === 'note' && item.session.path === path
			? item.session
			: undefined;
	}

	const terminal = createTerminalSession({
		terminal: host.terminal,
		afterRun: check,
		locked,
	});

	/**
	 * One listing pass. A pass that a newer one overtook, or that answers
	 * after the folder was released, changes nothing. An action a close is
	 * waiting for still lists until then.
	 */
	async function refresh() {
		if (released) return;
		const sequence = ++refreshSequence;
		const [noteRows, folderRows, files] = await Promise.all([
			notesTable.list(),
			foldersTable.list(),
			folder.files.list(),
		]);
		if (released || sequence !== refreshSequence) return;
		const folderList =
			folderRows.error === null
				? split<FolderFields>(FOLDERS, folderRows.data)
				: undefined;
		if (noteRows.error !== null) {
			// Keep the previous list visible; never show an empty list for a failed read.
			listError = noteRows.error.message;
		} else {
			const noteList = split<NoteFields>(NOTES, noteRows.data);
			listError = undefined;
			notes = noteList.rows;
			repairs = noteList.repairs;
			unreadable = [
				...noteList.unreadable,
				...(folderList
					? [...folderList.repairs, ...folderList.unreadable]
					: []),
			];
			notePaths = new Set(
				noteRows.data.map(({ stem }) => rowPath(NOTES, stem)),
			);
		}
		if (folderList !== undefined) folders = folderList.rows;
		if (files.error !== null) listingError = files.error.message;
		else {
			listingError = undefined;
			listing = files.data;
		}
	}

	/** The listings and Git status: the person's "Check again", and returning to the window. */
	async function check() {
		if (closing !== undefined) return;
		await Promise.all([
			refresh(),
			folder.git.status().catch(() => undefined),
			slot.adopt(),
		]);
	}

	function openNote(stored: StoredRow<NoteFields>): Item {
		return {
			kind: 'note',
			session: createRowSession(notesTable, stored, { locked }),
		};
	}

	function openText(file: FileCapture & { text: string }): Item {
		return {
			kind: 'text',
			session: createTextSession(folder.files, file, { locked }),
		};
	}

	/** Read `key.path` the way it opens: a note as a row unless `key.as` says text. */
	async function load({ path, as }: Key): Promise<Item> {
		const stem = noteIdOf(path);
		if (stem !== undefined && as !== 'text') {
			const { data: stored, error } = await notesTable.get(stem);
			// A note whose text is not a valid row is repaired as text.
			if (error?.name === 'InvalidRow') return openText(error);
			if (error !== null)
				return {
					kind: 'failed',
					path,
					message: problemOf(path, error).message,
				};
			if (stored === undefined) return { kind: 'failed', path, message: GONE };
			return openNote(stored);
		}
		const { data: read, error } = await readTextFile(folder.files, path);
		if (error !== null)
			return { kind: 'failed', path, message: describeError(error) };
		if (read.kind !== 'text') return { ...read, path };
		return openText(read.file);
	}

	/**
	 * Show `path`: a note as its fields and body, unless `as` asks for its
	 * text; any other file as its text. The open item's saves land first, and
	 * the listings are read again. Opening the item already open, the way it
	 * is open, changes nothing. Answers `unsaved`, opening nothing, when the
	 * open item holds a draft it could not save; the view asks the person,
	 * and `discard` names the session whose draft they chose to let go.
	 */
	async function open(
		path: string,
		{ as, discard }: { as?: OpenAs; discard?: Session } = {},
	): Promise<Opening<Session>> {
		focusRequest += 1;
		const opening = await slot.open({ path, as }, { discard });
		if (opening.kind !== 'done') return opening;
		if (opening.left) void refresh();
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		return opening;
	}

	/** The capture a deletion or rename of a closed file acts on: the file as it is now. */
	async function captureNow(
		path: string,
	): Promise<Result<FileCapture, FileError>> {
		const { data: read, error } = await folder.files.read(path);
		if (error !== null) return Err(error);
		return Ok({ path: read.path, sha256: read.sha256 });
	}

	/** The open item's save problem, if it has one. */
	function saveError() {
		const state = slot.session?.state;
		return state?.status === 'error' ? state.error : undefined;
	}

	/** The fields the lists show for `entry`: the open draft's when it is open. */
	function fieldsOf(entry: NoteEntry): NoteFields {
		return noteAt(entry.path)?.draft.fields ?? entry.row.fields;
	}

	/**
	 * Change a note's fields. The open note takes the change as an edit to
	 * its draft. A closed note is replaced, guarded by the version the list
	 * read: one that changed since is refused, and the list reads it again.
	 */
	const changeNote = admissions.command(async function changeNote(
		path: string,
		fields: Partial<NoteFields>,
	): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		const session = noteAt(path);
		if (session !== undefined) {
			if (session.locked) return BUSY;
			session.edit((row) => {
				Object.assign(row.fields, fields);
			});
			return undefined;
		}
		const item = slot.item;
		if (item?.kind === 'text' && item.session.path === path)
			return OPEN_AS_TEXT;
		const entry = notes.find((note) => note.path === path);
		if (entry === undefined)
			return 'This note is not in the list as last read. Check again and retry.';
		const { error } = await notesTable.replace(entry, {
			fields: { ...entry.row.fields, ...fields },
			body: entry.row.body,
		});
		await refresh();
		return error === null ? undefined : describeError(error);
	});

	/**
	 * Delete `file`. The open item's session is released first and its last
	 * saves land, so the delete removes what this app saved last; a file
	 * another program changed since is refused, and the open item shows the
	 * file again as it is now, in a new session.
	 */
	const removeFile = admissions.command(
		async (file: FileCapture): Promise<string | undefined> => {
			const session = slot.session;
			const removed =
				session?.path === file.path
					? await slot.removeOpen(session, (capture) =>
							folder.files.remove(capture),
						)
					: await folder.files.remove(file);
			const error = removed?.error ?? null;
			// An item shown without a session (binary, too large) closes with its file.
			if (
				error === null &&
				opened !== undefined &&
				pathOf(opened) === file.path
			)
				slot.forget();
			await refresh();
			return error === null ? undefined : describeError(error);
		},
	);

	/** Delete a folder after moving its notes out; see `deleteFolder` below. */
	async function deleteFolder(entry: FolderEntry): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		if (listError !== undefined)
			return `The notes could not be listed, so it is not known which are in this folder: ${listError}`;
		const unknown = [
			...repairs,
			...unreadable.filter((problem) => noteIdOf(problem.path) !== undefined),
		];
		if (unknown.length > 0)
			return `Some notes cannot be read well enough to tell which folder they are in (${unknown
				.slice(0, 3)
				.map((problem) => basename(problem.path))
				.join(', ')}). Repair or remove them first.`;
		const id = entry.stem;
		const members = () =>
			notes.filter((note) => fieldsOf(note).folderId === id);
		for (const note of members()) {
			const problem = await changeNote(note.path, { folderId: null });
			if (problem !== undefined)
				return `A note could not be moved out of the folder: ${problem}`;
		}
		const settled = await slot.session?.settled();
		if (settled?.status === 'error')
			return 'The open note could not be saved outside the folder, so the folder was kept.';
		await refresh();
		const remaining = members();
		if (remaining.length > 0)
			return `Some notes were put in this folder while it was being deleted (${remaining
				.slice(0, 3)
				.map((note) => basename(note.path))
				.join(', ')}). Delete it again to move them out.`;
		const listed = folders.find((item) => item.path === entry.path) ?? entry;
		const problem = await removeFile(listed);
		if (problem !== undefined) return problem;
		if (view.folderId === id) view = { ...view, folderId: null };
		return undefined;
	}

	return {
		host,
		terminal,
		/** Rows that read as notes, as last listed. */
		get notes() {
			return notes;
		},
		/** Rows that read as folders, as last listed. */
		get folders() {
			return folders;
		},
		/** Note files whose text does not read as a note; each opens as text for repair. */
		get repairs() {
			return repairs;
		},
		/** Note files that are not text, and folder files that do not read as folders. */
		get unreadable() {
			return unreadable;
		},
		get listError() {
			return listError;
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
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
		/** The open item, or `undefined`. */
		get opened() {
			return opened;
		},
		/** The open item's path. */
		get selectedPath() {
			return opened && pathOf(opened);
		},
		get focusRequest() {
			return focusRequest;
		},
		/** Whether `path` is a note file, whether or not its text reads as a note. */
		isNote(path: string) {
			return notePaths.has(path);
		},
		fieldsOf,
		/** The open note's session when `path` is open as a note. */
		noteAt,
		/** 1 while the open item has a save running or a draft it could not save, or an action runs. */
		get unsettled() {
			return slot.unsaved || admissions.busy ? 1 : 0;
		},
		get saving() {
			return slot.session?.state.status === 'saving' || admissions.busy;
		},
		/** 1 when the open item's draft is known not to be in its file. */
		get notSaved() {
			const error = saveError();
			return error !== undefined && error.name !== 'Unconfirmed' ? 1 : 0;
		},
		/** 1 when the open item's last save may or may not have landed. */
		get unconfirmed() {
			return saveError()?.name === 'Unconfirmed' ? 1 : 0;
		},
		refresh,
		check,
		open,
		/**
		 * Reload theirs for `session`, the open item's: show the file as it is
		 * now. A file that is gone closes; one that no longer reads the way it
		 * opened (a note whose text is not a valid row, a file that is no
		 * longer text) opens again as what it is now. Answers what the person
		 * is told, if anything.
		 */
		reloadTheirs: admissions.command(
			async (session: Session): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const reloaded = await slot.reloadTheirs(session);
				if (reloaded === undefined) return undefined;
				if (reloaded.error !== null) return describeError(reloaded.error);
				await refresh();
				return undefined;
			},
		),
		/** Keep mine for `session`, the open item's: save the draft over the file, or create it again. */
		keepMine: admissions.command(
			async (session: Session): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const kept = await slot.keepMine(session);
				if (kept === undefined) return undefined;
				await refresh();
				return kept.error === null ? undefined : describeError(kept.error);
			},
		),
		/** Discard the open item's draft and close it. Nothing is written. */
		discard() {
			slot.forget();
		},
		/** Create a note in the folder being shown and open it. */
		createNote: admissions.command(async (): Promise<string | undefined> => {
			const why = refused();
			if (why !== undefined) return why;
			const at = now();
			const { data: created, error } = await notesTable.create(
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
			if (error !== null) return describeError(error);
			await refresh();
			return (await open(created.path)).kind === 'unsaved'
				? UNSAVED_STAYS
				: undefined;
		}),
		/** Change a note's fields from the list: in its draft when it is open, else guarded by what was listed. */
		patchNote: changeNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) => changeNote(path, { deletedAt: now() }),
		restoreNote: (path: string) => changeNote(path, { deletedAt: null }),
		createFolder: admissions.command(
			async (name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const { error } = await foldersTable.create(
					{ fields: { name, icon: null }, body: '' },
					{ stem: newId() },
				);
				await refresh();
				return error === null ? undefined : describeError(error);
			},
		),
		/** Change a folder's fields, guarded by the version the list read. */
		patchFolder: admissions.command(
			async (
				entry: FolderEntry,
				fields: Partial<FolderFields>,
			): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				if (slot.session?.path === entry.path)
					return 'This folder is open as a file. Change it there, or close it first.';
				const { error } = await foldersTable.replace(entry, {
					fields: { ...entry.row.fields, ...fields },
					body: entry.row.body,
				});
				await refresh();
				return error === null ? undefined : describeError(error);
			},
		),
		/**
		 * Delete a folder after moving its notes out. It is refused while any
		 * note cannot say which folder it is in. Each note moves through its
		 * draft when open, else guarded by what was listed, so a move made
		 * elsewhere is not undone. The folder is read again before its file
		 * goes. This is not one atomic step: a note already moved out stays
		 * moved out if the delete stops, and another program can still put a
		 * note in the folder after the last read.
		 */
		deleteFolder: admissions.command(deleteFolder),
		/**
		 * Put a committed version of a note in its draft, which saves it: the
		 * version's fields over the draft's, and its body. A version that does
		 * not read as a note is refused.
		 */
		useVersion(
			session: RowSession<NoteFields>,
			source: string,
		): string | undefined {
			const why = refused();
			if (why !== undefined) return why;
			if (session.locked) return BUSY;
			const { data: version, error } = parseRow(
				honeycrispDefinition.tables.notes,
				source,
			);
			if (error !== null)
				return `This version does not read as a note (${error[0].message}). Use Edit as file to change the text by hand.`;
			session.edit((row) => ({
				fields: { ...row.fields, ...version.fields },
				body: version.body,
			}));
			return undefined;
		},
		/**
		 * Rename a file within its folder. The open item waits for its saves and
		 * moves from what its last save confirmed; a closed file moves from what
		 * it holds now. A note keeps its .md extension.
		 */
		rename: admissions.command(
			async (path: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const directory = dirname(path);
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const to = joinPath(directory, name);
				if (to === path) return undefined;
				if (notePaths.has(path) && noteIdOf(to) === undefined)
					return 'A note file keeps its .md extension.';
				const item = slot.item;
				const session = slot.session;
				let moved: Result<unknown, Parameters<typeof describeError>[0]>;
				if (
					item?.kind === 'note' &&
					item.session.path === path &&
					noteIdOf(to) === undefined
				)
					moved = Err({
						name: 'Refused',
						message: 'A note file keeps its .md extension.',
					});
				else if (session?.path === path)
					moved = await session.rename((file) => folder.files.move(file, to));
				else {
					const { data: file, error } = await captureNow(path);
					if (error !== null) moved = Err(error);
					// A close that began during the read stops the move.
					else if (refused() !== undefined)
						moved = Err({ name: 'Closing', message: CLOSING });
					else moved = await folder.files.move(file, to);
				}
				await refresh();
				return moved.error === null ? undefined : describeError(moved.error);
			},
		),
		/** A new empty text file; it never replaces an existing one. */
		createFile: admissions.command(
			async (directory: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				const { error } = await folder.files.create(path, '');
				if (error !== null) return describeError(error);
				await refresh();
				return (await open(path, { as: 'text' })).kind === 'unsaved'
					? UNSAVED_STAYS
					: undefined;
			},
		),
		createDirectory: admissions.command(async function createDirectory(
			directory: string,
			name: string,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (
				listing?.directories.includes(path) ||
				listing?.files.some((file) => file.path === path)
			)
				return `"${name}" already exists here.`;
			const { error } = await folder.files.mkdir(path);
			if (error !== null) return describeError(error);
			if (directory !== '') expanded.add(directory);
			await refresh();
			return undefined;
		}),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * An open item's saves land first. Only empty folders can be deleted.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
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
			const session = slot.session;
			const listed = notes.find((note) => note.path === path);
			let file: FileCapture;
			if (session?.path === path) file = (await session.settled()).file;
			else if (listed !== undefined) file = listed;
			else {
				const { data, error } = await captureNow(path);
				if (error !== null) return Err(describeError(error));
				file = data;
			}
			const row = noteAt(path)?.draft ?? listed?.row;
			return Ok({
				kind: 'file',
				path: file.path,
				sha256: file.sha256,
				title: row && displayTitle(row.fields.title, row.body),
			});
		},
		/** Delete what was confirmed; a file that changed since is refused. */
		remove: admissions.command(
			async (deletion: Deletion): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				if (deletion.kind === 'file') return removeFile(deletion);
				const { error } = await folder.files.rmdir(deletion.path);
				await refresh();
				return error === null ? undefined : describeError(error);
			},
		),
		/** Commit the saved files now. Unsaved drafts are not included. */
		commitNow: (): ReturnType<typeof folder.git.commit> =>
			locked()
				? Promise.resolve({ status: 'blocked', reason: CLOSING })
				: admissions.admit(() => folder.git.commit()),
		/**
		 * Refuse input for good, let running actions and the open item's saves
		 * finish, and release the folder. A draft that could not save ends with
		 * the page. A second call returns the same promise.
		 */
		close(): Promise<void> {
			closing ??= (async () => {
				await admissions.quiet();
				const unsaved = await slot.close();
				if (unsaved !== undefined)
					log.warn(
						new Error(
							`Closed with a draft that could not be saved, in ${unsaved}`,
						),
					);
				released = true;
				await host.close();
			})();
			return closing;
		},
	};
}
