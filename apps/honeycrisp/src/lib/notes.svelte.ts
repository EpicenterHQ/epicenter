/**
 * The Honeycrisp product state over its local folder, as `getFolder()`
 * answers it: what the lists and the detail show, and every action.
 *
 * Reads are the folder mirror's landed files and rows. Editors own their
 * short-lived drafts while a write is in flight.
 *
 * Writes go through the folder. A note's title, folder, pin, and body are
 * changes to its fields and body (`table.update`). A file open as its exact
 * text writes the whole file (`folder.write`).
 *
 * The folder keeps no history. Honeycrisp exposes no file renames or moves.
 */
import { InstantString } from '@epicenter/definition';
import { ancestors, joinPath } from '@epicenter/folder/file-browser';
import { describeIssues, type WriteError } from '@epicenter/folder';
import { SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	FOLDERS,
	type FolderEntry,
	type FolderFields,
	type FolderRow,
	folderIdOf,
	NOTES,
	type NoteEntry,
	type NoteFields,
	type NoteRow,
	noteIdOf,
	rowFile,
} from './data.js';
import { nameProblem } from './files.js';
import type { NotesFolder } from './folder.js';
import { displayTitle } from './note-source.js';
import { saveLine } from '@epicenter/svelte/status-line';

export type Notes = ReturnType<typeof createNotes>;

/** How a path opens: as the note it is, or as its exact text. */
export type OpenAs = 'note' | 'text';

/** The selected path and its presentation. The path owns the detail view's lifetime. */
export type Selection = {
	readonly path: string;
	readonly as: OpenAs;
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
const NOT_A_FOLDER =
	'This file does not read as a folder. Repair it as text first.';
const newId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);

const notText = (row: NoteRow | FolderRow) =>
	row.issues?.some(
		(issue) => issue.kind === 'not-text' || issue.kind === 'unreadable',
	) ?? false;

/** The note rows that read as notes. */
export const notesOf = (rows: readonly NoteRow[]): NoteEntry[] =>
	rows.filter((row): row is NoteEntry => row.issues === null);
/** The folder rows that read as folders. */
export const foldersOf = (rows: readonly FolderRow[]): FolderEntry[] =>
	rows.filter((row): row is FolderEntry => row.issues === null);

/** Note files whose text does not read as a note: each opens as text for repair. */
export function repairsOf(rows: readonly NoteRow[]): Problem[] {
	return rows.flatMap((row) =>
		row.issues === null || notText(row)
			? []
			: [{ path: row.path, message: describeIssues(row.issues) }],
	);
}

/** Note files that are not text or cannot be read, and folder files that do not read as folders. */
export function unreadableOf(
	notes: readonly NoteRow[],
	folders: readonly FolderRow[],
): Problem[] {
	return [
		...notes.flatMap((row) =>
			row.issues !== null && notText(row)
				? [{ path: row.path, message: describeIssues(row.issues) }]
				: [],
		),
		...folders.flatMap((row) =>
			row.issues === null
				? []
				: [{ path: row.path, message: describeIssues(row.issues) }],
		),
	];
}

