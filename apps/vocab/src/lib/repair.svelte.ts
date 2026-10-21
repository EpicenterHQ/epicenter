/**
 * The repair of one word file that does not read as a word, as its exact
 * text.
 *
 * A file whose frontmatter does not read needs its whole text replaced, so
 * the repair types through the folder's edit of the file
 * (`createTextEdit(folder.files, path)`), whose document is the file's exact
 * text as stored. The folder holds what is typed, writes it a second after
 * the last keystroke and at once on `save()`, one write at a time, each from
 * the text it started from, merged by line with a change made elsewhere
 * meanwhile. A reread never replaces what is typed. A failed write keeps the
 * text and its error; the view's `retry()` tries again, and so does further
 * typing. The repair itself holds only which file is open.
 */
import { createTextEdit } from '@epicenter/svelte/edits';
import { rowPath, type VocabFolder } from './data.js';

export function createRepair(folder: Pick<VocabFolder, 'files'>) {
	/** The word file open for repair, by its row ID. */
	let open = $state<string | undefined>();

	/** The folder's edit of the open file, read reactively. */
	const view = () =>
		open === undefined
			? undefined
			: createTextEdit(folder.files, rowPath('entries', open));
	/** The open file's held text, read reactively; reading it reads no file. */
	const held = () => {
		const pending = view()?.pending;
		return pending?.kind === 'text' ? pending : undefined;
	};

	return {
		/** The row ID of the word file open for repair, if any. */
		get open() {
			return open;
		},
		/**
		 * Open the word file `id` for repair. Answers whether it is open: text
		 * still held for another file keeps that one open.
		 */
		start(id: string): boolean {
			if (open === id) return true;
			if (held() !== undefined) return false;
			open = id;
			return true;
		},
		/**
		 * The open file's text as views show and type it: what is typed over
		 * the file as stored, which a reread never replaces.
		 */
		view,
		/** Write what is typed now; resolves once no write of it runs. */
		save: (): Promise<void> => view()?.save() ?? Promise.resolve(),
		/**
		 * Close the repair once its text is written. Answers whether it closed:
		 * text that could not be written keeps the repair open.
		 */
		async close(): Promise<boolean> {
			const textEdit = view();
			await textEdit?.save();
			if (textEdit?.pending !== undefined) return false;
			open = undefined;
			return true;
		},
		/** Let go of the repair and what is typed into it, as the learner chose. */
		discard(): string | undefined {
			const textEdit = view();
			const discarded = textEdit?.discard();
			// A write or delete of the text that runs keeps it, and the repair.
			if (textEdit?.pending !== undefined) return undefined;
			open = undefined;
			return discarded?.kind === 'text' ? discarded.text : undefined;
		},
		get typed() {
			return held()?.text;
		},
		get saving() {
			return held()?.saving ?? false;
		},
		/** Why the last write failed, while the text is held. */
		get error() {
			return held()?.error;
		},
		/** Whether text is held or written: leaving then could lose it. */
		get busy() {
			return held() !== undefined;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
