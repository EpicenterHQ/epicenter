/**
 * `@epicenter/svelte/edits`: a folder's edit of one row or file in a Svelte
 * view.
 *
 * `createRowEdit(folder.tables.notes, id)` and
 * `createTextEdit(folder.files, path)` answer the folder's edit of that row
 * or file, with its reads tracked: `row` or `text` is its document
 * with held input over it, `readStatus` what is known and how reading
 * goes, `pending` and `locked` its input and fence. Commands are the
 * folder edit's own. The folder owns all of it, reads included; this only
 * tracks it.
 *
 * The first time an effect asks for the document (`row`, `text` or
 * `readStatus`) with nothing known, no read running and no read failed,
 * the edit reads the file; a row a list already read needs no read of its
 * own, and a failed read waits for `read()`. Asking only for `pending` or
 * `locked` asks for no new document; a subscription may still refresh one
 * already read. Getters re-run a reader while some effect reads them,
 * through a subscription that ends with the last such effect; the folder
 * keeps input, timers, saves and failures as views come and go. Creating an
 * edit here reads and holds nothing; make a new one when its row or path
 * changes, for example in `$derived`.
 */
import type { FolderFiles, FolderTable } from '@epicenter/folder';
import type { TextEdit as FolderTextEdit } from '@epicenter/folder/edits';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';

/** What tracking needs of a row or text edit. */
type Tracked = Pick<FolderTextEdit, 'subscribe' | 'getReadStatus'> & {
	read(): Promise<unknown>;
};

/**
 * Track `edit` for a view: `input` re-runs a reader when anything of the
 * path changes; `document` does too, and reads the file when it starts with
 * nothing known, no read running and no read failed.
 */
function tracking(edit: Tracked) {
	return {
		input: createSubscriber((update) => edit.subscribe(update)),
		document: createSubscriber((update) => {
			const stop = edit.subscribe(update);
			const { known, reading, error } = edit.getReadStatus();
			// A folder that closed meanwhile refuses reads; there is nothing to show.
			if (known === 'nothing' && !reading && error === undefined)
				edit.read().catch(() => {});
			return stop;
		}),
	};
}

/** The folder's edit of row `id` of `table`, its reads tracked. */
export function createRowEdit<TRowSchema extends TSchema>(
	table: FolderTable<TRowSchema>,
	id: string,
) {
	const rowEdit = table.edit(id);
	const { getRow, getReadStatus, getPending, isLocked, ...commands } = rowEdit;
	const track = tracking(rowEdit);
	return {
		...commands,
		/** The row as last known stored, with held input in it. */
		get row() {
			track.document();
			return getRow();
		},
		/** What is known of the file and how reading it goes. */
		get readStatus() {
			track.document();
			return getReadStatus();
		},
		/** The held input, or `undefined`. */
		get pending() {
			track.input();
			return getPending();
		},
		/** Whether input is refused: another action holds the file, or the folder closes. */
		get locked() {
			track.input();
			return isLocked();
		},
	} as const;
}

export type RowEdit<TRowSchema extends TSchema = TSchema> = ReturnType<
	typeof createRowEdit<TRowSchema>
>;

/** The folder's edit of the file at `path`, its reads tracked. */
export function createTextEdit(files: FolderFiles, path: string) {
	const textEdit = files.edit(path);
	const { getText, getReadStatus, getPending, isLocked, ...commands } =
		textEdit;
	const track = tracking(textEdit);
	return {
		...commands,
		/** The held text, the held fields over the stored file, or the stored file as text. */
		get text() {
			track.document();
			return getText();
		},
		/** What is known of the file and how reading it goes. */
		get readStatus() {
			track.document();
			return getReadStatus();
		},
		get pending() {
			track.input();
			return getPending();
		},
		get locked() {
			track.input();
			return isLocked();
		},
	} as const;
}

export type TextEdit = ReturnType<typeof createTextEdit>;
