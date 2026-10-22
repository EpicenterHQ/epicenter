/**
 * Test helper: TanStack Query for tests that drive Whispering without
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
import type { WhisperingContext } from './folder.js';

export { QueryClient, QueryObserver };

/**
 * Wait until no Folder publication or query fetch runs. Workflow preparation,
 * endpoint requests and typing that waits for its pause are not waited for.
 */
export async function quiet({ queryClient, folder }: WhisperingContext) {
	const idle = () =>
		!folder.getStatus().saving && queryClient.isFetching() === 0;
	for (let tries = 0; tries < 1000; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}
