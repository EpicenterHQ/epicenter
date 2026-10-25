/**
 * Honeycrisp's tables in its local folder, `openFolder({ tables: honeycrispTables })`.
 *
 * A note is `notes/<id>.md` and a folder is `folders/<id>.md`. The file stem
 * is the identity; everything a person can change is frontmatter or body.
 * Folder membership is the note's `folderId`, so moving a note between
 * folders never moves its file.
 *
 * The schemas only interpret: a row that does not fit is listed with its
 * exact text and its issues, a save never checks a row against them, and a
 * key Honeycrisp does not name survives every save.
 *
 * The body is plain Markdown text. The rich-text editor reads and writes it
 * through `editor/markdown.ts`.
 */
import { field } from '@epicenter/definition';
import type { Row } from '@epicenter/folder/next';
import { type Static, Type } from 'typebox';

export const honeycrispTables = {
	folders: Type.Object({
		name: field.string(),
		// Nullable rather than optional: a file field is one type, and
		// "absent" is reported as a missing field instead.
		icon: field.nullable(field.string()),
	}),
	notes: Type.Object({
		folderId: field.nullable(field.string()),
		title: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		deletedAt: field.nullable(field.instant()),
	}),
};

export type HoneycrispTables = typeof honeycrispTables;
export type TableName = keyof HoneycrispTables & string;

export type NoteFields = Static<HoneycrispTables['notes']>;
export type FolderFields = Static<HoneycrispTables['folders']>;

/** A note file as the table lists it: its text, its fields, and any issues. */
export type NoteRow = Row<HoneycrispTables['notes']>;
/** A folder file as the table lists it. */
export type FolderRow = Row<HoneycrispTables['folders']>;

/** A note file that reads as a note. */
export type NoteEntry = Extract<NoteRow, { issues: null }>;
/** A folder file that reads as a folder. Its id is the value a note's `folderId` holds. */
export type FolderEntry = Extract<FolderRow, { issues: null }>;

/** The stem of `notes/<id>.md`. */
export type NoteId = string;

export const NOTES = 'notes';
export const FOLDERS = 'folders';

/** The file of row `id` in `table`. */
export const rowFile = (table: TableName, id: string) => `${table}/${id}.md`;

function rowStemOf(table: string, path: string): string | undefined {
	const prefix = `${table}/`;
	if (!path.startsWith(prefix) || !path.endsWith('.md')) return undefined;
	const stem = path.slice(prefix.length, -3);
	return stem !== '' && !stem.includes('/') ? stem : undefined;
}

/** The note id of a row path, or undefined when the path is not a note row. */
export function noteIdOf(path: string): NoteId | undefined {
	return rowStemOf(NOTES, path);
}

/** The folder id of a row path, or undefined when the path is not a folder row. */
export function folderIdOf(path: string): string | undefined {
	return rowStemOf(FOLDERS, path);
}

/** The name a person sees for a folder: its `name`, else its file. */
export function folderLabel(folder: FolderEntry): string {
	const { name } = folder.fields;
	return name !== '' ? name : folder.id;
}
