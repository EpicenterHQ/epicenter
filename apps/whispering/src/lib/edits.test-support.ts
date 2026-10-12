/**
 * What a view does to edit a file, for tests that drive the library without
 * mounting components: change the row or the text in the cache, which
 * writes it. `draft` reads what the cache holds now. Type-only imports from
 * the library, so this loads before the Svelte compiler plugin is
 * registered.
 */
import { type Row, rowStemOf } from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import type {
	RecordingFields,
	TranscriptionFields,
	TransformationFields,
} from './definition.js';
import type { Library, RowTable } from './library.svelte.js';
import { quiet } from './query.test-support.js';

type FieldsOf<T extends RowTable> = T extends 'recordings'
	? RecordingFields
	: T extends 'transcriptions'
		? TranscriptionFields
		: TransformationFields;

function rowEditor<T extends RowTable>(
	library: Library,
	table: T,
	path: string | undefined,
) {
	if (path === undefined) throw new Error(`Expected a ${table} file to edit`);
	const stem = rowStemOf(table, path);
	if (stem === undefined) throw new Error(`${path} is not a ${table} row`);
	return {
		path,
		/** The row the cache holds now. Throws when it does not hold one. */
		get draft(): Row<FieldsOf<T>> {
			const stored = library.rowAt(table, path);
			if (stored === undefined)
				throw new Error(`No row for ${path} in the cache`);
			return stored.row as Row<FieldsOf<T>>;
		},
		/** Change the row as a person typing does; it is written at once. */
		edit(change: (row: Row<FieldsOf<T>>) => void) {
			library.editRow(table, stem, (row) => {
				const next = structuredClone(row) as Row<FieldsOf<T>>;
				change(next);
				return next as never;
			});
		},
	};
}

/** The selected recording, as its detail view edits it. */
export const recordingEditor = (library: Library) =>
	rowEditor(library, 'recordings', library.selectedPath);

/** The selected transformation, as its detail view edits it. */
export const transformationEditor = (library: Library) =>
	rowEditor(library, 'transformations', library.selectedTransformationPath);

/** The transcript at `path`, as its card edits it. */
export const transcriptEditor = (library: Library, path: string) =>
	rowEditor(library, 'transcriptions', path);

/** The text of `path`, as a text view edits it; the file must be open as text. */
export function textEditor(library: Library, path: string) {
	return {
		get draft(): string {
			const opened = library.queryClient.getQueryData<OpenedFile>(
				library.textQuery(path).queryKey,
			);
			if (opened?.kind !== 'text')
				throw new Error(`${path} is not open as text`);
			return opened.file.text;
		},
		input(text: string) {
			library.editText(path, text);
		},
	};
}

/** Read the text of `path` into the cache, as a text view does when it mounts. */
export async function openText(library: Library, path: string) {
	await library.queryClient.fetchQuery(library.textQuery(path));
	return textEditor(library, path);
}

/**
 * Let writes and actions land, then read the folder again as returning to
 * the window does, and let that read land.
 */
export async function settle(library: Library) {
	await quiet(library.queryClient);
	await library.check();
	await quiet(library.queryClient);
}
