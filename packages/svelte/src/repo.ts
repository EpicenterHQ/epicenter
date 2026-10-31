/**
 * `@epicenter/svelte/repo`: the person's repository in Svelte context
 * (decision 10). The signed-in boundary (a signed-in route layout, or the
 * one component that renders only when signed in) opens the repository for
 * its account and sets it; every component under it reads it. The device
 * is no context: it is the app's module singleton (`$lib/device.ts`).
 *
 * @example
 * ```svelte
 * <!-- The signed-in boundary -->
 * <script lang="ts">
 * 	const repo = setRepo(openRemote(todos, { account }));
 * 	const uploader = startUploading(device, repo);
 * 	onDestroy(() => uploader[Symbol.dispose]());
 * </script>
 *
 * <!-- A page under it -->
 * <script lang="ts">
 * 	const list = oneList(fromClient(device).todos, fromClient(getRepo<Todos>()).todos);
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
 * The repository the signed-in boundary above set, as the client of the
 * contract `TContract` names. Call during component setup. Outside that
 * boundary there is none, and calling it there is a bug: it throws.
 */
export function getRepo<TContract extends Contract>(): Client<TContract> {
	if (!hasContext(REPO))
		throw new Error(
			'getRepo() was called outside the signed-in boundary: only a component rendered under the one that calls setRepo(repo) has a repository',
		);
	return getContext<Client<TContract>>(REPO);
}
