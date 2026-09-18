import type { AppAi } from '@epicenter/app/ai';
import { ListModelsError } from '@epicenter/client';
import OpenAI from 'openai';
import { createSubscriber } from 'svelte/reactivity';
import { Ok, type Result, tryAsync, unwrap } from 'wellcrafted/result';
import {
	accountInferenceId,
	type InferenceSelections,
	matchInferenceTarget,
	runtimeInferenceId,
} from '../inference-selections.js';

export type HostedModel = { id: string; label: string; credits: number };

/** Observe one App's AI capability and resolve exact saved workflow destinations. */
export function createInferenceConnections({
	connections,
	accountConnection,
	selections,
	hostedModels,
}: {
	connections: { runtime: AppAi['runtime']; custom: AppAi['connections'] };
	accountConnection: AppAi['account'];
	selections: InferenceSelections;
	hostedModels: HostedModel[];
}) {
	const ai: AppAi = {
		runtime: connections.runtime,
		connections: connections.custom,
		account: accountConnection,
	};
	if (!ai.connections)
		throw new Error('This App has no custom AI connection binding.');
	const observeConnections = createSubscriber((update) =>
		ai.connections!.subscribe(() => update()),
	);
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	const accountId = accountInferenceId(ai);
	const accountLabel = ai.account
		? new URL(ai.account.client.baseURL).host
		: '';
	const runtimeId = runtimeInferenceId(ai);
	let runtimeModels = $state.raw<string[]>([]);
	function target(scope: string, model: string) {
		observeSelections();
		const selected = selections.get(scope);
		return selected?.model === model ? selected : null;
	}
	function resolve(scope: string, model: string) {
		observeConnections();
		return matchInferenceTarget(ai, target(scope, model));
	}
	return {
		ai,
		selections,
		accountId,
		accountLabel,
		runtimeId,
		get runtimeModels() {
			return runtimeModels;
		},
		async refreshRuntime() {
			if (!ai.runtime) return;
			const result = await discoverModels(() => ai.runtime!.client);
			if (!result.error) runtimeModels = result.data;
		},
		hostedModels,
		get custom() {
			observeConnections();
			return ai.connections!.getAll();
		},
		discover(baseUrl: string, apiKey?: string, savedId?: string) {
			return discoverModels(() => {
				const client = savedId
					? ai.connections!.get(savedId)?.client
					: ai.connections!.preview({ baseUrl, apiKey });
				if (!client) throw new Error('AI connection no longer exists.');
				return client;
			});
		},
		async refresh(id: string) {
			const connection = ai.connections!.get(id);
			if (!connection) return;
			const result = await discoverModels(() => connection.client);
			const models = unwrap(result);
			const record = ai.connections!.get(id);
			if (!record || record.client !== connection.client) return;
			await ai.connections!.update(id, {
				models: [...new Set([...record.models, ...models])],
			});
		},
		target,
		resolve,
		canServe(scope: string, model: string) {
			return resolve(scope, model) !== null;
		},
	};
}
export type InferenceConnections = ReturnType<
	typeof createInferenceConnections
>;

/** Keep SDK request failures distinct from unusable model suggestions. */
async function discoverModels(
	client: () => OpenAI,
): Promise<Result<string[], ListModelsError>> {
	const result = await tryAsync({
		try: async () => client().models.list(),
		catch: (cause) =>
			cause instanceof OpenAI.APIError && cause.status !== undefined
				? ListModelsError.RequestFailed({ status: cause.status })
				: ListModelsError.Unreachable({ cause }),
	});
	if (result.error !== null) return result;
	const models = result.data.data;
	if (
		!Array.isArray(models) ||
		models.some((model) => !model || typeof model.id !== 'string')
	)
		return ListModelsError.Malformed();
	return Ok(models.map((model) => model.id));
}
