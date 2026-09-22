import type { Recipe, WhisperingData } from '../data.js';
import { BUILTIN_RECIPES } from '../state/builtin-recipes.js';

/** Built-ins stay first; the person's own recipes follow in name order. */
export function pickableRecipes(
	personal: Pick<WhisperingData, 'tables'> | undefined,
): Recipe[] {
	return [
		...BUILTIN_RECIPES,
		...(personal?.tables.recipes.rows ?? []).toSorted((left, right) =>
			left.name.localeCompare(right.name),
		),
	];
}

/** Saving a built-in recipe creates a personal copy. */
export function saveRecipe(
	personal: Pick<WhisperingData, 'tables'>,
	{ id, ...fields }: Recipe,
) {
	if (!id.startsWith('builtin:') && personal.tables.recipes.get(id)) {
		const result = personal.tables.recipes.update(id, fields);
		if (result.error !== null) throw result.error;
	} else {
		personal.tables.recipes.create(fields);
	}
}
