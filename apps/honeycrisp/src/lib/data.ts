/**
 * Honeycrisp's lens over its repository: a note is `notes/<stem>.md` and a
 * folder is `folders/<stem>.md`. The file stem is the identity; everything a
 * person can change is frontmatter or body. Folder membership is the note's
 * `folderId`, so moving a note between folders never moves its file.
 *
 * The schemas only interpret: a note that does not fit is listed with its
 * exact text and its issues, and a write changes only the keys and the body
 * it names, so a key Honeycrisp does not name survives every save.
 */
import { defineApp, type Note, type ValidNote } from '@epicenter/repository';
import { type Static, Type } from 'typebox';

const nullable = <T extends ReturnType<typeof Type.String>>(type: T) => Type.Union([type, Type.Null()]);

export const noteSchema = Type.Object({
	folderId: nullable(Type.String()),
	title: Type.String(),
	pinned: Type.Boolean(),
	/** An ISO 8601 instant; the list orders by it. A save moves no timestamp. */
	createdAt: Type.String(),
	deletedAt: nullable(Type.String()),
});

export const folderSchema = Type.Object({
	name: Type.String(),
	icon: nullable(Type.String()),
});

export const honeycrispApp = defineApp({
	notes: { path: 'notes/{stem}.md', schema: noteSchema },
	folders: { path: 'folders/{stem}.md', schema: folderSchema },
});

export type NoteFields = Static<typeof noteSchema>;
export type FolderFields = Static<typeof folderSchema>;

/** A note file as the repository lists it: its text, its fields, and any issues. */
export type NoteFile = Note<'notes/{stem}.md', typeof noteSchema>;
/** A folder file as the repository lists it. */
export type FolderFile = Note<'folders/{stem}.md', typeof folderSchema>;

/** A note file that reads as a note. */
export type NoteEntry = ValidNote<'notes/{stem}.md', typeof noteSchema>;
/** A folder file that reads as a folder. Its stem is the value a note's `folderId` holds. */
export type FolderEntry = ValidNote<'folders/{stem}.md', typeof folderSchema>;

export const notePath = (stem: string) => `notes/${stem}.md`;
export const folderPath = (stem: string) => `folders/${stem}.md`;

function stemOf(directory: string, path: string): string | undefined {
	const prefix = `${directory}/`;
	if (!path.startsWith(prefix) || !path.endsWith('.md')) return undefined;
	const stem = path.slice(prefix.length, -3);
	return stem !== '' && !stem.includes('/') ? stem : undefined;
}

/** The note stem of a path, or undefined when the path is not a note. */
export const noteStemOf = (path: string) => stemOf('notes', path);
/** The folder stem of a path, or undefined when the path is not a folder. */
export const folderStemOf = (path: string) => stemOf('folders', path);

/** The name a person sees for a folder: its `name`, else its file. */
export function folderLabel(folder: FolderEntry): string {
	const { name } = folder.fields;
	return name !== '' ? name : folder.params.stem;
}
