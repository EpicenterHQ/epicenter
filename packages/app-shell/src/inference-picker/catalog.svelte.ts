import type { InferenceSources } from '../inference-target.js';
import { ListModelsError } from '@epicenter/client';
import OpenAI from 'openai';
import { createSubscriber } from 'svelte/reactivity';
import { Ok, type Result, tryAsync, unwrap } from 'wellcrafted/result';
import {
	accountInferenceId,
	type InferenceTarget,
	resolveInferenceTarget,
	runtimeInferenceId,
} from '../inference-target.js';

export type HostedModel = { id: string; label: string; credits: number };

/** Observe available inference connections and discover their suggested models. */
export function createInferenceCatalog({
	ai,
	hostedModels,
}: {
	ai: InferenceSources;
	hostedModels: HostedModel[];
}) {
	if (!ai.connections)
		throw new Error('This App has no custom AI connection binding.');
	const observeConnections = createSubscriber((update) =>
		ai.connections!.subscribe(() => update()),
	);
	const accountId = accountInferenceId(ai);
	const accountLabel = ai.account
		? new URL(ai.account.client.baseURL).host
		: '';
	const runtimeId = runtimeInferenceId(ai);
	let runtimeModels = $state.raw<string[]>([]);
	return {
		ai,
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
		discover(client: OpenAI) {
			return discoverModels(() => client);
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
		resolve(target: InferenceTarget | null) {
			observeConnections();
			return resolveInferenceTarget(ai, target);
		},
	};
}
export type InferenceCatalog = ReturnType<typeof createInferenceCatalog>;

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
