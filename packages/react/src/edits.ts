/**
 * `@epicenter/react/edits`: a folder's edit handles in a React view.
 *
 * `useRowEdit(folder.tables.notes.edit(id), row)` and
 * `useTextEdit(folder.files.edit(path), bytes)` take the source this render
 * shows. What the render shows over it (`edit.shown`: held input and the
 * folder's own saves its read may not show yet), the held input, and whether
 * input is refused are external store snapshots: each keeps its identity
 * until it changes, and a view re-renders when one does. Typing through the
 * result names what that same render showed, so a handler from the committed
 * render never sends what a suspended or discarded render saw. The folder
 * keeps the input, its timers, saves and failures, whatever views mount and
 * unmount.
 */
import type { Row } from '@epicenter/folder';
import type {
	ExclusiveFile,
	FieldsPending,
	RowEdit,
	RowEditChange,
	RowPending,
	TextEdit,
	TextPending,
} from '@epicenter/folder/edits';
import { useMemo, useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** The byte-order mark stays in the text, as saving it back expects. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Read `snapshot` as this render's value of `edit`'s store. */
function useEditStore<T>(
	edit: { subscribe: RowEdit['subscribe'] },
	snapshot: () => T,
) {
	// Every handle of a folder shares one `subscribe`, so a handle made in
	// each render subscribes once.
	return useSyncExternalStore(edit.subscribe, snapshot, snapshot);
}

/** Text shown over `TObserved`: definite when the bytes always are. */
type ShownText<TObserved extends Uint8Array | undefined> =
	TObserved extends Uint8Array ? string : string | undefined;

/**
 * Row `edit` over `observed`, the row this render shows. `row` is as definite
 * as that source: one that can be `undefined`, while a read loads or after
 * the row is gone, gives a `row` that can be `undefined`. Held input stays
 * readable through `pending` either way.
 */
export function useRowEdit<
	TRowSchema extends TSchema,
	TObserved extends Row<TRowSchema> | undefined,
>(edit: RowEdit<TRowSchema>, observed: TObserved) {
	const shown = useEditStore(edit, () =>
		observed === undefined
			? undefined
			: edit.shown(observed as NonNullable<TObserved>),
	);
	const pending = useEditStore<RowPending<TRowSchema> | undefined>(
		edit,
		() => edit.pending,
	);
	const locked = useEditStore(edit, () => edit.locked);
	return {
		path: edit.path,
		/** `observed` with the folder's own saves and the held input over it. */
		row: shown?.row as TObserved,
		/** The held input, or `undefined`. */
		pending,
		/** Whether input is refused: another action holds the file, or the folder closes. */
		locked,
		/**
		 * Type fields and body over what this render showed, as one change.
		 * Answers whether it was taken.
		 */
		change: (change: RowEditChange<TRowSchema>): boolean =>
			shown !== undefined && edit.change(shown.source, change),
		save: () => edit.save(),
		retry: () => edit.retry(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
	};
}

/**
 * File `edit` over `observed`, the bytes this render shows. `text` is as
 * definite as that source; held text stays readable through `pending`, and
 * with nothing observed `text` still shows held text or the folder's own
 * saved text, to read and copy.
 */
export function useTextEdit<TObserved extends Uint8Array | undefined>(
	edit: TextEdit,
	observed: TObserved,
) {
	const shown = useEditStore(edit, () => edit.shown(observed));
	const pending = useEditStore<TextPending | FieldsPending | undefined>(
		edit,
		() => edit.pending,
	);
	const locked = useEditStore(edit, () => edit.locked);
	// Held fields that no longer apply leave the source to show.
	const text = useMemo(
		() =>
			shown.text ??
			(shown.source === undefined ? undefined : decoder.decode(shown.source)),
		[shown],
	);
	return {
		path: edit.path,
		/** The held text or fields over this render's bytes, else those bytes as text. */
		text: text as ShownText<TObserved>,
		pending,
		locked,
		/** Type the whole text over what this render showed. Answers whether it was taken. */
		change: (next: string): boolean => edit.change(shown.source, next),
		/** Type frontmatter fields over what this render showed. */
		changeFields: (fields: Readonly<Record<string, unknown>>): boolean =>
			edit.changeFields(shown.source, fields),
		save: () => edit.save(),
		retry: () => edit.retry(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
		exclusive: <T>(action: (file: ExclusiveFile) => Promise<T>) =>
			edit.exclusive(action),
	};
}
