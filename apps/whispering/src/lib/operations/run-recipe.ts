import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result } from 'wellcrafted/result';
import type { Recipe } from '$lib/data';
import { buildSystemPrompt } from '$lib/operations/build-system-prompt';
import { completeWithGlobalDefault } from '$lib/operations/completion';
import { settings } from './settings.js';

export const RunRecipeError = defineErrors({
	InvalidInput: ({ message }: { message: string }) => ({ message }),
	Empty: ({ message }: { message: string }) => ({ message }),
	Failed: ({ message }: { message: string }) => ({ message }),
});
export type RunRecipeError = InferErrors<typeof RunRecipeError>;

/**
 * Run one Recipe over `input` and return its take: a single AI call whose
 * directive is `recipe.instructions` and whose content is `input`. Text in,
 * text out, nothing else: no pre/post replacements, no `{{input}}` template, no
 * per-Recipe model. Polish has already run upstream, so `input` is the polished
 * text and this never re-does correction.
 *
 * The system prompt is `recipe.instructions` plus the Dictionary block (via
 * `buildSystemPrompt`, with `dictionary` read at use per ADR 0012). Provider and
 * model come from the single global `completion.*` default (via
 * `completeWithGlobalDefault`), not from the Recipe.
 *
 * Pure execution: no workspace writes, no persistence, no toasts. The picker is
 * the caller; it owns delivery and any history bookkeeping.
 */
export async function runRecipe({
	input,
	recipe,
}: {
	input: string;
	recipe: Recipe;
}): Promise<Result<string, RunRecipeError>> {
	if (!input.trim()) {
		return RunRecipeError.InvalidInput({
			message: 'Empty input. Please enter some text to run a recipe on.',
		});
	}
	if (!recipe.instructions.trim()) {
		return RunRecipeError.Empty({
			message: 'This recipe has no instructions. Add an instruction to run it.',
		});
	}

	const result = await completeWithGlobalDefault({
		systemPrompt: buildSystemPrompt(
			recipe.instructions,
			settings.get('dictionary'),
		),
		userPrompt: input,
	});

	if (isErr(result)) {
		return RunRecipeError.Failed({
			message: extractErrorMessage(result.error),
		});
	}
	return Ok(result.data);
}
