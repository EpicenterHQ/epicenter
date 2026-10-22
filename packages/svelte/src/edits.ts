/**
 * A Svelte view of one folder editor: the snapshot's fields as tracked
 * getters, and the editor's commands. The folder owns the source, input,
 * timers, saves and failures as views come and go.
 *
 * One adapter per editor handle, so keyed widgets that acquire the same
 * editor share it, and one folder subscription per adapter while anything
 * tracks it. Reading a getter in an effect subscribes, which starts the
 * first read; the subscription's synchronous first notification is skipped,
 * because the getter reads the current snapshot itself right after tracking.
 * Construction is passive; derive the adapter from the editor address.
 */
import type {
	AnyFieldsSchema,
	FileEdit as FolderFileEdit,
} from '@epicenter/folder/edits';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';

const adapters = new WeakMap<object, unknown>();

/** The folder editor `fileEdit`, with its snapshot tracked by Svelte. */
export function createFileEdit<TDocumentSchema extends TSchema>(
	fileEdit: FolderFileEdit<TDocumentSchema>,
): FileEdit<TDocumentSchema> {
	let adapter = adapters.get(fileEdit) as FileEdit<TDocumentSchema> | undefined;
	if (adapter === undefined) {
		adapter = adapt(fileEdit);
		adapters.set(fileEdit, adapter);
	}
	return adapter;
}

function adapt<TDocumentSchema extends TSchema>(
	fileEdit: FolderFileEdit<TDocumentSchema>,
) {
	const track = createSubscriber((update) => {
		// As `fromStore` does: the subscription answers at once with what the
		// getter is about to read anyway.
		let ran = false;
		const stop = fileEdit.subscribe(() => {
			if (ran) update();
		});
		ran = true;
		return stop;
	});
	const snapshot = () => {
		track();
		return fileEdit.getSnapshot();
	};
	return {
		path: fileEdit.path,
		/** The text to edit and its interpretation, or `undefined` before or without text. */
		get content() {
			return snapshot().content;
		},
		/** Why the latest applicable read supplied no text. */
		get loadError() {
			return snapshot().loadError;
		},
		/** Accepted input no publication or delete has acknowledged yet. */
		get isDirty() {
			return snapshot().isDirty;
		},
		/** Text publications admitted and not settled. */
		get isSaving() {
			return snapshot().isSaving;
		},
		/** The last applicable failed publication, until a success or discard. */
		get saveError() {
			return snapshot().saveError;
		},
		replaceText: fileEdit.replaceText,
		change: fileEdit.change,
		save: fileEdit.save,
		refresh: fileEdit.refresh,
		discard: fileEdit.discard,
	};
}

export type FileEdit<TDocumentSchema extends TSchema = AnyFieldsSchema> =
	ReturnType<typeof adapt<TDocumentSchema>>;
