/**
 * Test helper: Vocab over the local folder context, without mounting
 * components.
 *
 * The context's query client comes from `@tanstack/query-core`, which
 * `svelte-query` re-exports; the catalog pins both to one copy. A screen that
 * shows a query observes it; `observe` stands in for that, so a change the
 * folder reports reads it again as it does in the app.
 */
import { QueryObserver } from '@tanstack/query-core';
import type { Entry, VocabFolder } from './data.js';
import type { EntryRows } from './entries.svelte.js';
import type { Vocab } from './vocab.svelte.js';

const { createFolderContext } = await import('@epicenter/svelte/folder');
const { createVocab } = await import('./vocab.svelte.js');
const { wordsOf } = await import('./entries.svelte.js');

/**
 * Vocab over `folder`, with its screens observing, read once. The folder's
 * open options say how long a note waits after the last keystroke.
 */
export async function openVocab(folder: VocabFolder) {
	const context = createFolderContext(folder);
	const vocab = createVocab(context);
	const stop = observe(vocab);
	await quiet(vocab);
	return {
		vocab,
		context,
		async [Symbol.asyncDispose]() {
			stop();
			await context.close();
		},
	};
}

/**
 * Observe the word rows and the chat list, as the open screens do. Returns
 * the function that stops observing.
 */
export function observe(vocab: Vocab) {
	const observers = [
		new QueryObserver(vocab.queryClient, vocab.entries.entriesQuery()),
		new QueryObserver(vocab.queryClient, vocab.chats.chatsQuery()),
	];
	const edits = new Map<string, () => void>();
	const stops = observers.map((observer, index) =>
		observer.subscribe((result) => {
			if (index !== 0 || !Array.isArray(result.data)) return;
			for (const row of result.data) {
				if (edits.has(row.id)) continue;
				const edit = vocab.folder.tables.entries.document(row.id);
				edits.set(
					row.id,
					edit.subscribe(() => {}),
				);
			}
		}),
	);
	return () => {
		for (const stop of stops) stop();
		for (const stop of edits.values()) stop();
	};
}

/**
 * Wait until no save or read runs. Typing that waits for its pause is not
 * waited for; tests await actions they start.
 */
export async function quiet(vocab: Vocab) {
	const idle = () =>
		!vocab.folder.getStatus().saving &&
		!vocab.entries.repair.view()?.isSaving &&
		vocab.queryClient.isFetching() === 0 &&
		rows(vocab).every((row) => {
			const snapshot = vocab.folder.tables.entries
				.document(row.id)
				.getSnapshot();
			return snapshot.content !== undefined || snapshot.loadError !== undefined;
		});
	for (let tries = 0; tries < 400; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The word rows the cache holds now. */
export function rows(vocab: Vocab): EntryRows {
	const data = vocab.queryClient.getQueryData<EntryRows>(
		vocab.entries.entriesQuery().queryKey,
	);
	if (data === undefined) throw new Error('The word rows are not loaded');
	return data;
}

/** The word the cache holds with `text`. */
export function cached(vocab: Vocab, text: string): Entry {
	const entry = wordsOf(rows(vocab)).find(
		(candidate) => candidate.text === text,
	);
	if (entry === undefined) throw new Error(`${text} is not in the cache`);
	return entry;
}
