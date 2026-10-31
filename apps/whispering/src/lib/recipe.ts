/**
 * What running a recipe would send, or why it cannot run.
 *
 * A recipe is a note in `transformations/`: a title and instructions, with an
 * optional model to use instead of the text connection's. Where the request
 * goes is always the text connection.
 *
 * This is the one place that decides. The Run button, the post-processing
 * choice, a transcript's Transform menu, the recipe's own page, and the run
 * itself all ask it, so none of them can disagree about whether a recipe
 * runs or with what. The run captures and validates the current held source,
 * reading it only when it has not yet been acquired.
 */

import type { ConnectionInfo } from './connections.js';

/** A recipe as a note: listed, or as typed. Undefined when its file does not read as one. */
export type RecipeRow = {
	readonly title: string;
	/** A chat model to use instead of the text connection's; `null` or blank uses the connection's. */
	readonly model: string | null;
	/** The instructions. */
	readonly body: string;
};

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
	recipe: Pick<RecipeRow, 'model'>,
): string | undefined {
	return given(recipe.model);
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
	const model = recipeModel(recipe) ?? given(text.model);
	if (model === undefined)
		return {
			kind: 'blocked',
			fix: 'recipe',
			reason: 'Name a model in this transformation or in the text connection.',
		};
	return {
		kind: 'ready',
		title: recipe.title,
		prompt: recipe.body,
		model,
		endpoint: text.baseUrl,
	};
}

/**
 * Prompts offered as explicit "create" buttons. Nothing is written until one
 * is pressed, and the file it creates is an ordinary
 * transformation the person can edit or delete.
 */
export const STARTER_TRANSFORMATIONS: readonly {
	readonly title: string;
	readonly prompt: string;
}[] = [
	{
		title: 'Clean up',
		prompt:
			'You clean up dictated text. Fix punctuation, capitalization, and obvious transcription mistakes. Remove filler words and false starts. Keep the speaker’s wording and meaning. Answer with the cleaned text only.\n',
	},
	{
		title: 'Summarize',
		prompt:
			'You summarize transcripts. Write a short summary of the main points as a bulleted list, then list any action items. Use only what the transcript says. Answer with the summary only.\n',
	},
	{
		title: 'Draft an email',
		prompt:
			'You turn dictated notes into an email. Write a clear, polite email with a subject line, a greeting, short paragraphs, and a sign-off. Do not invent facts that are not in the notes. Answer with the email only.\n',
	},
];
