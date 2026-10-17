/**
 * Test helper: TanStack Query for tests that drive the library without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This imports `@tanstack/query-core`, which `svelte-query`
 * re-exports. The catalog pins it to the exact version `svelte-query`
 * depends on, so the install holds one copy and a mounted test that mixes
 * the two shares every class and manager. Change the two pins together.
 */
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import type { Library } from './library.svelte.js';

export { QueryClient, QueryObserver };

/** A fresh cache, mounted as the layout's provider mounts it. */
export function createQueryClient() {
	const client = new QueryClient();
	client.mount();
	return client;
}

/**
 * Wait until no write runs or waits, and nothing is mutating or fetching.
 * Typing that waits for its pause is not waited for.
 */
export async function quiet({
	queryClient,
	edits,
}: Pick<Library, 'queryClient' | 'edits'>) {
	const idle = () =>
		edits.writes.pending() === 0 &&
		queryClient.isMutating() === 0 &&
		queryClient.isFetching() === 0;
	for (let tries = 0; tries < 1000; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}
