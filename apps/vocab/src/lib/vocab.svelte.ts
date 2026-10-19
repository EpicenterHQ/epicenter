/**
 * Vocab over the local folder `<FolderApp>` opened: the words and the
 * chats, in the page's one TanStack Query cache.
 *
 * Every read is a query of the context (`queries.rows`), and the context
 * wires the folder's one channel of change, `onChange`, to mark the tables a
 * committed save names stale, whichever handle or tab made it. A word's note
 * and stage are its row draft (`edits.row`); adding a word, starting a chat,
 * and saving a message are Vocab's own actions, counted here so leaving the
 * page waits while one runs. Closing the context waits for every save that
 * started. Nothing is synced and nothing records a version.
 */
import type { FolderContext } from '@epicenter/svelte/folder';
import { createChats } from './chat/chats.js';
import type { VocabTables } from './data.js';
import { createEntries } from './entries.svelte.js';

export type Vocab = ReturnType<typeof createVocab>;

/** The opened Vocab folder, as `getFolder()` answers it. */
export type VocabContext = FolderContext<VocabTables>;

/** Run Vocab's own actions, and say reactively whether one runs. */
export function createActions() {
	let running = $state(0);
	const pending = new Set<Promise<unknown>>();
	return {
		/** Count `work` as running until it settles. */
		track<T>(work: () => Promise<T>): Promise<T> {
			running++;
			const result = Promise.resolve()
				.then(work)
				.finally(() => {
					running--;
					pending.delete(result);
				});
			pending.add(result);
			return result;
		},
		async settle() {
			await Promise.allSettled([...pending]);
		},
		get running() {
			return running > 0;
		},
		get busy() {
			return running > 0;
		},
		get failed() {
			return false;
		},
	};
}

export type Actions = ReturnType<typeof createActions>;

export function createVocab(local: VocabContext) {
	const actions = createActions();
	const entries = createEntries(local, actions);
	const chats = createChats(local, actions);
	local.registerWork(actions);
	local.registerWork({
		get busy() {
			return entries.repair.busy;
		},
		get failed() {
			return entries.repair.error !== undefined;
		},
		settle: () => entries.repair.save(),
	});

	return {
		folder: local.folder,
		queries: local.queries,
		queryClient: local.queryClient,
		entries,
		chats,
		/** Adds, chat starts, and message saves; `running` says whether one runs. */
		actions,
		/**
		 * Whether typing is held, a save or action runs, or the repair holds
		 * text; read reactively. Leaving then could lose it.
		 */
		get busy() {
			return local.busy;
		},
	};
}
