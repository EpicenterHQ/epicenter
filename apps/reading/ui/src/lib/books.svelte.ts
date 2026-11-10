/**
 * The books as the server last gave them, with this page's writes shown as
 * soon as they answer. Everything is asked of `epicenter serve` through the
 * app's actions; nothing is kept on the device.
 */
import { type ActionOutput, connect } from '@epicenter/app/client';
import type readingApp from '../../../epicenter.js';

type Actions = (typeof readingApp)['actions'];

/** Reading's actions, asked of the server that serves this UI. */
export const app = connect<typeof readingApp>('reading');

/** A row of `reading list`: a book's path and fields, without its notes; `problems` when its file does not fit. */
export type Book = ActionOutput<Actions['list']>[number];

/** What `reading get`, `set`, `start`, and `finish` answer: a book's path, fields, and notes. */
export type BookFile = ActionOutput<Actions['get']>;

function createShelf() {
	let rows = $state.raw<Book[]>([]);
	let loaded = $state(false);
	let problem = $state<string>();
	/** Counts writes, so a list asked for before a write does not undo it on screen. */
	let writes = 0;

	async function refresh() {
		const before = writes;
		try {
			const next = await app.list();
			if (before !== writes) return;
			rows = next;
			problem = undefined;
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		} finally {
			loaded = true;
		}
	}

	/** Show a book as a write answered it. */
	function changed(file: BookFile) {
		writes++;
		const { body: _, other: __, ...book } = file;
		rows = [...rows.filter((row) => row.path !== book.path), book];
	}

	return {
		/** Every book. */
		rows: () => rows,
		/** Whether the first list has come back. */
		loaded: () => loaded,
		/** Why the last list did not come back, if it did not. */
		problem: () => problem,
		refresh,
		changed,

		/** Run a write that answers a book, and show the book it answered. */
		async write(call: Promise<BookFile>) {
			writes++;
			const file = await call;
			changed(file);
			return file;
		},

		/** Delete the book at `path`; it leaves the list at once. */
		async remove(path: string) {
			writes++;
			rows = rows.filter((row) => row.path !== path);
			await app.delete({ path });
		},

		/**
		 * Keep the list current while the page is visible: on showing again,
		 * and every `every` milliseconds, so books an agent adds appear.
		 * Returns the cleanup.
		 */
		watch(every = 15_000) {
			const onShow = () => {
				if (document.visibilityState === 'visible') void refresh();
			};
			onShow();
			const timer = setInterval(onShow, every);
			document.addEventListener('visibilitychange', onShow);
			return () => {
				clearInterval(timer);
				document.removeEventListener('visibilitychange', onShow);
			};
		},
	};
}

/** The one shelf every page of the UI reads. */
export const shelf = createShelf();
