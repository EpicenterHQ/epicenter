import { CompleteError } from '@epicenter/client';
import { APIError } from 'openai';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { WhisperingApp } from '../whispering/app.js';
import { getInferenceTarget } from '../whispering/inference.js';

/** Resolve exactly the saved connection and model from the ready document App. */
export function resolveCompletionTarget(app: WhisperingApp) {
	const target = app.catalog.resolve(getInferenceTarget(app.local.kv, 'completion'));
    return target?.source === 'runtime' ? null : target;
}

/** Capture the model and transport together before starting the single HTTP request. */
export async function completeWithGlobalDefault(
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
	const result = await tryAsync({
		try: async () => {
			app.signal.throwIfAborted();
			const target = resolveCompletionTarget(app);
			if (!target)
				throw new Error(
					'Choose a text connection and model in Privacy & Processing settings.',
				);
			return await target.client.chat.completions.create(
				{
					model: target.model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					stream: false,
				},
				{ signal: signal ? AbortSignal.any([app.signal, signal]) : app.signal },
			);
		},
		catch: (cause) =>
			cause instanceof APIError && cause.status !== undefined
				? CompleteError.RequestFailed({
						status: cause.status,
						detail: cause.message,
					})
				: CompleteError.TransportFailed({ cause }),
	});
	if (result.error) return Err(result.error);
	const text = result.data.choices?.[0]?.message?.content;
	return typeof text === 'string' ? Ok(text) : CompleteError.Malformed();
}
