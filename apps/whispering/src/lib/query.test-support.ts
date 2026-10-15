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

export { QueryClient, QueryObserver };

/** A fresh cache, mounted as the layout's provider mounts it. */
export function createQueryClient() {
	const client = new QueryClient();
	client.mount();
	return client;
}

/** Wait until nothing is mutating or fetching. */
export async function quiet(queryClient: QueryClient) {
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
