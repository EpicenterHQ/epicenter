/**
 * A React snapshot of one path-owned file edit. The folder owns input,
 * reading and saving. Document reads request an initial read after commit;
 * lock-only observers do not. Commands apply to the owner's current
 * source draft in call order, including multiple handlers in one event.
 */
import type { FileEdit } from '@epicenter/folder/edits';
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
	const locked = useSyncExternalStore(
		edit.subscribe,
		edit.isLocked,
		edit.isLocked,
	);
	const buffer = useSyncExternalStore(
		edit.subscribe,
		edit.getBuffer,
		edit.getBuffer,
	);
	// This render requests a first read only if one of its read methods is used.
	// An abandoned render never runs this effect.
	let requested = false;
	useEffect(() => {
		if (!requested) return;
		if (edit.getBuffer().status === 'unread') edit.read().catch(() => {});
	});
	return {
		...edit,
		getMarkdown() {
			requested = true;
			return value;
		},
		getText() {
			requested = true;
			return buffer.status === 'ready' ? buffer.text : undefined;
		},
		getBuffer() {
			requested = true;
			return buffer;
		},
		isLocked: () => locked,
	};
}
