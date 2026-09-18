import { nanoid } from 'nanoid/non-secure';
import type { Recipe } from '$lib/data';

/**
 * `createRecipes` is gone, and nothing replaced it.
 *
 * It wrapped every getter on the recipes domain in a `createSubscriber`
 * invalidation so Svelte would track a domain that published changes through a
 * hand-rolled listener set. The domain holds `$state.raw` now
 * (`whispering/recipes.svelte.ts`), so tracking is native and a bridge that
 * only forwarded getters had nothing left to forward.
 *
 * Its two siblings, `recordings.svelte.ts` and `settings.svelte.ts`, are the
 * same shape and go the same way once their domains are ported.
 */
export function generateDefaultRecipe(): Recipe {
	return { id: nanoid(), name: '', instructions: '', icon: null };
}
