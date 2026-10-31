/**
 * `@epicenter/svelte/repo`: the person's repository in Svelte context
 * (decision 10). An app's online variant has a signed-in layout that opens
 * the repository for its account, wraps it once for Svelte where it makes
 * it (`fromClient`, decision 87), and sets it; every component under it
 * reads it as it is. The local variant never sets one, and the two never
 * meet on a page.
 *
 * @example
 * ```svelte
 * <!-- The online variant's signed-in layout -->
 * <script lang="ts">
 * 	setRepo(fromClient(openRemote(todos, { account })));
 * </script>
 *
 * <!-- A page under it -->
 * <script lang="ts">
 * 	const todos = getRepo<Todos>().todos; // todos.items, todos.update(…)
 * </script>
 * ```
 */
import type { Contract } from '@epicenter/definition/contract';
import { getContext, hasContext, setContext } from 'svelte';
import type { ReactiveClient } from './client.js';

const REPO = Symbol('epicenter.repo');

/** Give the components under this one `repo`; answers it. Call during component setup. */
export function setRepo<TContract extends Contract>(
	repo: ReactiveClient<TContract>,
): ReactiveClient<TContract> {
	setContext(REPO, repo);
	return repo;
}

/**
 * The repository the signed-in layout above set, as the Svelte state of the
 * contract `TContract` names. Call during component setup. Outside that
 * boundary there is none, and calling it there is a bug: it throws.
 */
export function getRepo<
	TContract extends Contract,
>(): ReactiveClient<TContract> {
	if (!hasContext(REPO))
		throw new Error(
			'getRepo() was called outside the signed-in layout: only a component rendered under the one that calls setRepo(repo) has a repository',
		);
	return getContext<ReactiveClient<TContract>>(REPO);
}
