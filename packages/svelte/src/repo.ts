/**
 * `@epicenter/svelte/repo`: the person's repository in Svelte context
 * (decision 10). An app's online variant has a signed-in layout that opens
 * the repository for its account and sets it; every component under it
 * reads it. The local variant never sets one: its device is the app's
 * module singleton (`$lib/device.ts`), and the two never meet on a page.
 *
 * @example
 * ```svelte
 * <!-- The online variant's signed-in layout -->
 * <script lang="ts">
 * 	setRepo(openRemote(todos, { account }));
 * </script>
 *
 * <!-- A page under it -->
 * <script lang="ts">
 * 	const todos = fromClient(getRepo<Todos>()).todos;
 * </script>
 * ```
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { getContext, hasContext, setContext } from 'svelte';

const REPO = Symbol('epicenter.repo');

/** Give the components under this one `repo`; answers it. Call during component setup. */
export function setRepo<TContract extends Contract>(
	repo: Client<TContract>,
): Client<TContract> {
	setContext(REPO, repo);
	return repo;
}

/**
 * The repository the signed-in layout above set, as the client of the
 * contract `TContract` names. Call during component setup. Outside that
 * boundary there is none, and calling it there is a bug: it throws.
 */
export function getRepo<TContract extends Contract>(): Client<TContract> {
	if (!hasContext(REPO))
		throw new Error(
			'getRepo() was called outside the signed-in layout: only a component rendered under the one that calls setRepo(repo) has a repository',
		);
	return getContext<Client<TContract>>(REPO);
}
