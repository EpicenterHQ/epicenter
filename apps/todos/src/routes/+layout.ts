import { todosState } from '$lib/todos/client';
import type { LayoutLoad } from './$types';

export const ssr = false;

/**
 * Gate the first paint on local storage hydration. `todosState` reads an empty
 * table until `storage.whenLoaded` resolves, so without this the "All clear"
 * empty state flashes before the todos load from disk. SvelteKit blocks the
 * route's render until this load resolves; `whenReady` is a single promise, so
 * it resolves once and a reload never re-blocks.
 */
export const load: LayoutLoad = async () => {
	await todosState.whenReady;
};
