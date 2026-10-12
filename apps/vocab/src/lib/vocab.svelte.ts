/**
 * Vocab over one opened folder: the words and the chats, in one TanStack
 * Query cache (ADR-0528).
 *
 * Every write and action is a mutation, so leaving waits while one runs and
 * closing waits until none does; nothing asks to discard. Saves never commit
 * (ADR-0529), and Vocab offers no "Save version": its folder records history
 * only through a sync, which Vocab does not run.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber } from 'svelte/reactivity';
import { createChats } from './chat/chats.js';
import type { VocabFolder } from './data.js';
import { createEntries } from './entries.svelte.js';
import {
	CLOSING,
	setVocabDefaults,
	vocabKeys,
	type WriteFailure,
	whenIdle,
} from './query.js';

export type Vocab = ReturnType<typeof createVocab>;

export function createVocab(
	folder: VocabFolder,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
	}: {
		/** A write failed and was rolled back; the app tells the learner. */
		onWriteFailed?: (failure: WriteFailure) => void;
	} = {},
) {
	setVocabDefaults(queryClient);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	let closing: Promise<void> | undefined;
	const refused = () => (closing === undefined ? undefined : CLOSING);

	return {
		folder,
		queryClient,
		entries: createEntries(folder, queryClient, { refused, onWriteFailed }),
		chats: createChats(folder, queryClient, { refused, onWriteFailed }),
		/** Whether a write or another action is running or waiting; read reactively. Leaving then could lose it. */
		get busy() {
			trackMutations();
			return queryClient.isMutating() > 0;
		},
		/**
		 * Refuse new changes, wait until nothing is mutating, then release the
		 * folder. Every call answers the same completion.
		 */
		close(): Promise<void> {
			closing ??= (async () => {
				await whenIdle(queryClient);
				await queryClient.cancelQueries({ queryKey: vocabKeys.all });
				await folder.close();
			})();
			return closing;
		},
	};
}
