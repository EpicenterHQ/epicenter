/**
 * What running a recipe would send, or why it cannot run.
 *
 * A recipe is a note in `transformations/`: a title and instructions, with an
 * optional model to use instead of the text model's. Where the request goes
 * is always the endpoint of the text model chosen in Settings.
 *
 * This is the one place that decides. The Run button, the post-processing
 * choice, a transcript's Transform menu, the recipe's own page, and the run
 * itself all ask it, so none of them can disagree about whether a recipe
 * runs or with what. The run captures and validates the current held source,
 * reading it only when it has not yet been acquired.
 */

import type { Target } from './inference.js';

/** A recipe as a note: listed, or as typed. Undefined when its file does not read as one. */
export type RecipeRow = {
	readonly title: string;
	/** A chat model at the text model's endpoint to use instead; `null` or blank uses the text model. */
	readonly model: string | null;
	/** The instructions. */
	readonly body: string;
};

/** The model chosen for an operation now, as a target, or why there is none. */
export type Chosen =
	| { readonly kind: 'ready'; readonly target: Target }
	| { readonly kind: 'unset'; readonly reason: string };

export type ResolvedRecipe =
	| {
			readonly kind: 'ready';
			readonly title: string;
			readonly prompt: string;
			/** Where the request goes: the text model's endpoint, with this recipe's model when it names one. */
			readonly target: Target;
	  }
	| {
			readonly kind: 'blocked';
			/** What a person would fix: the recipe's file, or the text model in Settings. */
			readonly fix: 'recipe' | 'model';
			readonly reason: string;
	  };

/** A field the recipe leaves to the text model: `null`, absent, or blank. */
function given(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** The model a recipe names for itself, or undefined when it uses the text model. */
export function recipeModel(
	recipe: Pick<RecipeRow, 'model'>,
): string | undefined {
	return given(recipe.model);
}

/**
 * Decide, in the order a person would fix things: the file, its
 * instructions, then the text model chosen now (`text`).
 */
export function resolveRecipe(
	recipe: RecipeRow | undefined,
	text: Chosen,
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
	if (text.kind !== 'ready')
		return { kind: 'blocked', fix: 'model', reason: text.reason };
	return {
		kind: 'ready',
		title: recipe.title,
		prompt: recipe.body,
		target: {
			...text.target,
			model: recipeModel(recipe) ?? text.target.model,
		},
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
