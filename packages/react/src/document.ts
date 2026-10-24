/**
 * A React view of one shared working document: its cached snapshot, read
 * through `useSyncExternalStore`. Subscribing starts acquisition; the
 * folder owns input, reading and saving. Commands stay on the document handle
 * and apply to its live source in call order, including several handlers in
 * one event.
 */
import type { DocumentSnapshot, TextDocument } from '@epicenter/folder/document';
import { useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** The cached text and status of `document` this render reads. */
export function useDocument<TDocumentSchema extends TSchema>(
	document: TextDocument<TDocumentSchema>,
): DocumentSnapshot {
	return useSyncExternalStore(
		document.subscribe,
		document.getSnapshot,
		document.getSnapshot,
	);
}
