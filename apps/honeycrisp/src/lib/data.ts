/**
 * Honeycrisp's inert declaration: two Markdown tables in one folder.
 *
 * A note is `notes/<id>.md` and a folder is `folders/<id>.md`. The file stem
 * is the identity; everything a person can change is frontmatter or body.
 * Folder membership is the note's `folderId`, so moving a note between
 * folders never moves its file.
 *
 * The body is plain Markdown text. The rich-text editor reads and writes it
 * through `editor/markdown.ts`; no codec is declared here.
 */
import { InstantString } from '@epicenter/definition';
import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
	rowPath,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';

export const honeycrispDefinition = defineFolder({
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: defineTable({
			fields: {
				name: field.string(),
				// Nullable rather than optional: a file field is one type, and
				// "absent" is reported as a missing field instead.
				icon: field.nullable(field.string()),
			},
		}),
		notes: defineTable({
			fields: {
				folderId: field.nullable(field.string()),
				title: field.string(),
				pinned: field.boolean(),
				createdAt: field.instant(),
				deletedAt: field.nullable(field.instant()),
			},
		}),
	},
});

/** The stem of `notes/<id>.md`. */
export type NoteId = string;

export type NoteFields = CreateRowOf<typeof honeycrispDefinition.tables.notes>;
export type FolderFields = CreateRowOf<
	typeof honeycrispDefinition.tables.folders
>;

/**
 * A row as the last listing read it: the bytes read, the row they hold, and
 * its stem. A folder's id, the value a note's `folderId` holds, is its
 * literal `stem`.
 */
export type NoteEntry = StoredRow<NoteFields> & { readonly stem: string };
export type FolderEntry = StoredRow<FolderFields> & { readonly stem: string };

export const NOTES = 'notes';

export function notePath(id: NoteId): string {
	return rowPath(NOTES, id);
}

/**
 * The note id of a row path, or undefined when the path is not a note row.
 * The id is the literal stem, so it may be empty (`notes/.md`): compare it
 * with `undefined`, never by truthiness.
 */
export function noteIdOf(path: string): NoteId | undefined {
	return rowStemOf(NOTES, path);
}

/** The name a person sees for a folder: its `name`, else its file. */
export function folderLabel(folder: FolderEntry): string {
	const { name } = folder.row.fields;
	if (name !== undefined && name !== '') return name;
	// An empty stem (`folders/.md`) is not a readable label.
	return folder.stem === '' ? folder.path : folder.stem;
}

/** The current time as the files store it. */
export const instantNow = (): InstantString => InstantString.now();
