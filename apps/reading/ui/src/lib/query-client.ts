/**
 * The QueryClient for this UI, made once in the layout. Every write refreshes
 * every read the UI shows, and the write is done only once they are. Reads
 * also refresh when the UI is shown again (its tab or app comes back), so what
 * an agent or another device changed appears when you look. Nothing refreshes
 * on a timer. A read that fails is not retried; the next refresh asks again.
 *
 * It is made from this UI's own `@tanstack/svelte-query`, so the client, its
 * caches and the components that read them are one copy of TanStack Query.
 */
import { MutationCache, QueryClient } from '@tanstack/svelte-query';

export function createQueryClient(): QueryClient {
	const client: QueryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: () => client.invalidateQueries(),
		}),
	});
	return client;
}
