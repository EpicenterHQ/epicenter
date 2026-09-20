import type { Recipe, WhisperingData } from '../data.js';
import { BUILTIN_RECIPES } from '../state/builtin-recipes.js';

/** Built-ins stay first; the person's own recipes follow in name order. */
export function pickableRecipes(
	library: Pick<WhisperingData, 'tables'>,
): Recipe[] {
	return [
		...BUILTIN_RECIPES,
		...library.tables.recipes.rows.toSorted((left, right) =>
			left.name.localeCompare(right.name),
		),
	];
}

/** Saving a built-in recipe creates a personal copy. */
export function saveRecipe(
	library: Pick<WhisperingData, 'tables'>,
	{ id, ...fields }: Recipe,
) {
	if (!id.startsWith('builtin:') && library.tables.recipes.get(id)) {
		const result = library.tables.recipes.update(id, fields);
		if (result.error !== null) throw result.error;
	} else {
		library.tables.recipes.create(fields);
	}
}
