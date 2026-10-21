/**
 * A Svelte view of one path-owned file edit. Text and Markdown getters
 * observe the same source draft; commands go directly to its folder owner.
 *
 * A tracked document read starts the first file read when nothing is known.
 * Lock observers request no initial read. The folder keeps input,
 * timers, saves and failures as views come and go. Construction is passive;
 * recreate the adapter reactively only when its address changes.
 */
import type {
	AnyFieldsSchema,
	FileEdit as FolderFileEdit,
} from '@epicenter/folder/edits';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';

/** The path-owned file edit, with its reads tracked by Svelte. */
export function createFileEdit<TDocumentSchema extends TSchema>(
	fileEdit: FolderFileEdit<TDocumentSchema>,
) {
	const { getText, getMarkdown, getBuffer, isLocked, ...commands } = fileEdit;
	// Lock observers do not request an initial file read.
	const trackChanges = createSubscriber((update) => fileEdit.subscribe(update));
	const trackRead = createSubscriber((update) => {
		const stop = fileEdit.subscribe(update);
		if (getBuffer().status === 'unread') fileEdit.read().catch(() => {});
		return stop;
	});
	return {
		...commands,
		/** Current source, including the unsaved draft. */
		get text() {
			trackRead();
			return getText();
		},
		/** The same source interpreted with this edit's schema. */
		get markdown() {
			trackRead();
			return getMarkdown();
		},
		/** Availability, current text, and its nested unsaved save lifecycle. */
		get buffer() {
			trackRead();
			return getBuffer();
		},
		get locked() {
			trackChanges();
			return isLocked();
		},
	} as const;
}

export type FileEdit<TDocumentSchema extends TSchema = AnyFieldsSchema> =
	ReturnType<typeof createFileEdit<TDocumentSchema>>;
