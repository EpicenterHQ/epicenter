/**
 * Honeycrisp's state over one store's two collections, notes and folders:
 * this browser's in the local variant, the repository's in the online
 * variant. Honeycrisp adds its orders, what the lists and the detail show,
 * and the actions that span both collections.
 *
 * A note names its folder by id. Deleting a folder deletes its file only:
 * its notes keep their `folderId`, show in All Notes, and say their folder
 * was deleted until moved. That is one write, so it cannot half happen, and
 * it needs no note to be readable.
 */
import type { NoteOf } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import { type Honeycrisp, honeycrisp } from './contract.js';
import { displayTitle } from './note-source.js';

export type NoteCollection = Honeycrisp['collections']['notes'];
export type FolderCollection = Honeycrisp['collections']['folders'];

export type Note = NoteOf<NoteCollection>;
export type Folder = NoteOf<FolderCollection>;

/** The file of the note `id`. */
export const notePath = (id: string) =>
	honeycrisp.collections.notes.path.replace('{id}', id);
/** The file of the folder `id`. */
export const folderPath = (id: string) =>
	honeycrisp.collections.folders.path.replace('{id}', id);

/** The name a person sees for a note: its title, else its first line. */
export const noteLabel = (
	note: Pick<NoteOf<NoteCollection>, 'title' | 'body'>,
) => displayTitle(note.title, note.body);

/** The name a person sees for a folder: its name, else its file. */
export const folderLabel = (folder: Pick<Folder, 'id' | 'name'>) =>
	folder.name.trim() === '' ? `${folder.id}.md` : folder.name;

/** When a note was made, for ordering; a time that does not parse sorts last. */
const madeAt = (note: Pick<Note, 'createdAt'>) =>
	Date.parse(note.createdAt) || 0;

/** Newest first, by when each note was made, then by id. */
export const newestFirst = (a: Note, b: Note) =>
	madeAt(b) - madeAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Folders by name, as a person reads them. */
export const byName = (a: Folder, b: Folder) =>
	folderLabel(a).localeCompare(folderLabel(b)) || (a.id < b.id ? -1 : 1);

/**
 * Which variant a page is: `local`, this browser's files, or `online`, the
 * person's repository.
 */
export type Variant = 'local' | 'online';

/** What the detail shows: a note (read or not), or a folder that needs repair. */
export type Selection = {
	readonly collection: 'notes' | 'folders';
	readonly id: string;
};

/** Which notes the list shows: a folder's (null: all of them), matching what is searched. */
export type Filter = { folderId: string | null; query: string };

/** Whether `note` is shown under `filter`. */
export function shownIn(filter: Filter, note: Note) {
	if (filter.folderId !== null && note.folderId !== filter.folderId)
		return false;
	const needle = filter.query.trim().toLowerCase();
	if (needle === '') return true;
	return `${note.title ?? ''}\n${note.body}`.toLowerCase().includes(needle);
}

/**
 * Honeycrisp's state over `client` (one variant's store: `fromClient(device)`
 * or `fromClient(getRepo())`): what the list and detail show, and the actions
 * that are more than one collection's write. Every other read and write goes
 * to `client.notes` or `client.folders` directly.
 */
export function createHoneycrisp(client: ReactiveClient<Honeycrisp>) {
	const { notes, folders } = client;
	let filter = $state<Filter>({ folderId: null, query: '' });
	let selected = $state.raw<Selection | undefined>();
	/** A note just made, whose editor takes focus once it opens. */
	let newNote: string | undefined;

	return {
		notes,
		folders,
		get filter() {
			return filter;
		},
		showFolder(folderId: string | null) {
			filter = { ...filter, folderId };
		},
		setQuery(query: string) {
			filter = { ...filter, query };
		},
		get selected() {
			return selected;
		},
		/** Whether the note `id` was just made: answered true once, by the detail that opens it. */
		takeNew(id: string) {
			if (newNote !== id) return false;
			newNote = undefined;
			return true;
		},
		/** Show `selection` in the detail, or nothing. */
		open(selection: Selection | undefined) {
			if (
				selected?.collection === selection?.collection &&
				selected?.id === selection?.id
			)
				return;
			selected = selection;
		},

		/** Make a note in the folder shown, and open it to be written in. */
		async createNote() {
			const created = await notes.create({
				id: timeId(),
				createdAt: new Date().toISOString(),
				...(filter.folderId !== null && { folderId: filter.folderId }),
			});
			if (created.error !== null) return created;
			newNote = created.data.id;
			selected = { collection: 'notes', id: created.data.id };
			return created;
		},

		/** Make a folder named `name`. */
		createFolder: (name: string) => folders.create({ id: timeId(), name }),

		/** Delete the note `id`; the detail stops showing it. */
		async deleteNote(id: string) {
			const deleted = await notes.delete({ id });
			if (deleted.error === null && selected?.id === id) selected = undefined;
			return deleted;
		},

		/** Delete the folder `id`. Its notes keep naming it and show in All Notes. */
		async deleteFolder(id: string) {
			const deleted = await folders.delete({ id });
			if (deleted.error !== null) return deleted;
			if (filter.folderId === id) filter = { ...filter, folderId: null };
			if (selected?.collection === 'folders' && selected.id === id)
				selected = undefined;
			return deleted;
		},
	};
}
export type HoneycrispState = ReturnType<typeof createHoneycrisp>;

export const [getHoneycrisp, setHoneycrisp] = createContext<HoneycrispState>();
