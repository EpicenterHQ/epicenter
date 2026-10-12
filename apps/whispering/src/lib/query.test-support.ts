/**
 * Test helper: TanStack Query for tests that drive the library without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose entry
 * also loads `.svelte` components; Bun's server-runtime tests cannot load
 * those. This loads the same `@tanstack/query-core` build that
 * `@tanstack/svelte-query` re-exports, so a mounted test that mixes the two
 * shares one copy of every class and manager.
 */
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as Query from '@tanstack/svelte-query';

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

/** Wait until nothing is mutating or fetching. */
export async function quiet(queryClient: Query.QueryClient) {
	for (let tries = 0; tries < 1000; tries++) {
		if (queryClient.isMutating() === 0 && queryClient.isFetching() === 0) {
			await Bun.sleep(0);
			if (queryClient.isMutating() === 0 && queryClient.isFetching() === 0)
				return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}
