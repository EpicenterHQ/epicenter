import { nanoid } from 'nanoid/non-secure';
import { createSubscriber } from 'svelte/reactivity';
import type { Recipe } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';

export type Recipes = ReturnType<typeof createRecipes>;

/** Bridges committed recipes-table invalidations into Svelte tracking. */
export function createRecipes({ recipes }: Pick<WhisperingApp, 'recipes'>) {
	const invalidate = createSubscriber((update) => recipes.subscribe(update));
	return {
		get pickable() {
			invalidate();
			return recipes.pickable;
		},
		get count() {
			invalidate();
			return recipes.count;
		},
		get nonconforming() {
			invalidate();
			return recipes.nonconforming;
		},
		get loadError() {
			invalidate();
			return recipes.loadError;
		},
		set: recipes.set,
		delete: recipes.delete,
		refresh: recipes.refresh,
		subscribe: recipes.subscribe,
	};
}

export function generateDefaultRecipe(): Recipe {
	return { id: nanoid(), name: '', instructions: '', icon: null };
}
