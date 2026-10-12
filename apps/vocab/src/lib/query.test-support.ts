/**
 * Test helper: TanStack Query for tests that drive Vocab without mounting
 * components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This loads the same `@tanstack/query-core` build that
 * `@tanstack/svelte-query` re-exports, so a mounted test that mixes the two
 * shares one copy of every class and manager.
 *
 * A screen that shows a query observes it; `observe` stands in for that, so
 * invalidation and window focus read it again as they do in the app.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as Query from '@tanstack/svelte-query';
import { type Entry, readEntry, readRows } from './data.js';
import type { EntryListing } from './entries.svelte.js';
import { vocabKeys } from './query.js';
import type { Vocab } from './vocab.svelte.js';

const svelteQuery = realpathSync(
	dirname(
		Bun.resolveSync('@tanstack/svelte-query/package.json', import.meta.dir),
	),
);
// Loaded synchronously: Bun does not finish a top-level await in an imported
// module before its importer runs.
const core = require(
	join(svelteQuery, '../query-core/build/modern/index.js'),
) as typeof Query;

export const { QueryClient, QueryObserver, focusManager } = core;

/** A fresh cache, mounted as the layout's provider mounts it, so it hears focus. */
export function createQueryClient() {
	const client = new QueryClient();
	client.mount();
	return client;
}

/**
 * Observe the word listing and the chat list, and the text of each path in
 * `paths`, as the open screens do. Returns the function that stops observing.
 */
export function observe(vocab: Vocab, ...paths: string[]) {
	const observers = [
		new QueryObserver(vocab.queryClient, vocab.entries.entriesQuery()),
		new QueryObserver(vocab.queryClient, vocab.chats.chatsQuery()),
		...paths.map(
			(path) =>
				new QueryObserver(vocab.queryClient, vocab.entries.textQuery(path)),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is mutating or fetching. */
export async function quiet(vocab: Vocab) {
	const client = vocab.queryClient;
	for (let tries = 0; tries < 400; tries++) {
		if (client.isMutating() === 0 && client.isFetching() === 0) {
			await Bun.sleep(0);
			if (client.isMutating() === 0 && client.isFetching() === 0) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The word listing the cache holds now. */
export function listing(vocab: Vocab): EntryListing {
	const data = vocab.queryClient.getQueryData<EntryListing>(vocabKeys.entries);
	if (data === undefined) throw new Error('The word listing is not loaded');
	return data;
}

/** The word the cache holds with `text`. */
export function cached(vocab: Vocab, text: string): Entry {
	const entry = readRows('entries', listing(vocab), readEntry).rows.find(
		(candidate) => candidate.text === text,
	);
	if (entry === undefined) throw new Error(`${text} is not in the cache`);
	return entry;
}
