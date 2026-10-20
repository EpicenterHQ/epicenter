/**
 * The Honeycrisp product state over this browser's local folder
 * (`openFolder({ tables: honeycrispTables })`), as `getFolder()`
 * answers it: the rows read through its query cache, and every write.
 *
 * Reads are queries. The note and folder rows are the context's
 * (`queries.rows`); the shared context also owns the file listing and generated file keys.
 * This module defines how source text is decoded. The context refreshes
 * changed paths and polls visible reads; it owns the only change listener.
 *
 * A note's title, folder, pin, and body, a list action on any note, and a
 * folder's name are the row's draft in the context's edit layer
 * (`edits.row`): what is typed shows at once, saves a second after the last
 * change or at once when the view leaves it, keeps on screen when a save
 * fails, and merges with whatever was saved meanwhile. A file open as its
 * exact text (Edit as file, repair, any other file) uses `edits.text`.
 * Row patches and exact text share one save queue and deletion fence per path.
 *
 * Create, delete, and deleting a folder are actions. The folder keeps no
 * history and has no rename or move, so Honeycrisp offers neither.
 */
import { textRead, type FileRead } from './file-reads.js';
import { InstantString } from '@epicenter/definition';
import { ancestors, joinPath } from '@epicenter/folder/file-browser';
import { CLOSING, DELETING } from '@epicenter/svelte/edits';
import type { FolderContext } from '@epicenter/svelte/folder';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	FOLDERS,
	type FolderEntry,
	type FolderFields,
	type FolderRow,
	folderIdOf,
	type HoneycrispTables,
	NOTES,
	type NoteEntry,
	type NoteFields,
	type NoteRow,
	noteIdOf,
	rowFile,
	type TableName,
} from './data.js';
import type { NoteBody } from './editor/rich-text.js';
import { nameProblem } from './files.js';
import { displayTitle } from './note-source.js';
import { describeFailure, saveLine } from './status.js';

export type Notes = ReturnType<typeof createNotes>;

/** The opened local folder, as `getFolder()` answers it. */
export type NotesFolder = FolderContext<HoneycrispTables>;

/** How a path opens: as the note it is, or as its exact text. */
export type OpenAs = 'note' | 'text';

/** What the detail shows. `id` names one opening, so the view mounts once per opening. */
export type Selection = {
	readonly path: string;
	readonly as: OpenAs;
	readonly id: number;
};

/** A listed row file the lists cannot show as a row, and why. */
export type Problem = { readonly path: string; readonly message: string };

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion = {
	readonly path: string;
	/** The note's name, when the file is a note that reads as one. */
	readonly title: string | undefined;
};

const OPEN_AS_TEXT =
	'This file is open as text. Change it there, or open it as a note.';
const NOT_LISTED = 'This file is not in the list, so nothing was changed.';
const NOT_A_NOTE =
	'This file does not read as a note. Repair it as text first.';
const KEPT =
	'It changed while it was being deleted, here or in another tab, so it was kept.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

const reasonOf = (row: { issues: readonly { message: string }[] }) =>
	row.issues.map((issue) => issue.message).join(' ');

const notText = (row: NoteRow | FolderRow) =>
	row.issues?.some((issue) => issue.kind === 'not-text') ?? false;

/** The note rows that read as notes. */
export const notesOf = (rows: NoteRow[]): NoteEntry[] =>
	rows.filter((row): row is NoteEntry => row.issues === null);
/** The folder rows that read as folders. */
export const foldersOf = (rows: FolderRow[]): FolderEntry[] =>
	rows.filter((row): row is FolderEntry => row.issues === null);

/** Note files whose text does not read as a note: each opens as text for repair. */
export function repairsOf(rows: NoteRow[]): Problem[] {
	return rows.flatMap((row) =>
		row.issues === null || notText(row)
			? []
			: [{ path: rowFile(NOTES, row.id), message: reasonOf(row) }],
	);
}

