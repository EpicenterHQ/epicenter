/**
 * Vocab over the folder `<FolderApp>` opened: the words and the chats, in the
 * page's one TanStack Query cache (ADR-0528, ADR-0548, ADR-0574).
 *
 * Every read is a query under the folder's keys, and `<FolderApp>` wires the
 * folder's one channel of outside change, `onFilesChanged`, to invalidate
 * exactly the queries a change reached. Every write goes through the
 * folder's edit layer (`edits`) and every other action is a mutation, so
 * leaving waits while one runs and closing waits until none does; nothing
 * asks to discard. Saves never commit (ADR-0529), and Vocab
 * offers no "Save version": its folder records history only through a sync,
 * which Vocab does not run.
 */
import type { FolderContext } from '@epicenter/svelte/folder';
import { createChats } from './chat/chats.js';
import type { vocabFolder } from './data.js';
import { createEntries } from './entries.svelte.js';

export type Vocab = ReturnType<typeof createVocab>;

/** The opened Vocab folder, as `getFolder()` answers it. */
export type VocabContext = FolderContext<typeof vocabFolder>;

export function createVocab(context: VocabContext) {
	const { folder, queries, queryClient, writeFailed, edits } = context;

	return {
		folder,
		queries,
		queryClient,
		/** The folder's edit layer: every draft and write. */
		edits,
		entries: createEntries(folder, queries, queryClient, edits),
		chats: createChats(folder, queries, queryClient, {
			refused: () => edits.refusal(),
			writeFailed,
			inTurn: edits.writes.inTurn,
		}),
		/** Whether text typed, a write, or another action is running or waiting; read reactively. Leaving then could lose it. */
		get busy() {
			return edits.busy;
		},
	};
}
