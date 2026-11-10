/** The server's note list, with this page's completed writes shown at once. */
import { type ActionOutput, connect } from '@epicenter/app/client';
import type notesApp from '../../../epicenter.js';
import { order } from './notes.js';

type Actions = (typeof notesApp)['actions'];
export const app = connect<typeof notesApp>('notes');
export type Note = ActionOutput<Actions['list']>[number];
export type NoteFile = ActionOutput<Actions['get']>;

function createNoteList() {
	let rows = $state.raw<Note[]>([]);
	let loaded = $state(false);
	let problem = $state<string>();
	const fresh = new Set<string>();
	/** A list asked before a write must not undo it on screen. */
	let writes = 0;

	async function refresh() {
		const before = writes;
		try {
			const next = await app.list();
			if (before !== writes) return;
			rows = next;
			problem = undefined;
		} catch (error) {
			if (before === writes)
				problem = error instanceof Error ? error.message : String(error);
		} finally {
			loaded = true;
		}
	}

	return {
		rows: () => order(rows),
		loaded: () => loaded,
		problem: () => problem,
		refresh,
		async add() {
			writes++;
			const { body: _, other: __, added: ___, ...row } = await app.add({});
			writes++;
			rows = [...rows.filter((item) => item.path !== row.path), row];
			fresh.add(row.path);
			return row;
		},
		isFresh: (path: string) => fresh.has(path),
		changed(file: NoteFile) {
			writes++;
			const { body: _, other: __, ...row } = file;
			rows = [...rows.filter((item) => item.path !== row.path), row];
			fresh.delete(row.path);
		},
		async remove(path: string) {
			writes++;
			await app.delete({ path });
			writes++;
			rows = rows.filter((row) => row.path !== path);
			fresh.delete(path);
		},
		/** Poll only while visible, and refresh when this page is shown again. */
		watch(every = 15_000) {
			const onShow = () => {
				if (document.visibilityState === 'visible') void refresh();
			};
			onShow();
			const timer = setInterval(onShow, every);
			document.addEventListener('visibilitychange', onShow);
			window.addEventListener('focus', onShow);
			return () => {
				clearInterval(timer);
				document.removeEventListener('visibilitychange', onShow);
				window.removeEventListener('focus', onShow);
			};
		},
	};
}

/** The one note list every page reads. */
export const notes = createNoteList();
