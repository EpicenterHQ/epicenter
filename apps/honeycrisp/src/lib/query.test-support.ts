/**
 * Test helper: TanStack Query for tests that drive the notes state without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This loads the same `@tanstack/query-core` build that
 * `@tanstack/svelte-query` re-exports, so a mounted test that mixes the two
 * shares one copy of every class and manager.
 *
 * The helpers stand in for what the views do: a screen that shows a query
 * observes it, so invalidation reads it again as it does in the app.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as Query from '@tanstack/svelte-query';
import type { NoteListing, Notes } from './notes.svelte.js';

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
 * Observe the queries the open screens show: the note and folder lists, the
 * file browser, Git status, and the text of each path given. Returns the
 * function that stops observing.
 */
export function observe(notes: Notes, ...paths: string[]) {
	const observers = [
		new QueryObserver(notes.queryClient, notes.notesQuery()),
		new QueryObserver(notes.queryClient, notes.foldersQuery()),
		new QueryObserver(notes.queryClient, notes.filesQuery()),
		new QueryObserver(notes.queryClient, notes.statusQuery()),
		...paths.map(
			(path) => new QueryObserver(notes.queryClient, notes.textQuery(path)),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is mutating or fetching. */
export async function quiet(notes: Notes) {
	const client = notes.queryClient;
	for (let tries = 0; tries < 1000; tries++) {
		if (client.isMutating() === 0 && client.isFetching() === 0) {
			await Bun.sleep(0);
			if (client.isMutating() === 0 && client.isFetching() === 0) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The note listing the cache holds now. */
export function listing(notes: Notes): NoteListing {
	const data = notes.queryClient.getQueryData<NoteListing>([
		'honeycrisp',
		'rows',
		'notes',
	]);
	if (data === undefined) throw new Error('The note listing is not loaded');
	return data;
}

/** The note the cache holds for `stem`, which must read as one. */
export function cached(notes: Notes, stem: string) {
	const result = listing(notes).find((entry) => entry.stem === stem)?.result;
	if (result === undefined || result.error !== null)
		throw new Error(`No valid note for ${stem} in the cache`);
	return result.data;
}
