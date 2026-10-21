/**
 * `@epicenter/react/edits`: a folder's edit of one row or file in a React
 * view.
 *
 * `useRowEdit(folder.tables.notes, id)` and `useTextEdit(folder.files, path)`
 * answer the folder's edit of that row or file, its reads answering what
 * this render read as external store snapshots: `getRow()` or `getText()`,
 * `getReadStatus()`, `getPending()` and `isLocked()`. A snapshot keeps its
 * identity until it changes, and a view re-renders when one does. Commands
 * are the folder edit's own. The folder owns all of it, reads included.
 *
 * When a render asked for the document (`getRow`, `getText` or
 * `getReadStatus`) with nothing known, no read running and no read failed,
 * the hook reads the file once that render commits; a failed read waits for
 * `read()`. Asking only for `getPending` or `isLocked` asks for no new
 * document; a subscription may still refresh one already read.
 *
 * Typing through the result is typing over what that same render showed: a
 * whole text or body typed in a handler of the committed render keeps a
 * change the same event already made through another handler, merged by
 * line as a save would. The folder keeps the document, input, timers, saves
 * and failures, whatever views mount and unmount.
 */
import type { FolderFiles, FolderTable } from '@epicenter/folder';
import {
	type ChangeResult,
	mergeText,
	type RowEditChange,
	type TextEdit,
} from '@epicenter/folder/edits';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** What reading on demand needs of a row or text edit. */
type Tracked = Pick<TextEdit, 'subscribe' | 'getReadStatus'> & {
	read(): Promise<unknown>;
};

/**
 * This render's read status of `edit`, and `wanted`, which this render's
 * document methods call so that, once it commits, the file is read when
 * nothing is known. The request belongs to this render alone: a render that
 * never commits asks for nothing.
 */
function useDocument(edit: Tracked) {
	const status = useSyncExternalStore(
		edit.subscribe,
		edit.getReadStatus,
		edit.getReadStatus,
	);
	let requested = false;
	useEffect(() => {
		if (!requested) return;
		const { known, reading, error } = edit.getReadStatus();
		// A folder that closed meanwhile refuses reads; there is nothing to show.
		if (known === 'nothing' && !reading && error === undefined)
			edit.read().catch(() => {});
	});
	return {
		status,
		wanted() {
			requested = true;
		},
	};
}

/** The folder's edit of row `id` of `table`, as this render read it. */
export function useRowEdit<TRowSchema extends TSchema>(
	table: FolderTable<TRowSchema>,
	id: string,
) {
	const edit = useMemo(() => table.edit(id), [table, id]);
	const row = useSyncExternalStore(edit.subscribe, edit.getRow, edit.getRow);
	const pending = useSyncExternalStore(
		edit.subscribe,
		edit.getPending,
		edit.getPending,
	);
	const locked = useSyncExternalStore(
		edit.subscribe,
		edit.isLocked,
		edit.isLocked,
	);
	const document = useDocument(edit);
	return {
		...edit,
		/** The row as last known stored, with held input in it, as this render read it. */
		getRow() {
			document.wanted();
			return row;
		},
		/** What is known of the file and how reading it goes, as this render read it. */
		getReadStatus() {
			document.wanted();
			return document.status;
		},
		/** The held input as this render read it, or `undefined`. */
		getPending: () => pending,
		/** Whether input was refused as this render read it. */
		isLocked: () => locked,
		/**
		 * Type fields and body over what this render showed, as one change.
		 * Answers acceptance into memory or the refusal reason; saving happens later.
		 */
		change(change: RowEditChange<TRowSchema>): ChangeResult {
			const now = edit.getRow();
			if (change.body === undefined || row === undefined || now === undefined)
				return edit.change(change);
			return edit.change({
				...change,
				body: mergeText(row.body, now.body, change.body),
			});
		},
	};
}

/** The folder's edit of the file at `path`, as this render read it. */
export function useTextEdit(files: FolderFiles, path: string) {
	const edit = useMemo(() => files.edit(path), [files, path]);
	const text = useSyncExternalStore(
		edit.subscribe,
		edit.getText,
		edit.getText,
	);
	const pending = useSyncExternalStore(
		edit.subscribe,
		edit.getPending,
		edit.getPending,
	);
	const locked = useSyncExternalStore(
		edit.subscribe,
		edit.isLocked,
		edit.isLocked,
	);
	const document = useDocument(edit);
	return {
		...edit,
		/** The held text, the held fields over the stored file, or the stored file as text, as this render read it. */
		getText() {
			document.wanted();
			return text;
		},
		getReadStatus() {
			document.wanted();
			return document.status;
		},
		getPending: () => pending,
		isLocked: () => locked,
		/** Type the whole text over what this render showed. Answers acceptance into memory or the refusal reason; saving happens later. */
		change(next: string): ChangeResult {
			const now = edit.getText();
			return edit.change(
				text === undefined || now === undefined
					? next
					: mergeText(text, now, next),
			);
		},
	};
}
