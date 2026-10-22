/**
 * A React view of one folder editor: its cached snapshot, read through one
 * `useSyncExternalStore`. Subscribing starts the editor's first read; the
 * folder owns input, reading and saving. Commands stay on the editor handle
 * and apply to its live source in call order, including several handlers in
 * one event.
 */
import type { EditorSnapshot, FileEdit } from '@epicenter/folder/edits';
import { useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** The snapshot of `edit` this render reads. */
export function useFileEdit<TDocumentSchema extends TSchema>(
	edit: FileEdit<TDocumentSchema>,
): EditorSnapshot<TDocumentSchema> {
	return useSyncExternalStore(
		edit.subscribe,
		edit.getSnapshot,
		edit.getSnapshot,
	);
}