/** Note files that are not text, and folder files that do not read as folders. */
export function unreadableOf(
	notes: NoteRow[] | undefined,
	folders: FolderRow[] | undefined,
): Problem[] {
	return [
		...(notes ?? []).flatMap((row) =>
			row.issues !== null && notText(row)
				? [{ path: rowFile(NOTES, row.id), message: reasonOf(row) }]
				: [],
		),
		...(folders ?? []).flatMap((row) =>
			row.issues === null
				? []
				: [{ path: rowFile(FOLDERS, row.id), message: reasonOf(row) }],
		),
	];
}

/** The row table `path` is in, and its id, if it is a row file. */
function rowAt(path: string): { table: TableName; id: string } | undefined {
	const note = noteIdOf(path);
	if (note !== undefined) return { table: NOTES, id: note };
	const folder = folderIdOf(path);
	if (folder !== undefined) return { table: FOLDERS, id: folder };
	return undefined;
}

export function createNotes(local: NotesFolder) {
	const { folder, queryClient, edits } = local;
	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe((event) => {
			if (
				event.type === 'added' ||
				event.type === 'removed' ||
				event.type === 'updated'
			)
				update();
		}),
	);

	const textAt = (path: string) => edits.text(path);
	const rowsKey = (table: TableName) => local.queries.rows(table).queryKey;

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

	/** Whether `path` is open as its exact text, so its text is what saves. */
	const asText = (path: string) =>
		selected?.path === path && selected.as === 'text';

	/** One table's rows, as the cache holds them now. */
	function rowsOf(table: typeof NOTES): NoteRow[] | undefined;
	function rowsOf(table: typeof FOLDERS): FolderRow[] | undefined;
	function rowsOf(table: TableName) {
		return queryClient.getQueryData<NoteRow[] | FolderRow[]>(rowsKey(table));
	}

	/** The note the cache holds for `id`, if it reads as one. */
	function storedNote(id: string): NoteEntry | undefined {
		const row = rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		return row?.issues === null ? row : undefined;
	}

	/** The folder the cache holds for `id`, if it reads as one. */
	function storedFolder(id: string): FolderEntry | undefined {
		const row = rowsOf(FOLDERS)?.find((candidate) => candidate.id === id);
		return row?.issues === null ? row : undefined;
	}

	/** Why a file refuses a structured change: closing, whole-file input, or deletion. */
	function mutationRefusal(path: string): string | undefined {
		if (edits.fenced) return CLOSING;
		if (asText(path) || textAt(path).held) return OPEN_AS_TEXT;
		if (textAt(path).locked) return DELETING;
		return undefined;
	}

	function noteRefusal(id: string): string | undefined {
		const why = mutationRefusal(rowFile(NOTES, id));
		if (why !== undefined) return why;
		const row = rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		if (row === undefined) return NOT_LISTED;
		if (row.issues !== null) return NOT_A_NOTE;
		return undefined;
	}

	/**
	 * Type `change` into the note at `path`, as the cache holds it. Answers
	 * why it was refused, changing nothing, if it was.
	 */
	function changeNote(
		path: string,
		change: { fields?: Partial<NoteFields>; body?: string },
	): string | undefined {
		const id = noteIdOf(path);
		if (id === undefined) return NOT_LISTED;
		const why = noteRefusal(id);
		if (why !== undefined) return why;
		const stored = storedNote(id);
		if (stored === undefined) return NOT_LISTED;
		return edits.row(NOTES, id).change(stored, change) ? undefined : CLOSING;
	}

	/**
	 * Set fields of a note and save at once: pin, move to a folder, trash,
	 * restore. Each keeps every field another writer changed.
	 */
	function patchNote(path: string, fields: Partial<NoteFields>) {
		const why = changeNote(path, { fields });
		if (why === undefined) void saveRow(path);
		return why;
	}

	/** Send the row typed at `path` now, as leaving it does. */
	function saveRow(path: string): Promise<void> {
		const at = rowAt(path);
		return at === undefined
			? Promise.resolve()
			: edits.row(at.table, at.id).save();
	}

	/** Give a refused action its app-level reason even after the context closes. */
	function runAction(action: () => Promise<string | undefined>) {
		return edits.fenced ? Promise.resolve(CLOSING) : local.run(action);
	}

	// ------------------------------------------------------------------
	// Opening
	// ------------------------------------------------------------------

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		if (textAt(path).held) return 'text';
		const id = noteIdOf(path);
		if (id === undefined) return 'text';
		const row = rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		return row === undefined || row.issues === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. Opening never waits, writes, or asks. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as, id: ++openings };
	}

	/** After a delete: the open item lets the file go. */
	function deleted(path: string) {
		if (selected?.path === path) selected = undefined;
	}

	/** Why a file named `name` in `directory` cannot be made, if it cannot. */
	function placeProblem(directory: string, name: string) {
		const why =
			(edits.fenced ? CLOSING : undefined) ?? nameProblem(directory, name);
		if (why !== undefined) return why;
		const path = joinPath(directory, name);
		const paths =
			queryClient.getQueryData<string[]>(local.queries.files().queryKey) ?? [];
		if (paths.some((file) => file === path || file.startsWith(`${path}/`)))
			return `"${name}" already exists here.`;
		return undefined;
	}

	/**
	 * Delete a folder after moving its notes out. Refused while any note
	 * cannot say which folder it is in. What is typed lands first; each note
	 * then moves out as a list action does; the notes are read again, and
	 * the folder's file goes only when none is still in it. Not one atomic
	 * step: a note already moved out stays moved out if the delete stops,
	 * and another tab can still put a note in the folder after the last read.
	 */
	async function deleteFolder(entry: FolderEntry): Promise<string | undefined> {
		if (edits.fenced) return CLOSING;
		await edits.settled(NOTES);
		const listed = await folder.tables.notes.list();
		if (listed.error !== null) return describeFailure(listed.error);
		const unknown = listed.data.filter((note) => note.issues !== null);
		if (unknown.length > 0)
			return `Some notes cannot be read well enough to tell which folder they are in (${unknown
				.slice(0, 3)
				.map((note) => `${note.id}.md`)
				.join(', ')}). Repair or remove them first.`;
		for (const note of notesOf(listed.data)) {
			if (note.fields.folderId !== entry.id) continue;
			const path = rowFile(NOTES, note.id);
			const why = mutationRefusal(path);
			if (why !== undefined)
				return `A note could not be moved out of the folder: ${why}`;
			const draft = edits.row(NOTES, note.id);
			if (!draft.change(note, { fields: { folderId: null } })) return CLOSING;
			await draft.save();
			if (draft.error !== undefined)
				return `A note could not be moved out of the folder: ${describeFailure(draft.error)}`;
		}
		const reread = await folder.tables.notes.list();
		if (reread.error !== null) return describeFailure(reread.error);
		const remaining = notesOf(reread.data).filter(
			(note) => note.fields.folderId === entry.id,
		);
		if (remaining.length > 0)
			return `Some notes are still in this folder (${remaining
				.slice(0, 3)
				.map((note) => `${note.id}.md`)
				.join(', ')}), so it was kept. Delete it again to move them out.`;
		const removed = await edits.delete(FOLDERS, entry.id);
		if (removed.error !== null) return describeFailure(removed.error);
		if (!removed.data.deleted && storedFolder(entry.id) !== undefined)
			return KEPT;
		deleted(rowFile(FOLDERS, entry.id));
		if (view.folderId === entry.id) view = { ...view, folderId: null };
		return undefined;
	}

	/**
	 * Delete what was confirmed. Typing in the file is sent first, and a
	 * delete refuses while it did not save. A row that reads as text is
	 * deleted as the edit layer stores it now; any other file as it was read
	 * just before. One changed in that moment is kept.
	 */
	async function deleteConfirmed({
		path,
	}: Deletion): Promise<string | undefined> {
		if (edits.fenced) return CLOSING;
		const at = rowAt(path);
		const row =
			at === undefined
				? undefined
				: (at.table === NOTES ? rowsOf(NOTES) : rowsOf(FOLDERS))?.find(
						(candidate) => candidate.id === at.id,
					);
		const removed =
			at !== undefined && row !== undefined && !notText(row)
				? await edits.delete(at.table, at.id)
				: await edits.deleteFile(path);
		if (removed.error !== null) {
			return describeFailure(removed.error);
		}
		if (!removed.data.deleted) {
			const still = await folder.files.read(path);
			if (still.error !== null) return describeFailure(still.error);
			if (still.data !== undefined) return KEPT;
		}
		deleted(path);
		return undefined;
	}

	return {
		/** The opened folder; `<FolderApp>` closes it. */
		folder,
		queryClient,
		/** The context's edit layer: row and whole-file edits and deletion. */
		edits,

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		queries: local.queries,

		/** Read the lists before the views show, so none starts empty. */
		async load() {
			await Promise.all([
				queryClient.prefetchQuery(local.queries.rows(NOTES)),
				queryClient.prefetchQuery(local.queries.rows(FOLDERS)),
			]);
		},

		// ------------------------------------------------------------------
		// What the lists and the detail show
		// ------------------------------------------------------------------

		expanded,
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

		/** Whether leaving the page now could lose something: typing held, or a save or action running. */
		get busy() {
			return local.busy;
		},
		/** Whether everything typed is saved on this device, as the header says it. */
		get saves() {
			return saveLine({
				state: local.saveState,
				failures: [...edits.failures, ...edits.textFailures],
				storageFailure: local.status.storageFailure,
			});
		},
		/** Whether a save at `path` runs, or typing there waits to be sent. */
		isWriting(path: string) {
			const at = rowAt(path);
			const row = at === undefined ? undefined : edits.row(at.table, at.id);
			const text = textAt(path);
			return (
				(row?.held === true && row.error === undefined) ||
				row?.saving === true ||
				(text.held && (text.error === undefined || text.saving))
			);
		},
		/** Whether typing at `path` did not save, with no save running. */
		isUnsaved(path: string) {
			const at = rowAt(path);
			const row = at === undefined ? undefined : edits.row(at.table, at.id);
			const text = textAt(path);
			return (
				(row?.error !== undefined && !row.saving) ||
				(text.error !== undefined && !text.saving)
			);
		},
		/** Whether edits of `path` are refused now: closing, or a delete runs. */
		isLocked(path: string) {
			return textAt(path).locked;
		},
		/** Whether input and actions are held back because the notes are closing. */
		get fenced() {
			return edits.fenced;
		},

		// ------------------------------------------------------------------
		// Note and folder rows
		// ------------------------------------------------------------------

		/** Why the note at `path` takes no change now, if it does not. */
		refusalAt(path: string): string | undefined {
			const id = noteIdOf(path);
			return id === undefined ? NOT_LISTED : noteRefusal(id);
		},
		/**
		 * Type `body` as the note's body; it saves a second after the last
		 * change, or at once with `saveRow`. A lone surrogate becomes U+FFFD,
		 * which the folder stores in its place. Answers why not, if not.
		 */
		editBody: (path: string, body: string) =>
			changeNote(path, { body: body.toWellFormed() }),
		/**
		 * Type `title` as the note's title; it saves after a pause, or at once
		 * with `saveRow`. Answers why not, if not.
		 */
		editTitle: (path: string, title: string) =>
			changeNote(path, { fields: { title: title.toWellFormed() } }),
		/** Send what is typed into the row at `path` now; resolves once no save of it runs. */
		saveRow,
		/**
		 * The note at `path` as the rich-text editor uses it: the row shown
		 * now, read reactively, with what is typed over it; whether it takes
		 * edits; and `edit`, which types a body and answers whether it was
		 * taken.
		 */
		noteBody(path: string): NoteBody {
			const id = noteIdOf(path) ?? '';
			const draft = edits.row(NOTES, id);
			const row = () => {
				trackQueries();
				const stored = storedNote(id);
				if (stored === undefined) return undefined;
				const shown = draft.shown(stored);
				// The folder reads a body with its file's line endings. The editors
				// read and write it with line feeds (ADR-0572), so a CRLF body gets
				// line feeds with its first edit and opening it writes nothing.
				return shown.body.includes('\r')
					? { ...shown, body: shown.body.replace(/\r\n?/g, '\n') }
					: shown;
			};
			return {
				get row() {
					return row();
				},
				get locked() {
					return draft.locked;
				},
				edit(body) {
					const shown = row();
					if (shown === undefined) return false;
					if (body === shown.body) return true;
					return changeNote(path, { body }) === undefined;
				},
			};
		},
		patchNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) =>
			patchNote(path, { deletedAt: InstantString.now() }),
		restoreNote: (path: string) => patchNote(path, { deletedAt: null }),
		/** Set a folder's fields and save at once; answers why not, if not. */
		patchFolder(path: string, fields: Partial<FolderFields>) {
			const why = mutationRefusal(path);
			if (why !== undefined) return why;
			const id = folderIdOf(path);
			const stored = id === undefined ? undefined : storedFolder(id);
			if (id === undefined || stored === undefined) return NOT_LISTED;
			const draft = edits.row(FOLDERS, id);
			if (!draft.change(stored, { fields })) return CLOSING;
			void draft.save();
			return undefined;
		},

		// ------------------------------------------------------------------
		// A file's exact text
		// ------------------------------------------------------------------

		/** The text typed into `path` and not yet saved, read reactively. */
		typedText: (path: string) => textAt(path).text,
		/** Why the last save of the text typed into `path` failed, while it is held. */
		textError: (path: string) => {
			const error = textAt(path).error;
			return error === undefined ? undefined : describeFailure(error);
		},
		/**
		 * Type `text` as the whole text of `path`; it saves a second after the
		 * last change, or at once with `saveText`. Answers whether it was taken.
		 */
		editText(path: string, text: string): boolean {
			const read = queryClient.getQueryData<FileRead>(local.queries.file(path, textRead).queryKey);
			const from = read?.kind === 'text' ? read.bytes : textAt(path).text;
			if (from === undefined) return false;
			return textAt(path).change(from, text);
		},
		/** Send the whole-file text held at this path. */
		saveText: (path: string) => textAt(path).save(),

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it. */
		createNote: () =>
			runAction(async () => {
				if (edits.fenced) return CLOSING;
				const id = newId();
				const created = await folder.tables.notes.set(id, null, {
					fields: {
						folderId: view.deleted ? null : view.folderId,
						title: '',
						pinned: false,
						createdAt: InstantString.now(),
						deletedAt: null,
					},
					body: '',
				});
				if (created.error !== null) return describeFailure(created.error);
				await local.refresh([rowFile(NOTES, id)]);
				open(rowFile(NOTES, id), 'note');
				return undefined;
			}),
		createFolder: (name: string) =>
			runAction(async () => {
				if (edits.fenced) return CLOSING;
				const id = newId();
				const created = await folder.tables.folders.set(id, null, {
					fields: { name, icon: null },
					body: '',
				});
				if (created.error !== null) return describeFailure(created.error);
				await local.refresh([rowFile(FOLDERS, id)]);
				return undefined;
			}),
		/** A new empty text file, opened; it never replaces an existing one. */
		createFile: (directory: string, name: string) =>
			runAction(async () => {
				const why = placeProblem(directory, name);
				if (why !== undefined) return why;
				const path = joinPath(directory, name);
				const written = await folder.files.write(path, null, '');
				if (written.error !== null) return describeFailure(written.error);
				await local.refresh([path]);
				open(path, 'text');
				return undefined;
			}),
		deleteFolder: (entry: FolderEntry) => runAction(() => deleteFolder(entry)),
		/** What deleting `path` would remove, for the person to confirm. */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (edits.fenced) return Err(CLOSING);
			const read = await folder.files.read(path);
			if (read.error !== null) return Err(describeFailure(read.error));
			if (read.data === undefined) return Err('It is no longer in the folder.');
			const id = noteIdOf(path);
			const note = id === undefined ? undefined : storedNote(id);
			const shown = note && edits.row(NOTES, note.id).shown(note);
			return Ok({
				path,
				title: shown && displayTitle(shown.fields.title, shown.body),
			});
		},
		delete: (deletion: Deletion) => runAction(() => deleteConfirmed(deletion)),

	};
}
