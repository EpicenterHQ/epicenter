/**
 * Vocab over the folder `<FolderApp>` opened: the words and the chats, in the
 * page's one TanStack Query cache (ADR-0528, ADR-0548, ADR-0574).
 *
 * Every read is a query under the folder's keys, and `<FolderApp>` wires the
 * folder's one channel of outside change, `onFilesChanged`, to invalidate
 * exactly the queries a change reached. Every write and action is a
 * mutation, so leaving waits while one runs and closing waits until none
 * does; nothing asks to discard. Saves never commit (ADR-0529), and Vocab
 * offers no "Save version": its folder records history only through a sync,
 * which Vocab does not run.
 */
import type { FolderContext } from '@epicenter/svelte/folder';
import { createSubscriber } from 'svelte/reactivity';
import { createChats } from './chat/chats.js';
import type { vocabFolder } from './data.js';
import { createEntries } from './entries.svelte.js';
import { CLOSING } from './query.js';

export type Vocab = ReturnType<typeof createVocab>;

/** The opened Vocab folder, as `getFolder()` answers it. */
export type VocabContext = FolderContext<typeof vocabFolder>;

export function createVocab(context: VocabContext) {
	const { folder, queries, queryClient, writeFailed } = context;
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	let closing = false;
	const refused = () => (closing ? CLOSING : undefined);
	// Once the folder starts closing, no change starts; `<FolderApp>` then
	// waits for every write and action and releases the folder.
	context.beforeClose(() => {
		closing = true;
	});

	return {
		folder,
		queries,
		queryClient,
		entries: createEntries(folder, queries, queryClient, {
			refused,
			writeFailed,
		}),
		chats: createChats(folder, queries, queryClient, {
			refused,
			writeFailed,
		}),
		/** Whether a write or another action is running or waiting; read reactively. Leaving then could lose it. */
		get busy() {
			trackMutations();
			return queryClient.isMutating() > 0;
		},
	};
}
