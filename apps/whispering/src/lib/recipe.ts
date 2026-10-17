/**
 * What running a recipe would send, or why it cannot run.
 *
 * A recipe is a row in `transformations/`: a title and instructions, with an
 * optional model to use instead of the text connection's. Where the request
 * goes is always the text connection.
 *
 * This is the one place that decides. The Run button, the post-processing
 * choice, a transcript's Transform menu, the recipe's own page, and the run
 * itself all ask it, so none of them can disagree about whether a recipe
 * runs or with what. The run asks it again of the saved file, after the
 * edits being written have landed, and that answer is what is sent.
 */

import type { Row } from '@epicenter/folder';
import type { ConnectionInfo } from './connections.js';
import type { TransformationFields } from './definition.js';

/** A recipe as a row: a listed one, or its text as typed. Undefined when its text is not a valid row. */
export type RecipeRow = Pick<Row<TransformationFields>, 'fields' | 'body'>;

export type ResolvedRecipe =
	| {
			readonly kind: 'ready';
			readonly title: string;
			readonly prompt: string;
			readonly model: string;
			/** The text connection's base URL: where the request goes. */
			readonly endpoint: string;
	  }
	| {
			readonly kind: 'blocked';
			/** What a person would fix: the recipe's file, or the text connection in Settings. */
			readonly fix: 'recipe' | 'connection';
			readonly reason: string;
	  };

/** A field the recipe leaves to the connection: `null`, absent, or blank. */
function given(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** The model a recipe names for itself, or undefined when it uses the connection's. */
export function recipeModel(
	fields: Readonly<TransformationFields>,
): string | undefined {
	return given(fields.model);
}

/**
 * Decide, in the order a person would fix things: the file, its
 * instructions, the connection, the model.
 * `connectionsProblem` is why the connections could not be read; then none
 * is assumed.
 */
export function resolveRecipe(
	recipe: RecipeRow | undefined,
	text: ConnectionInfo | undefined,
	connectionsProblem?: string,
): ResolvedRecipe {
	if (recipe === undefined)
		return {
			kind: 'blocked',
			fix: 'recipe',
			reason: 'Repair this transformation before running it.',
		};
	if (recipe.body.trim() === '')
		return {
			kind: 'blocked',
			fix: 'recipe',
			reason: 'Write instructions to run this.',
		};
	if (connectionsProblem !== undefined)
		return {
			kind: 'blocked',
			fix: 'connection',
			reason: `The text connection could not be read: ${connectionsProblem}`,
		};
	if (text === undefined)
		return {
			kind: 'blocked',
			fix: 'connection',
			reason: 'Set up the text connection in Settings to run this.',
		};
	const model = recipeModel(recipe.fields) ?? given(text.model);
	if (model === undefined)
		return {
			kind: 'blocked',
			fix: 'recipe',
			reason: 'Name a model in this transformation or in the text connection.',
		};
	return {
		kind: 'ready',
		title: recipe.fields.title,
		prompt: recipe.body,
		model,
		endpoint: text.baseUrl,
	};
}
