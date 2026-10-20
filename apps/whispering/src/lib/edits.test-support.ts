/**
 * What a view does to edit a file, for tests that drive the library without
 * mounting components: change the row or the text, and send it, as a view
 * does once the person pauses or leaves. A changed field or body is the
 * row's draft, saved as a change from the row it started from; a changed
 * text is a text draft saved over the text it started from. `draft` reads
 * what the view shows now: what is typed over the cache. Type-only imports
 * from the library, so this loads before the Svelte compiler plugin is
 * registered.
 */
import { textRead } from './file-reads.js';

import type { OpenedFile } from '@epicenter/folder/file-browser';
import {
	type RecordingFields,
	rowIdOf,
	type TranscriptionFields,
	type TransformationFields,
} from './definition.js';
import type { Library, RowTable } from './library.svelte.js';
import { QueryObserver, quiet } from './query.test-support.js';

type FieldsOf<T extends RowTable> = T extends 'recordings'
	? RecordingFields
	: T extends 'transcriptions'
		? TranscriptionFields
		: TransformationFields;

/** A row as a view shows it: its fields and its body. */
type Shown<T extends RowTable> = { fields: FieldsOf<T>; body: string };

function rowEditor<T extends RowTable>(
	library: Library,
	table: T,
	path: string | undefined,
) {
	if (path === undefined) throw new Error(`Expected a ${table} file to edit`);
	const stem = rowIdOf(table, path);
	if (stem === undefined) throw new Error(`${path} is not a ${table} row`);
	const shown = (): Shown<T> | undefined => {
		const row = library.rowAt(table, path);
		return row && { fields: row.fields as FieldsOf<T>, body: row.body };
	};
	return {
		path,
		/** The row shown now. Throws when there is none. */
		get draft(): Shown<T> {
			const row = shown();
			if (row === undefined) throw new Error(`No row for ${path} to show`);
			return row;
		},
		/** Change the row as a person typing does, and send it. */
		edit(change: (row: Shown<T>) => void) {
			const before = shown();
			if (before === undefined) return;
			const next = structuredClone(before);
			change(next);
			const set: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(next.fields))
				if (
					JSON.stringify(value) !==
					JSON.stringify((before.fields as Record<string, unknown>)[name])
				)
					set[name] = value;
			if (Object.keys(set).length > 0)
				library.setFields(table, stem, set as never);
			if (next.body !== before.body) {
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
				library.local.queries.file(path, textRead).queryKey,
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
	await library.queryClient.fetchQuery(library.local.queries.file(path, textRead));
	new QueryObserver(library.queryClient, library.local.queries.file(path, textRead)).subscribe(
		() => {},
	);
	return textEditor(library, path);
}

/**
 * Let drafts, saves, and actions land, then read the folder again, as a
 * report that files changed does, and let that read land.
 */
export async function settle(library: Library) {
	await quiet(library);
	await library.readAgain();
	await quiet(library);
}
