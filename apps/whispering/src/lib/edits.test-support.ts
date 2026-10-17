/**
 * What a view does to edit a file, for tests that drive the library without
 * mounting components: change the row or the text, and send it, as a view
 * does once the person pauses or leaves. A changed field is an update of the
 * file as it is now; a changed body or text is a draft saved over the
 * version it started from. `draft` reads what the view shows now: the body
 * typed while it is unsaved, else the cache. Type-only imports from the library, so this loads before the
 * Svelte compiler plugin is registered.
 */
import { type Row, rowStemOf } from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import type {
	RecordingFields,
	TranscriptionFields,
	TransformationFields,
} from './definition.js';
import type { Library, RowTable } from './library.svelte.js';
import { QueryObserver, quiet } from './query.test-support.js';

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
		/** The row shown now. Throws when there is none. */
		get draft(): Row<FieldsOf<T>> {
			const row = library.rowAt(table, path);
			if (row === undefined) throw new Error(`No row for ${path} to show`);
			return row as Row<FieldsOf<T>>;
		},
		/** Change the row as a person typing does, and send it. */
		edit(change: (row: Row<FieldsOf<T>>) => void) {
			const shown = library.rowAt(table, path) as Row<FieldsOf<T>> | undefined;
			if (shown === undefined) return;
			const next = structuredClone(shown);
			change(next);
			const set: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(next.fields))
				if (
					JSON.stringify(value) !==
					JSON.stringify((shown.fields as Record<string, unknown>)[name])
				)
					set[name] = value;
			if (Object.keys(set).length > 0)
				library.setFields(table, stem, set as never);
			if (next.body !== shown.body) {
				library.editBody(table, stem, next.body);
				void library.saveBody(path);
			}
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
			return library.editedText(path) ?? opened.text;
		},
		input(text: string) {
			library.editText(path, text);
			void library.saveText(path);
		},
	};
}

/**
 * Read the text of `path` into the cache and keep observing it, as a text
 * view does while it is mounted, so it is read again when it goes stale.
 */
export async function openText(library: Library, path: string) {
	await library.queryClient.fetchQuery(library.textQuery(path));
	new QueryObserver(library.queryClient, library.textQuery(path)).subscribe(
		() => {},
	);
	return textEditor(library, path);
}

/**
 * Let edits, writes, and actions land, then read the folder again, as a
 * report that files changed does, and let that read land.
 */
export async function settle(library: Library) {
	await quiet(library);
	await library.readAgain();
	await quiet(library);
}
