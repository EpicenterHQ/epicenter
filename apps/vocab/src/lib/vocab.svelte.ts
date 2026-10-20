/**
 * Vocab over the local folder `<FolderApp>` opened: the words and the
 * chats, in the page's one TanStack Query cache.
 *
 * Every read is a query of the context (`queries.rows`), and the context
 * wires the folder's one channel of change, `onChange`, to mark the tables a
 * committed save names stale, whichever handle or tab made it. A word's note
 * and stage are typed through its row's edit handle, and a repair through
 * its file's text edit handle; the folder holds both, and the context counts
 * them. Adding a word, starting a chat, and saving a message are counted by
 * the folder context so leaving the page waits while one runs. Closing the
 * context waits for every save that started. Nothing is synced and nothing
 * records a version.
 */
import type { FolderContext } from '@epicenter/svelte/folder';
import { createChats } from './chat/chats.js';
import type { VocabTables } from './data.js';
import { createEntries } from './entries.svelte.js';

export type Vocab = ReturnType<typeof createVocab>;

/** The opened Vocab folder, as `getFolder()` answers it. */
export type VocabContext = FolderContext<VocabTables>;

export function createVocab(local: VocabContext) {
	const entries = createEntries(local);
	const chats = createChats(local);

	return {
		folder: local.folder,
		queries: local.queries,
		queryClient: local.queryClient,
		entries,
		chats,
		/**
		 * Whether typing is held, a save or action runs, or the repair holds
		 * text; read reactively. Leaving then could lose it.
		 */
		get busy() {
			return local.busy;
		},
	};
}
