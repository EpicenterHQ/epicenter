/**
 * Test helper: TanStack Query for tests that drive the notes state without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This imports `@tanstack/query-core`, which `svelte-query`
 * re-exports. The catalog pins it to the exact version `svelte-query`
 * depends on, so the install holds one copy and a mounted test that mixes
 * the two shares every class and manager. Change the two pins together.
 *
 * The helpers stand in for what the views do: a screen that shows a query
 * observes it, so a change that makes it stale reads it again as it does in
 * the app.
 */
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import type { NoteListing, Notes } from './notes.svelte.js';

export { QueryClient, QueryObserver };

/** A fresh cache, configured and mounted as the layout's provider makes it. */
export function createQueryClient() {
	const client = new QueryClient({
		defaultOptions: { queries: { refetchOnWindowFocus: false } },
	});
	client.mount();
	return client;
}

/**
 * Observe the queries the open screens show: the note and folder lists, the
 * file browser, Git status, and the text of each path given. Returns the
 * function that stops observing.
 */
export function observe(notes: Notes, ...paths: string[]) {
	const { folder$, queryClient } = notes;
	const observers = [
		new QueryObserver(queryClient, folder$.notes.list.queryOptions()),
		new QueryObserver(queryClient, folder$.folders.list.queryOptions()),
		new QueryObserver(queryClient, folder$.files.list.queryOptions()),
		new QueryObserver(queryClient, folder$.history.status.queryOptions()),
		...paths.map(
			(path) => new QueryObserver(queryClient, notes.textQuery(path)),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is saving, mutating, or fetching. */
export async function quiet(notes: Notes) {
	const client = notes.queryClient;
	const idle = () =>
		!notes.saving && client.isMutating() === 0 && client.isFetching() === 0;
	for (let tries = 0; tries < 1000; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The note listing the cache holds now. */
export function listing(notes: Notes): NoteListing {
	const data = notes.queryClient.getQueryData<NoteListing>(
		notes.folder$.notes.list.queryKey(),
	);
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
