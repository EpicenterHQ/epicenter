/**
 * The Honeycrisp product state over its repository: what the lists and the
 * detail show, and every action.
 *
 * Notes and folders are held in page memory whole, so the lists, the title
 * fallback and the search read them synchronously and follow every change
 * here and elsewhere. Every write shows at once and resolves once this
 * device stored it, so no action waits for the server. A write that cannot
 * be saved is reported in a toast (`report`), and the controls show the
 * stored note again; a note the server refuses stays here, held with its
 * reason, which the header counts.
 */
import { ancestors } from '@epicenter/folder/file-browser';
import type { FileStatus, WriteError } from '@epicenter/repository/api';
import { toast } from '@epicenter/ui/sonner';
import { SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FolderEntry,
	type FolderFields,
	type FolderFile,
	folderStemOf,
	type NoteEntry,
	type NoteFields,
	type NoteFile,
	notePath,
	noteStemOf,
} from './data.js';
import { displayTitle } from './note-source.js';
import type { HoneycrispRepository } from './repository.js';

export type Notes = ReturnType<typeof createNotes>;

/** How a path opens: as the note it is, or as its source text. */
export type OpenAs = 'note' | 'text';

/** The selected path and its presentation. The path owns the detail view's lifetime. */
export type Selection = {
	readonly path: string;
	readonly as: OpenAs;
};

/** A listed file the lists cannot show as a note or folder, and why. */
export type Problem = { readonly path: string; readonly message: string };

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion = {
	readonly path: string;
	/** The note's name, when the file is a note that reads as one. */
	readonly title: string | undefined;
};

const newStem = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10);
const now = () => new Date().toISOString();

/** The note files that read as notes. */
export const notesOf = (files: readonly NoteFile[]): NoteEntry[] => files.filter((file): file is NoteEntry => file.valid);
/** The folder files that read as folders. */
export const foldersOf = (files: readonly FolderFile[]): FolderEntry[] =>
	files.filter((file): file is FolderEntry => file.valid);

const problemsOf = (files: readonly (NoteFile | FolderFile)[]): Problem[] =>
	files.flatMap((file) => (file.valid ? [] : [{ path: file.path, message: file.issues.join('; ') }]));
/** Note files whose text does not read as a note: each opens as its source, to repair. */
export const repairsOf = (files: readonly NoteFile[]) => problemsOf(files);
/** Folder files that do not read as folders. */
export const unreadableOf = (folders: readonly FolderFile[]) => problemsOf(folders);

/** How many of `files` are not sent yet, and how many are held here with a reason. */
export function syncOf(files: readonly { state: FileStatus }[]) {
	let sending = 0;
	let held = 0;
	for (const { state } of files) {
		if (state.status === 'sending') sending++;
		else if (state.status === 'held') held++;
	}
	return { sending, held };
}

/**
 * Tell the person when a write could not be saved on this device. A write is
 * shown at once and resolves once this device stored it; a note the server
 * later refuses stays here, held with its reason.
 */
export async function report(saved: Promise<Result<unknown, WriteError>>, failure: string) {
	const { error } = await saved;
	if (error !== null && error.name !== 'Closed') toast.error(failure, { description: error.message });
}

