import { CompleteError, complete, resolveConnection } from '@epicenter/client';
import type { Result } from 'wellcrafted/result';
import { customFetch } from '#platform/http';
import {
	type CompletionState,
	resolveCompletionStateFromConfig,
} from '$lib/operations/completion-target';
import { deviceConfig } from '$lib/state/device-config.svelte';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';

/**
 * Resolve the single global completion state: what to call (`target`), whether
 * Polish can run (`canRun`), and whether transcript text stays on this device
 * (`textStaysOnDevice`). All three are derived together from the global
 * `completion.*` setting and deviceConfig, read at use (ADR 0012) so nothing goes
 * stale. `target` is null when there is no base URL to talk to (Custom with no
 * endpoint configured), the one genuinely un-runnable state.
 */
export function resolveCompletionState(app: WhisperingApp): CompletionState {
	return resolveCompletionStateFromConfig({
		provider: app.settings.get('completion.provider'),
		getDeviceConfig: deviceConfig.get,
	});
}

/**
 * Run one completion against the single global AI default. Both the Polish pass
 * and every Recipe share this one call path, so provider/model/key resolution
 * lives here once. Every provider speaks the OpenAI completion wire (Anthropic
 * and Google through their OpenAI-compatibility endpoints, ADR-0060), so there is
 * no per-provider client and no wire-vs-bespoke branch: resolve a connection from
 * the `INFERENCE` table and hand it to the shared `complete()`. Provider and model
 * come from `completion.*` in settings, the key and endpoint from deviceConfig,
 * all read at use (ADR 0012) so nothing goes stale; pasted strings are trimmed.
 *
 * `signal` aborts the in-flight request (the Polish HUD's "ship raw" control).
 */
export function completeWithGlobalDefault(
	app: WhisperingApp,
	{
		systemPrompt,
		userPrompt,
		signal,
	}: {
		systemPrompt: string;
		userPrompt: string;
		signal?: AbortSignal;
	},
): Promise<Result<string, CompleteError>> {
	const { target } = resolveCompletionState(app);
	if (!target) {
		const provider = app.settings.get('completion.provider');
		return Promise.resolve(
			CompleteError.TransportFailed({
				cause: new Error(
					`No base URL set for the ${provider} completion provider. Add an endpoint in settings.`,
				),
			}),
		);
	}
	return complete(
		resolveConnection(
			{ baseUrl: target.baseUrl, apiKey: target.apiKey },
			customFetch,
		),
		{
			model: app.settings.get('completion.model').trim(),
			systemPrompt,
			userPrompt,
			signal,
		},
	);
}