export function createNotes(folder: NotesFolder) {
	const { notes: noteTable, folders: folderTable } = folder.tables;

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
	/** Bumped when a note is opened, so its editor takes focus. */
	let focusRequest = $state(0);
	const failed = (error: WriteError | null | undefined) =>
		error === null || error === undefined ? undefined : error.message;

	async function patchNote(path: string, fields: Partial<NoteFields>) {
		const id = noteIdOf(path);
		if (id === undefined) return NOT_LISTED;
		const row = noteTable.row(id);
		if (row === undefined) return NOT_LISTED;
		if (row.issues !== null) return NOT_A_NOTE;
		return failed((await noteTable.update(id, { fields })).error);
	}

	// ------------------------------------------------------------------
	// Opening
	// ------------------------------------------------------------------

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		const id = noteIdOf(path);
		if (id === undefined) return 'text';
		const row = noteTable.row(id);
		return row?.issues === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as };
	}

	/** Why a file named `name` in `directory` cannot be made, if it cannot. */
	function placeProblem(directory: string, name: string) {
		const why = nameProblem(directory, name);
		if (why !== undefined) return why;
		const path = joinPath(directory, name);
		if (
			folder.files.some(
				(file) => file.path === path || file.path.startsWith(`${path}/`),
			)
		)
			return `"${name}" already exists here.`;
		return undefined;
	}

	/** Refuse deletion while any note cannot identify its logical folder. */
	function unknownRelations(rows: readonly NoteRow[]) {
		const unknown = rows.filter((note) => note.issues !== null);
		if (unknown.length === 0) return undefined;
		return `Some notes cannot be read well enough to tell which folder they are in (${unknown
			.slice(0, 3)
			.map((note) => `${note.id}.md`)
			.join(', ')}). Repair or remove them first.`;
	}

	/** Move every member out, then remove the logical folder. */
	async function deleteFolder(entry: FolderEntry) {
		const rows = noteTable.rows;
		const unknown = unknownRelations(rows);
		if (unknown !== undefined) return unknown;
		const moved = await Promise.all(
			notesOf(rows)
				.filter((note) => note.fields.folderId === entry.id)
				.map((note) => noteTable.update(note.id, { fields: { folderId: null } })),
		);
		const problem = moved.map(({ error }) => failed(error)).find(Boolean);
		if (problem !== undefined) return problem;
		// A note that joined the folder while this ran keeps it.
		if (noteTable.rows.some((note) => note.fields?.folderId === entry.id))
			return 'Some notes are still in this folder, so it was kept. Delete it again to move them out.';
		const why = await deleteConfirmed({
			path: rowFile(FOLDERS, entry.id),
			title: undefined,
		});
		if (why !== undefined) return why;
		if (view.folderId === entry.id) view = { ...view, folderId: null };
		return undefined;
	}

	async function deleteConfirmed({ path }: Deletion): Promise<string | undefined> {
		if (selected?.path === path) selected = undefined;
		const problem = failed((await folder.delete(path)).error);
		if (problem !== undefined) return problem;
		return undefined;
	}

	return {
		/** The opened folder; `<OpenFolder>` closes it. */
		folder,

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

		/** Draft input enters the folder queue immediately. */
		get saves() {
			return saveLine(folder.saving);
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
		async patchFolder(path: string, fields: Partial<FolderFields>) {
			const id = folderIdOf(path);
			if (id === undefined) return NOT_LISTED;
			const row = folderTable.row(id);
			if (row === undefined) return NOT_LISTED;
			if (row.issues !== null) return NOT_A_FOLDER;
			return failed((await folderTable.update(id, { fields })).error);
		},

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it at once. */
		async createNote() {
			const id = newId();
			const folderId = view.deleted ? null : view.folderId;
			const created = await noteTable.create(id, {
				fields: {
					folderId,
					title: '',
					pinned: false,
					createdAt: InstantString.now(),
					deletedAt: null,
				},
				body: '',
			});
			if (created.error !== null) return failed(created.error);
			open(rowFile(NOTES, id), 'note');
			return undefined;
		},
		async createFolder(name: string) {
			const created = await folderTable.create(newId(), {
				fields: { name, icon: null },
				body: '',
			});
			return failed(created.error);
		},
		/** A new empty text file, opened at once after checking the listed names. */
		async createFile(directory: string, name: string) {
			const problem = placeProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			const written = await folder.write(path, '');
			if (written.error !== null) return failed(written.error);
			open(path, 'text');
			return undefined;
		},
		deleteFolder,
		/** What deleting `path` would remove, for the person to confirm. */
		deletionFor(path: string): Result<Deletion, string> {
			if (folder.file(path) === undefined)
				return Err('It is no longer in the folder.');
			const id = noteIdOf(path);
			const row = id === undefined ? undefined : noteTable.row(id);
			return Ok({
				path,
				title:
					row?.issues === null
						? displayTitle(row.fields.title, row.body)
						: undefined,
			});
		},
		delete: deleteConfirmed,
	};
}
