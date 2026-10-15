/**
 * Vocab over one opened folder: the words and the chats, in one TanStack
 * Query cache (ADR-0528, ADR-0548).
 *
 * Every read is a query under the folder's keys, and the folder's one
 * channel of outside change, `onFilesChanged`, invalidates exactly the
 * queries a change reached. Every write and action is a mutation, so leaving
 * waits while one runs and closing waits until none does; nothing asks to
 * discard. Saves never commit (ADR-0529), and Vocab offers no "Save
 * version": its folder records history only through a sync, which Vocab
 * does not run.
 */
import { folderOptions, whenIdle } from '@epicenter/folder/query';
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber } from 'svelte/reactivity';
import { createChats } from './chat/chats.js';
import type { VocabFolder } from './data.js';
import { createEntries, type ReplacedNotice } from './entries.svelte.js';
import { CLOSING, setVocabDefaults, type WriteFailure } from './query.js';

export type Vocab = ReturnType<typeof createVocab>;

export function createVocab(
	folder: VocabFolder,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
		onReplaced = () => {},
	}: {
		/** A write failed; the app tells the learner. */
		onWriteFailed?: (failure: WriteFailure) => void;
		/** A save replaced a value changed elsewhere; the app tells the learner. */
		onReplaced?: (notice: ReplacedNotice) => void;
	} = {},
) {
	const folder$ = folderOptions(folder);
	setVocabDefaults(queryClient);
	const stopChanges = folder$.invalidateOnChange(queryClient);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	let closing: Promise<void> | undefined;
	const refused = () => (closing === undefined ? undefined : CLOSING);

	return {
		folder,
		folder$,
		queryClient,
		entries: createEntries(folder, folder$, queryClient, {
			refused,
			onWriteFailed,
			onReplaced,
		}),
		chats: createChats(folder, folder$, queryClient, {
			refused,
			onWriteFailed,
		}),
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
				stopChanges();
				await queryClient.cancelQueries({ queryKey: folder$.key });
				await folder.close();
			})();
			return closing;
		},
	};
}
