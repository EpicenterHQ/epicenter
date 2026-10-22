/**
 * The Honeycrisp product state over this browser's local folder
 * (`openFolder({ tables: honeycrispTables })`), as `getFolder()`
 * answers it: the rows read through its query cache, and every write.
 *
 * Reads are queries. The note and folder rows are the context's
 * (`queries.rows`); the shared context also owns the file listing and generated file keys.
 * This module defines how source text is decoded. The context refreshes
 * changed paths; it owns the only change listener.
 *
 * A note's title, folder, pin, and body, a list action on any note, and a
 * folder's name are typed into the folder's edit of the row
 * (`folder.tables.notes.document(id)`), acquired by a mounted subscription or
 * explicit refresh: what is typed shows at once, saves a second
 * after the last change, and keeps it on screen
 * when a save fails. Accepted local input remains visible across storage observations;
 * publications replace the complete file in call order. A file
 * open as its exact text (Edit as file, repair, any other file) uses the
 * folder's edit of the file (`folder.files.document(path)`). The folder keeps one
 * document, input, and publication queue per path for both.
 *
 * Create, delete, and deleting a folder are actions. The folder keeps no
 * history and has no rename or move, so Honeycrisp offers neither.
 */
import { InstantString } from '@epicenter/definition';
import { CLOSING } from '@epicenter/folder/document';
import { ancestors, joinPath } from '@epicenter/folder/file-browser';
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
	type NoteFields,
	type NoteMarkdown,
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

