import type { AppAi } from '@epicenter/app/ai';
import { ListModelsError } from '@epicenter/client';
import { createSubscriber } from 'svelte/reactivity';
import { tryAsync, unwrap } from 'wellcrafted/result';
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
			const result = await tryAsync({
				try: async () =>
					(await ai.runtime!.client.models.list()).data.map(
						(model) => model.id,
					),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
			if (!result.error) runtimeModels = result.data;
		},
		hostedModels,
		get custom() {
			observeConnections();
			return ai.connections!.getAll();
		},
		discover(baseUrl: string, apiKey?: string, savedId?: string) {
			return tryAsync({
				try: async () => {
					const client = savedId
						? ai.connections!.get(savedId)?.client
						: ai.connections!.preview({ baseUrl, apiKey });
					if (!client) throw new Error('AI connection no longer exists.');
					return (await client.models.list()).data.map((model) => model.id);
				},
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
		},
		async refresh(id: string) {
			const connection = ai.connections!.get(id);
			if (!connection) return;
			const result = await tryAsync({
				try: async () =>
					(await connection.client.models.list()).data.map((model) => model.id),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
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
