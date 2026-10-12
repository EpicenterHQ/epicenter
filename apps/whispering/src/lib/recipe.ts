/**
 * What running a recipe would send, or why it cannot run.
 *
 * A recipe is a row in `transformations/`: a title and instructions, with an
 * optional model to use instead of the text connection's. Where the request
 * goes is always the text connection. A recipe written by an earlier build
 * may name an endpoint; that is a constraint the connection must meet
 * exactly, never a destination.
 *
 * This is the one place that decides. The Run button, the post-processing
 * choice, a transcript's Transform menu, the recipe's own page, and the run
 * itself all ask it, so none of them can disagree about whether a recipe
 * runs or with what. The run asks it again of the saved file, after the
 * edits being written have landed, and that answer is what is sent.
 */

import type { Row } from '@epicenter/folder';
import {
	type ConnectionInfo,
	canonicalBaseUrl,
	sameBaseUrl,
} from './connections.js';
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

/** The endpoint an earlier build wrote into a recipe, or undefined when it names none. */
export function recipeEndpoint(
	fields: Readonly<TransformationFields>,
): string | undefined {
	return given(fields.endpoint);
}

/**
 * Decide, in the order a person would fix things: the file, its
 * instructions, the connection, the old endpoint constraint, the model.
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
	const endpoint = recipeEndpoint(recipe.fields);
	if (endpoint !== undefined) {
		const { error: endpointError } = canonicalBaseUrl(endpoint);
		if (endpointError !== null)
			return {
				kind: 'blocked',
				fix: 'recipe',
				reason: `This transformation names the endpoint ${endpoint}, which is not a base URL. Remove the endpoint from it to use the text connection.`,
			};
		if (!sameBaseUrl(endpoint, text.baseUrl))
			return {
				kind: 'blocked',
				fix: 'recipe',
				reason: `This transformation runs only at ${endpoint}, and the text connection is ${text.baseUrl}. Remove the endpoint from it to use the text connection, or change the connection.`,
			};
	}
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
