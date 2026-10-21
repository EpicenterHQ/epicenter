/**
 * The repair of one word file that does not read as a word, as its exact
 * text.
 *
 * A file whose frontmatter does not read needs its whole text replaced, so
 * the repair types through the folder's edit of the file
 * (`createFileEdit(folder.tables.entries.edit(id))`), whose text is the file's
 * exact editable source. The folder holds what is typed, writes it a second after
 * the last keystroke and at once on `save()`, one write at a time, each from
 * the text it started from, merged by line with a change made elsewhere
 * meanwhile. A reread never replaces what is typed. A failed write keeps the
 * text and its error; `save()` tries again, and so does further
 * typing. The repair itself holds only which file is open.
 */
import { createFileEdit } from '@epicenter/svelte/edits';
import type { VocabFolder } from './data.js';

export function createRepair(folder: Pick<VocabFolder, 'tables'>) {
	/** The word file open for repair, by its row ID. */
	let open = $state<string | undefined>();

	/** Recreate the adapter only when the selected path changes. */
	const fileEdit = $derived(
		open === undefined
			? undefined
			: createFileEdit(folder.tables.entries.edit(open)),
	);
	const view = () => fileEdit;
	return {
		/** The row ID of the word file open for repair, if any. */
		get open() {
			return open;
		},
		/**
		 * Open the word file `id` for repair. The folder keeps input for other files.
		 */
		start(id: string): boolean {
			if (open === id) return true;
			open = id;
			return true;
		},
		/**
		 * The open file's text as views show and type it: what is typed over
		 * the file as stored, which a reread never replaces.
		 */
		view,
		/** Return to the structured view as soon as the current document is valid. */
		close(): boolean {
			if (view()?.markdown?.issues !== null) return false;
			open = undefined;
			return true;
		},
		/** Discard this path's input, then close unless a running operation retains it. */
		discard() {
			const fileEdit = view();
			fileEdit?.discard();
			if (fileEdit?.pending !== undefined) return;
			open = undefined;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
