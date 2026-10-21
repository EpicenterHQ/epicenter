/**
 * A React snapshot of one path-owned file edit. The folder owns input,
 * reading and saving. Document reads request an initial read after commit;
 * pending-only observers do not. Commands merge body and source changes
 * against the committed render so another handler's changes survive.
 */
import {
	type ChangeResult,
	type DocumentChange,
	type FileEdit,
	mergeFileText,
	mergeText,
} from '@epicenter/folder/edits';
import { useEffect, useSyncExternalStore } from 'react';
import type { TSchema } from 'typebox';

/** One path-owned file edit, as this React render read it. */
export function useFileEdit<TDocumentSchema extends TSchema>(
	edit: FileEdit<TDocumentSchema>,
) {
	const value = useSyncExternalStore(
		edit.subscribe,
		edit.getMarkdown,
		edit.getMarkdown,
	);
	const text = useSyncExternalStore(edit.subscribe, edit.getText, edit.getText);
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
	const status = useSyncExternalStore(
		edit.subscribe,
		edit.getReadStatus,
		edit.getReadStatus,
	);
	// This render requests a first read only if one of its read methods is used.
	// An abandoned render never runs this effect.
	let requested = false;
	useEffect(() => {
		if (!requested) return;
		const { known, reading, error } = edit.getReadStatus();
		if (known === 'nothing' && !reading && error === undefined)
			edit.read().catch(() => {});
	});
	return {
		...edit,
		getMarkdown() {
			requested = true;
			return value;
		},
		getText() {
			requested = true;
			return text;
		},
		getReadStatus() {
			requested = true;
			return status;
		},
		getPending: () => pending,
		isLocked: () => locked,
		/** Merge a body typed over this render with changes from other handlers. */
		change(change: DocumentChange<TDocumentSchema>): ChangeResult {
			const now = edit.getMarkdown();
			if (change.body === undefined || value?.body === undefined || now?.body === undefined)
				return edit.change(change);
			return edit.change({
				...change,
				body: mergeText(value.body, now.body, change.body),
			});
		},
		/** Merge source typed over this render with changes from other handlers. */
		replaceText(next: string): ChangeResult {
			const now = edit.getText();
			return edit.replaceText(
				text === undefined || now === undefined
					? next
					: mergeFileText(edit.path, text, now, next),
			);
		},
	};
}