export function createNotes(repo: HoneycrispRepository) {

	/** Which notes the list shows; input not yet committed, like a search. */
	let view = $state<{ folderId: string | null; deleted: boolean; query: string }>({
		folderId: null,
		deleted: false,
		query: '',
	});
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>(['notes']);
	/** What the detail shows. */
	let selected = $state.raw<Selection | undefined>();
	/** Bumped when a note is opened, so its editor takes focus. */
	let focusRequest = $state(0);

	const noteAt = (path: string) => {
		const stem = noteStemOf(path);
		return stem === undefined ? undefined : repo.notes.get({ stem });
	};

	/** How a path opens when nothing says: a note as a note, unless its text is not one. */
	function defaultAs(path: string): OpenAs {
		return noteStemOf(path) !== undefined && noteAt(path)?.valid !== false ? 'note' : 'text';
	}

	/** Show `path` in the detail. */
	function open(path: string, as: OpenAs = defaultAs(path)) {
		if (as === 'note') focusRequest += 1;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (selected?.path === path && selected.as === as) return;
		selected = { path, as };
	}

	/** Set fields of a note; only the keys named change. */
	function patchNote(path: string, fields: Partial<NoteFields>, failure = 'Could not update the note') {
		const stem = noteStemOf(path);
		if (stem !== undefined) void report(repo.notes.patch({ stem }, fields), failure);
	}

	/**
	 * Move every member out and remove the folder, in one batch, so it lands
	 * all or nothing. Refused while a note cannot say which folder it is in.
	 */
	function deleteFolder(entry: FolderEntry): string | undefined {
		const files = repo.notes.all();
		const unknown = files.filter(({ fields }) => fields.folderId !== null && typeof fields.folderId !== 'string');
		if (unknown.length > 0)
			return `Some notes cannot be read well enough to tell which folder they are in (${unknown
				.slice(0, 3)
				.map((file) => file.path)
				.join(', ')}). Repair or remove them first.`;
		const members = files.filter((file) => file.fields.folderId === entry.params.stem);
		void report(
			repo.commit((batch) => {
				for (const member of members) batch.notes.patch({ stem: member.params.stem }, { folderId: null });
				batch.folders.delete({ stem: entry.params.stem });
			}),
			'Could not delete the folder',
		);
		if (view.folderId === entry.params.stem) view = { ...view, folderId: null };
		return undefined;
	}

	/** Delete a note or folder file. Other files belong to the repository, not to Honeycrisp. */
	function deleteConfirmed({ path }: Deletion) {
		if (selected?.path === path) selected = undefined;
		const note = noteStemOf(path);
		const folder = folderStemOf(path);
		if (note !== undefined) void report(repo.notes.delete({ stem: note }), 'Could not delete the note');
		else if (folder !== undefined) void report(repo.folders.delete({ stem: folder }), 'Could not delete the folder');
	}

	return {
		repo,

		// ------------------------------------------------------------------
		// What the lists and the detail show
		// ------------------------------------------------------------------

		/** Every note file, valid or not, ordered by path. */
		get noteFiles() {
			return repo.notes.all();
		},
		get folderFiles() {
			return repo.folders.all();
		},
		/** How many notes and folders the server has not answered yet, and how many are held here with a reason. */
		get sync() {
			const notes = syncOf(repo.notes.all());
			const folders = syncOf(repo.folders.all());
			return { sending: notes.sending + folders.sending, held: notes.held + folders.held };
		},
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
		// Actions; each applies at once and reports a write that did not land
		// ------------------------------------------------------------------

		patchNote,
		/** Move a note to Recently Deleted. The file stays; `deletedAt` is set. */
		trashNote: (path: string) => patchNote(path, { deletedAt: now() }, 'Could not delete the note'),
		restoreNote: (path: string) => patchNote(path, { deletedAt: null }, 'Could not restore the note'),
		patchFolder(path: string, fields: Partial<FolderFields>) {
			const stem = folderStemOf(path);
			if (stem !== undefined) void report(repo.folders.patch({ stem }, fields), 'Could not save the folder');
		},
		/** Create a note in the folder being shown and open it: it shows at once, and its editor opens once it is stored. */
		createNote() {
			const stem = newStem();
			const folderId = view.deleted ? null : view.folderId;
			void report(
				repo.notes.create({ stem }, { fields: { folderId, title: '', pinned: false, createdAt: now(), deletedAt: null }, body: '' }),
				'Could not create the note',
			);
			open(notePath(stem), 'note');
		},
		createFolder(name: string) {
			void report(repo.folders.create({ stem: newStem() }, { fields: { name, icon: null }, body: '' }), 'Could not create the folder');
		},
		deleteFolder,
		/** Whether Honeycrisp deletes `path`: notes and folders are its own. */
		deletable: (path: string) => noteStemOf(path) !== undefined || folderStemOf(path) !== undefined,
		/** What deleting `path` would remove, for the person to confirm. */
		deletionFor(path: string): Result<Deletion, string> {
			if (noteStemOf(path) === undefined && folderStemOf(path) === undefined)
				return Err('Honeycrisp deletes only notes and folders.');
			const note = noteAt(path);
			return Ok({ path, title: note?.valid ? displayTitle(note.fields.title, note.body) : undefined });
		},
		delete: deleteConfirmed,
	};
}
