import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isErr, Ok, type Result } from 'wellcrafted/result';
import { authClient } from '#platform/auth';
import { buildPolishSystemPrompt } from '$lib/operations/build-system-prompt';
import {
	completeWithGlobalDefault,
	resolveCompletionState,
} from '$lib/operations/completion';
import { describePolishDestination } from '$lib/operations/completion-target';
import { resolveTranscriptionLocalityFromConfig } from '$lib/operations/transcription-target';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

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
 * The Polish control's effective state, derived from two independent facts:
 * intent (`polishEnabled`, the toggle) and capability (the selected provider can
 * serve a completion). Speed mode is `off`; `on` means a pass will run; and
 * `needs-key` is the "wanted but blocked" state, intent without capability,
 * which a bare boolean used to hide by collapsing it into the same `false` as
 * `off`. The UI reads this so the Settings toggle and the home chip can show
 * *why* Polish is or is not running, instead of a toggle that reads "on" while
 * the pipeline silently ships raw. Configuring a provider is capability, not
 * consent, so the two facts stay separate concepts even though both must hold to
 * run. Read at use per ADR 0012; nothing is cached.
 */
export type PolishStatus = 'off' | 'on' | 'needs-key';

export function polishStatus(app: WhisperingApp): PolishStatus {
	if (!app.settings.get('polishEnabled')) return 'off';
	return resolveCompletionState(app).canRun ? 'on' : 'needs-key';
}

/**
 * The privacy boundary the UI shows for the current Polish configuration: where
 * audio is transcribed and where Polish sends transcript text. Assembled once
 * here, beside {@link polishStatus}, so the Polish controls only render the
 * derived sentence instead of each reconstructing it from settings and the
 * resolved completion target. Read at use per ADR 0012.
 */
export function polishDestination(app: WhisperingApp): string {
 const auth = authClient.auth;
 if (!auth) throw new Error('Application requires a valid auth startup.');
	return describePolishDestination(
		resolveTranscriptionLocalityFromConfig({
			service: app.settings.get('transcriptionService'),
			getDeviceConfig: deviceConfig.get,
			sessionBaseUrl: auth.baseURL,
		}),
		app.settings.get('completionProvider'),
		resolveCompletionState(app),
	);
}

/**
 * Whether a Polish AI pass will actually run for `input`: the control is `on`
 * (enabled AND the provider is usable) AND the input is non-empty. The single
 * source for this decision so the pipeline shows the "Polishing..." HUD only when
 * an AI call is really about to happen (no flicker in speed mode or an
 * unconfigured install); `runPolish` reads it too.
 */
export function polishWillRun(app: WhisperingApp, input: string): boolean {
	return polishStatus(app) === 'on' && input.trim().length > 0;
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
	if (!polishWillRun(app, input)) return Ok(input);

	const result = await completeWithGlobalDefault(app, {
		systemPrompt: buildPolishSystemPrompt(
			app.settings.get('polishInstructions'),
			app.settings.get('dictionary'),
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
