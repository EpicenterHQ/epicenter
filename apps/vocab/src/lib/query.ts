/**
 * Cache identity and shared rules for every query and mutation Vocab runs
 * (ADR-0528). The words, the chat list, and the text of a word being
 * repaired are queries; every write and action is a mutation.
 */
import type { FileError, TableError } from '@epicenter/folder';
import type { MutationFilters, QueryClient } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';

export const vocabKeys = defineKeys({
	/** Every query the app keeps. */
	all: ['vocab'],
	entries: ['vocab', 'entries'],
	chats: ['vocab', 'chats'],
	text: (path: string) => ['vocab', 'text', path] as const,
	/** Every write of a word or a word file's text. */
	writes: ['vocab', 'write'],
	write: (path: string) => ['vocab', 'write', 'row', path] as const,
	writeText: (path: string) => ['vocab', 'write', 'text', path] as const,
	add: ['vocab', 'add'],
	remove: (path: string) => ['vocab', 'remove', path] as const,
	startChat: ['vocab', 'start-chat'],
	/** Every message write of one chat. */
	message: (chatId: string) => ['vocab', 'message', chatId] as const,
});

/** A write that failed: what the learner is told, and the text it held. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | { name: string; message: string };
	/** The text that was on screen and is not in the file. */
	readonly lost: string;
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

/** Whether a word or a word file's text is being written. */
export const writing = (queryClient: QueryClient) =>
	queryClient.isMutating({ mutationKey: vocabKeys.writes }) > 0;

/**
 * Every query and mutation reads or writes this browser's folder, so none
 * waits for a network, and a failure is shown rather than retried. Nothing
 * goes stale on its own: reads happen on open, on window focus while nothing
 * is being written, and after the app's own actions.
 */
export function setVocabDefaults(queryClient: QueryClient) {
	queryClient.setQueryDefaults(vocabKeys.all, {
		networkMode: 'always',
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: () => (writing(queryClient) ? false : 'always'),
	});
	queryClient.setMutationDefaults(vocabKeys.all, {
		networkMode: 'always',
		retry: false,
	});
}
