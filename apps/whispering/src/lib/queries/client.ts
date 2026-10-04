import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';
import { browser } from '$app/environment';

/** Create the TanStack query owner for one mounted Whispering UI session. */
export function createWhisperingQueryRuntime() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				enabled: browser,
			},
		},
	});

	return {
		queryClient,
		...createQueryFactories(queryClient),
	};
}

export type WhisperingQueryRuntime = ReturnType<
	typeof createWhisperingQueryRuntime
>;
