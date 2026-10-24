/**
 * What a view does to edit a file, for tests that drive Whispering without
 * mounting components: change the row or the text, and send it, as a view
 * does once the person pauses or leaves. Field, body, and text changes all
 * update one whole-source, published as a complete file. `draft` reads what the view shows now: the held
 * source interpreted through the row schema. Type-only imports
 * from Whispering, so this loads before the Svelte compiler plugin is
 * registered.
 */

import { rowIdOf } from './definition.js';
import { textRead } from './file-reads.js';
import type { WhisperingContext } from './folder.js';
import { QueryObserver, quiet } from './query.test-support.js';
import type { ReadRow, RowTable, Whispering } from './whispering.svelte.js';

/** A mutable copy for simulating input; field names and values come from the row schema. */
type Shown<T extends RowTable> = {
	fields: {
		-readonly [K in keyof ReadRow<T>['fields']]: ReadRow<T>['fields'][K];
	};
	body: string;
};

async function rowEditor<T extends RowTable>(
	whispering: Whispering,
	context: WhisperingContext,
	table: T,
	path: string | undefined,
) {
	if (path === undefined) throw new Error(`Expected a ${table} file to edit`);
	if (rowIdOf(table, path) === undefined)
		throw new Error(`${path} is not a ${table} row`);
	// One view of the row, kept as a mounted view keeps it.
	const view = whispering.document(table, path);
	await view.refresh();
	const shown = (): Shown<T> | undefined => {
		const text = view.getSnapshot().text;
		const row =
			text === undefined ? undefined : context.folder.tables[table].parse(text);
		return row?.fields === undefined || row.body === undefined
			? undefined
			: { fields: row.fields as Shown<T>['fields'], body: row.body };
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
			if (Object.keys(set).length === 0 && next.body === before.body) return;
			view.patch({
				fields: set as never,
				...(next.body !== before.body ? { body: next.body } : {}),
			});
			void view.save();
		},
	};
}

/** The selected recording, as its detail view edits it. */
export const recordingEditor = (
	whispering: Whispering,
	context: WhisperingContext,
) => rowEditor(whispering, context, 'recordings', whispering.selectedPath);

/** The selected transformation, as its detail view edits it. */
export const transformationEditor = (
	whispering: Whispering,
	context: WhisperingContext,
) =>
	rowEditor(
		whispering,
		context,
		'transformations',
		whispering.selectedTransformationPath,
	);

/** The transcript at `path`, as its card edits it. */
export const transcriptEditor = (
	whispering: Whispering,
	context: WhisperingContext,
	path: string,
) => rowEditor(whispering, context, 'transcriptions', path);

/** The text of `path`, as a text view edits it; the file must be open as text. */
export function textEditor(whispering: Whispering, path: string) {
	// One view of the text, as a mounted view keeps it.
	const view = whispering.document(path);
	whispering.editSource(path);
	return {
		view,
		get draft(): string {
			const text = view.getSnapshot().text;
			if (text === undefined) throw new Error(`${path} is not open as text`);
			return text;
		},
		input(text: string) {
			view.replace(text);
			void view.save();
		},
	};
}

/**
 * Open the text of `path` as a mounted text view does: read what the file
 * is into the cache and the folder's edit of it, and keep observing both,
 * so each is read again when the file changes.
 */
export async function openText(
	whispering: Whispering,
	context: WhisperingContext,
	path: string,
) {
	await context.queryClient.fetchQuery(context.queries.file(path, textRead));
	new QueryObserver(
		context.queryClient,
		context.queries.file(path, textRead),
	).subscribe(() => {});
	const edit = context.folder.files.document(path);
	edit.subscribe(() => {});
	await edit.refresh();
	return textEditor(whispering, path);
}

/**
 * Let drafts, saves, and actions land, then read the folder again, as a
 * report that files changed does, and let that read land.
 */
export async function settle(
	whispering: Whispering,
	context: WhisperingContext,
) {
	await quiet(context);
	await whispering.readAgain();
	await quiet(context);
}
