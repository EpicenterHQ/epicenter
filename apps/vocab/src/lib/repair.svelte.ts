/**
 * The repair of one word file that does not read as a word, as its exact
 * text.
 *
 * A file whose frontmatter does not read needs its whole text replaced, so
 * the repair types through the file's text edit handle
 * (`folder.files.edit(path)`), over the stored row's exact bytes
 * (`rowBytes`). The folder holds what is typed, writes it a second after
 * the last keystroke and at once on `save()`, one write at a time, each from
 * the text it started from, merged by line with a change made elsewhere
 * meanwhile. A reread never replaces what is typed. A failed write keeps the
 * text and its error; the view's `retry()` tries again, and so does further typing. The
 * repair itself holds only which file is open.
 */
import { rowBytes } from '@epicenter/folder';
import { createTextEdit } from '@epicenter/svelte/edits';
import { type RowOf, rowPath, type VocabFolder } from './data.js';

export function createRepair(folder: Pick<VocabFolder, 'files'>) {
	/** The word file open for repair, by its row ID. */
	let open = $state<string | undefined>();

	/** The open file's edit handle. */
	const edit = () =>
		open === undefined
			? undefined
			: folder.files.edit(rowPath('entries', open));
	/** The open file's text over `stored`, the row a view shows; read reactively. */
	const view = (stored: RowOf<'entries'> | undefined) => {
		const handle = edit();
		return (
			handle &&
			createTextEdit(handle, () =>
				stored === undefined ? undefined : rowBytes(stored),
			)
		);
	};
	/** The open file's held text, read reactively. */
	const held = () => {
		const pending = view(undefined)?.pending;
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
		 * The open file's text as one view shows and types it, over `stored`,
		 * the row that view read: `text` is what is typed over its bytes, which
		 * a reread never replaces, and `change` types over what the view last
		 * showed. A view keeps one for the row it shows.
		 */
		view,
		/** Write what is typed now; resolves once no write of it runs. */
		save: (): Promise<void> => edit()?.save() ?? Promise.resolve(),
		/**
		 * Close the repair once its text is written. Answers whether it closed:
		 * text that could not be written keeps the repair open.
		 */
		async close(): Promise<boolean> {
			const handle = edit();
			await handle?.save();
			if (handle?.pending !== undefined) return false;
			open = undefined;
			return true;
		},
		/** Let go of the repair and what is typed into it, as the learner chose. */
		discard(): string | undefined {
			const handle = edit();
			const discarded = handle?.discard();
			// A write or delete of the text that runs keeps it, and the repair.
			if (handle?.pending !== undefined) return undefined;
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
