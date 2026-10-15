/**
 * Cache identity and shared rules for every query and mutation Vocab runs
 * (ADR-0528, ADR-0548). Every folder read is a query under the folder's own
 * keys (`folderOptions`), so a change the folder reports reaches it; every
 * write and action is a mutation.
 */
import type { FileError, TableError } from '@epicenter/folder';
import type { FolderOptions } from '@epicenter/folder/query';
import type { MutationFilters, QueryClient } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import type { vocabFolder } from './data.js';

/** The query option factories over Vocab's opened folder. */
export type VocabOptions = FolderOptions<typeof vocabFolder>;

/** Keys of Vocab's own actions; reads and row saves use the folder's keys. */
export const vocabKeys = defineKeys({
	/** Every action Vocab defines itself. */
	all: ['vocab'],
	add: ['vocab', 'add'],
	remove: (path: string) => ['vocab', 'remove', path] as const,
	startChat: ['vocab', 'start-chat'],
	/** Every message write of one chat. */
	message: (chatId: string) => ['vocab', 'message', chatId] as const,
});

/** A write that failed: what the learner is told, and how to recover. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | { name: string; message: string };
	/** The text that was on screen and is not in the file; `''` when none is lost. */
	readonly lost: string;
	/** Send the edit again; set when the edit is still held on screen. */
	readonly retry?: () => void;
};

/** Why a change did not start: the page is closing. */
export const CLOSING = 'Vocab is closing, so nothing was changed.';

/**
 * Resolves once nothing matching `filters` is mutating. It watches the
 * mutation cache, so a mutation that starts meanwhile is waited for too.
 */
export function whenIdle(
	queryClient: QueryClient,
	filters?: MutationFilters,
): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating(filters) > 0) return;
			unsubscribe();
			resolve();
		}
		check();
	});
}

/**
 * Every query and mutation reads or writes this browser's folder, so none
 * waits for a network, and a failure is shown rather than retried. Nothing
 * goes stale on its own and returning to the window reads nothing: a query
 * is read again when the folder reports a change to what it holds.
 */
export function setVocabDefaults(
	queryClient: QueryClient,
	folder$: Pick<VocabOptions, 'key'>,
) {
	queryClient.setQueryDefaults(folder$.key, {
		networkMode: 'always',
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	for (const mutationKey of [vocabKeys.all, folder$.key])
		queryClient.setMutationDefaults(mutationKey, {
			networkMode: 'always',
			retry: false,
		});
}