export function createNotes(local: NotesFolder) {
	const { folder, queryClient } = local;

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
		const snapshot = folder.tables.notes.document(id).getSnapshot();
		const listed = rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		const row = snapshot.isDirty
			? snapshot.content
			: (listed ?? snapshot.content);
		return row?.issues === null ? row : undefined;
	}

	/** Acquire current text for list actions, then edit the shared document. */
	async function patchNote(path: string, fields: Partial<NoteFields>) {
		if (local.closing) return CLOSING;
		const id = noteIdOf(path);
		if (id === undefined) return NOT_LISTED;
		const fileEdit = folder.tables.notes.document(id);
		if (!fileEdit.getSnapshot().isDirty) {
			const loaded = await fileEdit.refresh();
			// The folder may have closed while this waited.
			if (local.closing) return CLOSING;
			if (loaded.error !== null) return describeFailure(loaded.error);
		}
		const content = fileEdit.getSnapshot().content;
		if (content === undefined) return NOT_LISTED;
		if (content.issues !== null) return NOT_A_NOTE;
		const saved = await fileEdit.save({
			fields:
				fields.title === undefined
					? fields
					: { ...fields, title: fields.title.toWellFormed() },
		});
		return saved.error === null ? undefined : describeFailure(saved.error);
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
		const snapshot = folder.tables.notes.document(id).getSnapshot();
		const listed = rowsOf(NOTES)?.find((candidate) => candidate.id === id);
		const row = snapshot.isDirty
			? snapshot.content
			: (listed ?? snapshot.content);
		return row === undefined || row.issues === null ? 'note' : 'text';
	}

	/** Show `path` in the detail. Opening never waits, writes, or asks. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (local.closing) return;
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as };
	}

	/** After a delete: the open item lets the file go. */
	function deleted(path: string) {
		if (local.closing) return;
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

	/** Include local-only notes and pending membership changes in destructive relation checks. */
	function notesWithInput(listed: NoteRow[]): NoteRow[] {
		const ids = new Set([
			...listed.map((note) => note.id),
			...folder.getStatus().unsaved.flatMap((path) => {
				const id = noteIdOf(path);
				return id === undefined ? [] : [id];
			}),
		]);
		return [...ids].flatMap((id) => {
			const snapshot = folder.tables.notes.document(id).getSnapshot();
			const content = snapshot.isDirty ? snapshot.content : undefined;
			const row =
				content === undefined
					? listed.find((note) => note.id === id)
					: { ...content, id };
			return row === undefined ? [] : [row];
		});
	}

	/** Move every known member out before removing its logical folder. */
	async function deleteFolder(entry: FolderEntry) {
		if (local.closing) return CLOSING;
		const listed = await folder.tables.notes.list();
		if (local.closing) return CLOSING;
		if (listed.error !== null) return describeFailure(listed.error);
		queryClient.setQueryData(rowsKey(NOTES), listed.data);
		const current = notesWithInput(listed.data);
		const unknown = unknownRelations(current);
		if (unknown !== undefined) return unknown;
		for (const note of notesOf(current)) {
			// The final scan keeps the folder if a new member arrives meanwhile.
			if (note.fields.folderId !== entry.id) continue;
			const edit = folder.tables.notes.document(note.id);
			if (!edit.getSnapshot().isDirty) {
				const loaded = await edit.refresh();
				if (local.closing) return CLOSING;
				if (loaded.error !== null) return describeFailure(loaded.error);
			}
			const content = edit.getSnapshot().content;
			if (content?.issues !== null || content.fields.folderId !== entry.id)
				continue;
			const saved = await edit.save({
				fields: { folderId: null },
			});
			if (saved.error !== null) return describeFailure(saved.error);
		}
		const reread = await folder.tables.notes.list();
		if (local.closing) return CLOSING;
		if (reread.error !== null) return describeFailure(reread.error);
		const remaining = notesWithInput(reread.data);
		const unreadable = unknownRelations(remaining);
		if (unreadable !== undefined) return unreadable;
		if (remaining.some((note) => note.fields?.folderId === entry.id))
			return 'Some notes are still in this folder, so it was kept. Delete it again to move them out.';
		const why = await deleteConfirmed({
			path: rowFile(FOLDERS, entry.id),
			title: undefined,
		});
		if (why !== undefined) return why;
		if (!local.closing && view.folderId === entry.id)
			view = { ...view, folderId: null };
		return undefined;
	}

	/** Refuse deletion while any row cannot identify its logical folder. */
	function unknownRelations(rows: NoteRow[]) {
		const unknown = rows.filter((note) => note.issues !== null);
		if (unknown.length === 0) return undefined;
		return `Some notes cannot be read well enough to tell which folder they are in (${unknown
			.slice(0, 3)
			.map((note) => `${note.id}.md`)
			.join(', ')}). Repair or remove them first.`;
	}

	/** Delete in the folder's publication lane without flushing or blocking input. */
	async function deleteConfirmed({
		path,
	}: Deletion): Promise<string | undefined> {
		const removed = await folder.files.delete(path);
		if (removed.error !== null) return describeFailure(removed.error);
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
			const status = local.getStatus();
			return (
				status.unsaved.includes(path) &&
				!status.failures.some((failure) => failure.path === path)
			);
		},
		/** Whether typing at `path` did not save, with no save running. */
		isUnsaved(path: string) {
			return local
				.getStatus()
				.failures.some((failure) => failure.path === path);
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
		async patchFolder(path: string, fields: Partial<FolderFields>) {
			if (local.closing) return CLOSING;
			const id = folderIdOf(path);
			if (id === undefined) return NOT_LISTED;
			const fileEdit = folder.tables.folders.document(id);
			if (!fileEdit.getSnapshot().isDirty) {
				const loaded = await fileEdit.refresh();
				// The folder may have closed while this waited.
				if (local.closing) return CLOSING;
				if (loaded.error !== null) return describeFailure(loaded.error);
			}
			if (fileEdit.getSnapshot().content?.issues !== null) return NOT_LISTED;
			const saved = await fileEdit.save({ fields });
			return saved.error === null ? undefined : describeFailure(saved.error);
		},

		// ------------------------------------------------------------------
		// Actions; each answers what the person is told, if anything
		// ------------------------------------------------------------------

		/** Create a note in the folder being shown and open it. */
		async createNote() {
			const id = newId();
			const path = rowFile(NOTES, id);
			const folderId = view.deleted ? null : view.folderId;
			if (local.closing) return CLOSING;
			const created = await folder.tables.notes.write(id, {
				fields: {
					folderId,
					title: '',
					pinned: false,
					createdAt: InstantString.now(),
					deletedAt: null,
				},
				body: '',
			});
			if (created.error !== null) return describeFailure(created.error);
			await openCreated(path, 'note');
			return undefined;
		},
		async createFolder(name: string) {
			const id = newId();
			if (local.closing) return CLOSING;
			const created = await folder.tables.folders.write(id, {
				fields: { name, icon: null },
				body: '',
			});
			return created.error === null
				? undefined
				: describeFailure(created.error);
		},
		/** A new empty text file, opened after checking the listed names. */
		async createFile(directory: string, name: string) {
			const problem = placeProblem(directory, name);
			if (problem !== undefined) return problem;
			const path = joinPath(directory, name);
			if (local.closing) return CLOSING;
			const written = await folder.files.write(path, '');
			if (written.error !== null) return describeFailure(written.error);
			await openCreated(path, 'text');
			return undefined;
		},
		deleteFolder,
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
					: folder.tables.notes.document(id).getSnapshot().content;
			return Ok({
				path,
				title:
					row?.issues === null
						? displayTitle(row.fields.title, row.body)
						: undefined,
			});
		},
		delete: (deletion: Deletion) =>
			local.closing ? Promise.resolve(CLOSING) : deleteConfirmed(deletion),
	};
}
