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
 * folder's name are typed into the folder's edit of the row
 * (`folder.tables.notes.edit(id)`), which holds the row as the lists last
 * read it or a save stored it: what is typed shows at once, saves a second
 * after the last change or at once when the view leaves it, keeps on screen
 * when a save fails, and merges with whatever was saved meanwhile. A file
 * open as its exact text (Edit as file, repair, any other file) uses the
 * folder's edit of the file (`folder.files.edit(path)`). The folder keeps one
 * document, input, save queue and deletion fence per path for both.
 *
 * Create, delete, and deleting a folder are actions. The folder keeps no
 * history and has no rename or move, so Honeycrisp offers neither.
 */
import { InstantString } from '@epicenter/definition';
import { CLOSING, DELETING } from '@epicenter/folder/edits';
import { ancestors, joinPath } from '@epicenter/folder/file-browser';
import { createFileEdit } from '@epicenter/svelte/edits';
import type { FolderContext } from '@epicenter/svelte/folder';
import { SvelteSet } from 'svelte/reactivity';
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
	type NoteMarkdown,
	type NoteFields,
	type NoteRow,
	noteIdOf,
	rowFile,
	type TableName,
} from './data.js';
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
	const { folder, queryClient } = local;

	/** One tracked file edit, with the note or folder schema when its path has one. */
	const editAt = (path: string) => {
		const at = rowAt(path);
		return at?.table === NOTES
			? createFileEdit(folder.tables.notes.edit(at.id))
			: at?.table === FOLDERS
				? createFileEdit(folder.tables.folders.edit(at.id))
				: createFileEdit(folder.files.edit(path));
	};
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

	/** One table's rows, as the cache holds them now. */
	function rowsOf(table: typeof NOTES): NoteRow[] | undefined;
	function rowsOf(table: typeof FOLDERS): FolderRow[] | undefined;
	function rowsOf(table: TableName) {
		return queryClient.getQueryData<NoteRow[] | FolderRow[]>(rowsKey(table));
	}

	/** The note the cache holds for `id`, if it reads as one. */
	function storedNote(id: string): NoteMarkdown | undefined {
		const row =
			folder.tables.notes.edit(id).getMarkdown() ??
			rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		return row?.issues === null ? row : undefined;
	}

	/** The folder the cache holds for `id`, if it reads as one. */
	function storedFolder(id: string): FolderEntry | undefined {
		const row = rowsOf(FOLDERS)?.find((candidate) => candidate.id === id);
		return row?.issues === null ? row : undefined;
	}

	/** Why a file refuses a structured change: closing or deletion. */
	function mutationRefusal(path: string): string | undefined {
		if (local.closing) return CLOSING;
		const fileEdit = editAt(path);
		if (fileEdit.locked) return DELETING;
		return undefined;
	}

	function noteRefusal(id: string): string | undefined {
		const why = mutationRefusal(rowFile(NOTES, id));
		if (why !== undefined) return why;
		const row =
			folder.tables.notes.edit(id).getMarkdown() ??
			rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		if (row === undefined) return NOT_LISTED;
		if (row.issues !== null) return NOT_A_NOTE;
		return undefined;
	}

	/**
	 * Set fields of a note and save at once: pin, move to a folder, trash,
	 * restore. Each keeps every field another writer changed.
	 */
	function patchNote(path: string, fields: Partial<NoteFields>) {
		const id = noteIdOf(path);
		if (id === undefined) return NOT_LISTED;
		const why = noteRefusal(id);
		if (why !== undefined) return why;
		const fileEdit = folder.tables.notes.edit(id);
		const changed = fileEdit.change({
			fields:
				fields.title === undefined
					? fields
					: { ...fields, title: fields.title.toWellFormed() },
		});
		if (changed.error !== null) return changed.error.message;
		void fileEdit.save();
	}

	/** Give a refused action its app-level reason even after the context closes. */
	function runAction(action: () => Promise<string | undefined>) {
		return local.closing ? Promise.resolve(CLOSING) : local.run(action);
	}

	/**
	 * Open `path`, just created, once the list holds it. The read is this
	 * view's, after the action that saved the file, so closing never waits
	 * for it; it joins the read the save's change started.
	 */
	async function openCreated(path: string, as: OpenAs) {
		if (local.closing) return;
		await local.refresh([path]);
		if (!local.closing) open(path, as);
	}

	// ------------------------------------------------------------------
	// Opening
	// ------------------------------------------------------------------

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		const id = noteIdOf(path);
		if (id === undefined) return 'text';
		const row =
			folder.tables.notes.edit(id).getMarkdown() ??
			rowsOf(NOTES)?.find((candidate) => candidate.id === id);
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
			(local.closing ? CLOSING : undefined) ?? nameProblem(directory, name);
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
		if (local.closing) return CLOSING;
		// What is typed into any note lands first, so the listing shows its folder.
		await Promise.all(
			(rowsOf(NOTES) ?? []).map((note) =>
				folder.tables.notes.edit(note.id).save(),
			),
		);
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
			// The list just read answered the note's document.
			const edit = folder.tables.notes.edit(note.id);
			const changed = edit.change({ fields: { folderId: null } });
			if (changed.error !== null) return changed.error.message;
			await edit.save();
			const failed = edit.getPending()?.error;
			if (failed !== undefined)
				return `A note could not be moved out of the folder: ${describeFailure(failed)}`;
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
		const removed = await folder.tables.folders.edit(entry.id).delete();
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
		if (local.closing) return CLOSING;
		const removed = await folder.files.edit(path).delete();
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

		/** Whether everything typed is saved on this device, as the header says it. */
		get saves() {
			return saveLine(local.getStatus());
		},
		/** Whether a save at `path` runs, or typing there waits to be sent. */
		isWriting(path: string) {
			const pending = editAt(path).pending;
			return (
				pending !== undefined && (pending.error === undefined || pending.saving)
			);
		},
		/** Whether typing at `path` did not save, with no save running. */
		isUnsaved(path: string) {
			const pending = editAt(path).pending;
			return pending?.error !== undefined && !pending.saving;
		},
		/** Whether input and actions are held back because the notes are closing. */
		get fenced() {
			return local.closing;
		},

		// ------------------------------------------------------------------
		// Note and folder rows
		// ------------------------------------------------------------------

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
			if (id === undefined) return NOT_LISTED;
			const fileEdit = folder.tables.folders.edit(id);
			if (fileEdit.getMarkdown()?.issues !== null) return NOT_LISTED;
			const changed = fileEdit.change({ fields });
			if (changed.error !== null) return changed.error.message;
			void fileEdit.save();
			return undefined;
		},

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it. */
		async createNote() {
			const id = newId();
			const path = rowFile(NOTES, id);
			const folderId = view.deleted ? null : view.folderId;
			const why = await runAction(async () => {
				if (local.closing) return CLOSING;
				const created = await folder.tables.notes.set(id, null, {
					fields: {
						folderId,
						title: '',
						pinned: false,
						createdAt: InstantString.now(),
						deletedAt: null,
					},
					body: '',
				});
				return created.error === null
					? undefined
					: describeFailure(created.error);
			});
			if (why === undefined) await openCreated(path, 'note');
			return why;
		},
		createFolder: (name: string) =>
			runAction(async () => {
				if (local.closing) return CLOSING;
				const created = await folder.tables.folders.set(newId(), null, {
					fields: { name, icon: null },
					body: '',
				});
				return created.error === null
					? undefined
					: describeFailure(created.error);
			}),
		/** A new empty text file, opened; it never replaces an existing one. */
		async createFile(directory: string, name: string) {
			const path = joinPath(directory, name);
			const why = await runAction(async () => {
				const problem = placeProblem(directory, name);
				if (problem !== undefined) return problem;
				const written = await folder.files.write(path, null, '');
				return written.error === null
					? undefined
					: describeFailure(written.error);
			});
			if (why === undefined) await openCreated(path, 'text');
			return why;
		},
		deleteFolder: (entry: FolderEntry) => runAction(() => deleteFolder(entry)),
		/** What deleting `path` would remove, for the person to confirm. */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			if (local.closing) return Err(CLOSING);
			const read = await folder.files.read(path);
			if (read.error !== null) return Err(describeFailure(read.error));
			if (read.data === undefined) return Err('It is no longer in the folder.');
			const id = noteIdOf(path);
			// The note as its edit shows it, what is typed included.
			const row =
				id === undefined || storedNote(id) === undefined
					? undefined
					: folder.tables.notes.edit(id).getMarkdown();
			return Ok({
				path,
				title:
					row?.issues === null
						? displayTitle(row.fields.title, row.body)
						: undefined,
			});
		},
		delete: (deletion: Deletion) => runAction(() => deleteConfirmed(deletion)),
	};
}
