/**
 * The repair of one word file that does not read as a word, as its exact
 * text.
 *
 * The local folder's row drafts (`edits.row`) hold fields and a body; a file
 * whose frontmatter does not read needs its whole text replaced, so the
 * repair keeps its own text draft and writes through `folder.files`. What is
 * typed is written a second after the last keystroke and at once on
 * `save()`, one write at a time. Each write names the text it started from,
 * so the folder merges it by line with a change made elsewhere meanwhile. A
 * reread never replaces what is typed. A failed write keeps the text and its
 * error; `save()` tries again, and so does further typing.
 */
import { SAVE_AFTER_MS } from '@epicenter/svelte/edits';
import { ActionError } from '@epicenter/svelte/write-failure';
import type { SaveError } from '@epicenter/folder';
import { rowPath, type VocabFolder } from './data.js';
import { CLOSING, untilClosed } from './failure.js';

export function createRepair(
	folder: Pick<VocabFolder, 'files'>,
	{
		saveAfterMs = SAVE_AFTER_MS,
		fenced,
	}: {
		saveAfterMs?: number;
		/** Whether the folder refuses new input. */
		fenced: () => boolean;
	},
) {
	/** The word file open for repair, by its row ID. */
	let open = $state<string | undefined>();
	/** The text typed and not yet written. */
	let typed = $state<string | undefined>();
	let saving = $state(false);
	let error = $state<SaveError | ActionError | undefined>();
	/** The text the next write starts from: the file as read, then as last written. */
	let base: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let again = false;

	function clearTimer() {
		clearTimeout(timer);
		timer = undefined;
	}

	async function drain(id: string) {
		do {
			again = false;
			const sending = typed;
			if (sending === undefined || base === undefined) return;
			saving = true;
			const written = await untilClosed(
				() => folder.files.write(rowPath('entries', id), base ?? null, sending),
				() => ActionError.NotStarted({ reason: CLOSING }),
			);
			saving = false;
			if (written.error !== null) {
				error = written.error;
				return;
			}
			error = undefined;
			base = sending;
			if (typed === sending) typed = undefined;
			else again = true;
		} while (again);
	}

	function save(): Promise<void> {
		clearTimer();
		const id = open;
		if (id === undefined) return Promise.resolve();
		if (running !== undefined) {
			again = true;
			return running;
		}
		running = drain(id).finally(() => {
			running = undefined;
		});
		return running;
	}

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
			if (typed !== undefined || saving) return false;
			clearTimer();
			open = id;
			base = undefined;
			error = undefined;
			return true;
		},
		/** `current` with what is typed over it; a reread never replaces the typing. */
		shown(current: string): string {
			return typed ?? current;
		},
		/**
		 * Type `text` into the file shown as `current`. The first change starts
		 * from `current`. Answers whether it was taken.
		 */
		change(current: string, text: string): boolean {
			if (open === undefined || fenced()) return false;
			if (typed === undefined) base = current;
			typed = text;
			clearTimer();
			timer = setTimeout(() => void save(), saveAfterMs);
			return true;
		},
		/** Write what is typed now; resolves once no write of it runs. */
		save,
		/**
		 * Close the repair once its text is written. Answers whether it closed:
		 * text that could not be written keeps the repair open.
		 */
		async close(): Promise<boolean> {
			await save();
			if (typed !== undefined) return false;
			open = undefined;
			base = undefined;
			error = undefined;
			return true;
		},
		/** Let go of the repair and what is typed into it, as the learner chose. */
		discard(): string | undefined {
			if (saving) return undefined;
			clearTimer();
			const text = typed;
			typed = undefined;
			open = undefined;
			base = undefined;
			error = undefined;
			return text;
		},
		get typed() {
			return typed;
		},
		get saving() {
			return saving;
		},
		/** Why the last write failed, while the text is held. */
		get error() {
			return error;
		},
		/** Whether text is held or written: leaving then could lose it. */
		get busy() {
			return typed !== undefined || saving;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
