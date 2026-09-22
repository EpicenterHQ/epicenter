import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingApp } from '../whispering/app.js';
import { local } from '../whispering/local.js';
import { buildPolishSystemPrompt } from './build-system-prompt.js';
import {
	completeWithGlobalDefault,
	resolveCompletionTarget,
} from './completion.js';
import { DEVICE_DEFAULTS, PERSONAL_DEFAULTS } from './settings.js';

export const RunPolishError = defineErrors({
	/**
	 * The Polish AI pass failed. Non-fatal: `fallback` carries the raw input so
	 * the pipeline can still deliver a usable transcript instead of losing the
	 * user's words to a polish error.
	 */
	PolishFailed: ({
		message,
		fallback,
	}: {
		message: string;
		fallback: string;
	}) => ({ message, fallback }),
});
export type RunPolishError = InferErrors<typeof RunPolishError>;

/**
 * Whether a Polish AI pass will actually run for `input`: the control is `on`
 * (enabled AND the provider is usable) AND the input is non-empty. The single
 * source for this decision so the pipeline shows the "Polishing..." HUD only when
 * an AI call is really about to happen (no flicker in speed mode or an
 * unconfigured install); `runPolish` reads it too.
 */
export function polishWillRun(app: WhisperingApp, input: string): boolean {
	return (
		(local.kv.get('polishEnabled') ?? DEVICE_DEFAULTS.polishEnabled) &&
		resolveCompletionTarget(app) !== null &&
		input.trim().length > 0
	);
}

/**
 * Polish: the always-on, meaning-preserving AI base, run once after every
 * transcription. One optional completion whose system prompt is
 * `polishInstructions` plus a Dictionary block (via `buildPolishSystemPrompt`)
 * and whose content is the raw transcript. Skips the call (returns the raw
 * input) whenever {@link polishWillRun} is false.
 *
 * `signal` lets the caller cancel the in-flight pass (the HUD's "ship raw"):
 * when it aborts, the raw input is returned as a clean success, not an error,
 * because shipping the raw transcript was the user's explicit intent.
 *
 * Pure execution: no workspace writes, no toasts. The pipeline owns delivery and
 * keeps the raw transcript on `recordings.transcript` underneath the polished
 * text. On a genuine AI failure the raw input rides along in the error so
 * delivery can still proceed.
 */
export async function runPolish(
	app: WhisperingApp,
	{
		input,
		signal,
	}: {
		input: string;
		signal?: AbortSignal;
	},
): Promise<Result<string, RunPolishError>> {
	app.signal.throwIfAborted();
	if (!polishWillRun(app, input)) return Ok(input);

	const ready = await tryAsync({
		try: () => app.personalReady,
		catch: (cause) =>
			RunPolishError.PolishFailed({
				message: extractErrorMessage(cause),
				fallback: input,
			}),
	});
	if (ready.error) return ready;
	app.signal.throwIfAborted();
	const personal = ready.data;
	const result = await completeWithGlobalDefault(app, {
		systemPrompt: buildPolishSystemPrompt(
			personal?.kv.get('polishInstructions') ??
				PERSONAL_DEFAULTS.polishInstructions,
			personal?.kv.get('dictionary') ?? PERSONAL_DEFAULTS.dictionary,
		),
		userPrompt: input,
		signal,
	});
	if (isErr(result)) {
		// A user-requested abort is not a failure: ship the raw transcript cleanly.
		if (signal?.aborted) return Ok(input);
		return RunPolishError.PolishFailed({
			message: extractErrorMessage(result.error),
			fallback: input,
		});
	}
	return Ok(result.data);
}
