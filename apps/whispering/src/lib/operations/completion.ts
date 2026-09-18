import { matchInferenceTarget } from '@epicenter/app-shell/inference-selections';
import { CompleteError } from '@epicenter/client';
import { APIError } from 'openai';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { getApp, getSelections } from '../application.js';
import { settings } from './settings.js';

/** Resolve exactly the saved connection and model from the ready document App. */
export function resolveCompletionState() {
	const app = getApp();
	const model = settings.get('completionModel');
	const selected = getSelections().get('completion');
	const transport =
		selected?.model === model
			? matchInferenceTarget(
					{
						runtime: app.device.connections.runtime,
						connections: app.device.connections.custom,
						account: app.account?.connection ?? null,
					},
					selected,
				)
			: null;
	return {
		model,
		transport,
		canRun: transport !== null && model.trim().length > 0,
	};
}

/** Capture the model and transport together before starting the single HTTP request. */
export async function completeWithGlobalDefault({
	systemPrompt,
	userPrompt,
	signal,
}: {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}): Promise<Result<string, CompleteError>> {
	const { transport, model, canRun } = resolveCompletionState();
	if (!transport || !canRun) {
		return Promise.resolve(
			CompleteError.TransportFailed({
				cause: new Error(
					'Choose a text connection and model in Privacy & Processing settings.',
				),
			}),
		);
	}
	const result = await tryAsync({
		try: async () =>
			await transport.chat.completions.create(
				{
					model,
					messages: [
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: userPrompt },
					],
					stream: false,
				},
				{ signal },
			),
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
