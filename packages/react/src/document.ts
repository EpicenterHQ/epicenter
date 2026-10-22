/**
 * A React view of one shared working document: its cached snapshot, read
 * through `useSyncExternalStore`. Subscribing starts acquisition; the
 * folder owns input, reading and saving. Commands stay on the document handle
 * and apply to its live source in call order, including several handlers in
 * one event.
 */
import type {
	DocumentSnapshot,
	FileDocument,
} from '@epicenter/folder/document';
import { useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** The snapshot of `edit` this render reads. */
export function useDocument<TDocumentSchema extends TSchema>(
	edit: FileDocument<TDocumentSchema>,
): DocumentSnapshot<TDocumentSchema> {
	return useSyncExternalStore(
		edit.subscribe,
		edit.getSnapshot,
		edit.getSnapshot,
	);
}
