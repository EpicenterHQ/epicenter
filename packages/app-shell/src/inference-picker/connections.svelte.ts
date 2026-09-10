import type { App } from '@epicenter/app';
import {
	accountInferenceId,
	runtimeInferenceId,
	matchInferenceTarget,
	type InferenceSelections,
} from '../inference-selections.js';
import { ListModelsError } from '@epicenter/client';
import type { DataDefinition } from '@epicenter/data/definition';
import { createSubscriber } from 'svelte/reactivity';
import { tryAsync, unwrap } from 'wellcrafted/result';

export type HostedModel = { id: string; label: string; credits: number };

/** Observe one App's configuration and resolve exact saved workflow destinations. */
export function createInferenceConnections({
	app,
	selections,
	hostedModels,
}: {
	app: Pick<App<DataDefinition>, 'ai' | 'account'>;
	selections: InferenceSelections;
	hostedModels: HostedModel[];
}) {
	if (!app.ai.connections)
		throw new Error('This App has no custom AI connection binding.');
	const observeConnections = createSubscriber((update) =>
		app.ai.connections!.subscribe(() => update()),
	);
	const observeSelections = createSubscriber((update) =>
		selections.onChange(update),
	);
	const accountId = accountInferenceId(app);
	const accountLabel = app.ai.account
		? new URL(app.ai.account.client.baseURL).host
		: '';
	const runtimeId = runtimeInferenceId(app);
	let runtimeModels = $state.raw<string[]>([]);
	function target(scope: string, model: string) {
		observeSelections();
		const selected = selections.get(scope);
		return selected?.model === model ? selected : null;
	}
	function resolve(scope: string, model: string) {
		observeConnections();
		return matchInferenceTarget(app, target(scope, model));
	}
	return {
		app,
		selections,
		accountId,
		accountLabel,
		runtimeId,
		get runtimeModels() {
			return runtimeModels;
		},
		async refreshRuntime() {
			if (!app.ai.runtime) return;
			const result = await tryAsync({
				try: async () =>
					(await app.ai.runtime!.client.models.list()).data.map(
						(model) => model.id,
					),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
			if (!result.error) runtimeModels = result.data;
		},
		hostedModels,
		get custom() {
			observeConnections();
			return app.ai.connections!.getAll();
		},
		discover(baseUrl: string, apiKey?: string, savedId?: string) {
			return tryAsync({
				try: async () => {
					const client = savedId
						? app.ai.connections!.get(savedId)?.client
						: app.ai.connections!.preview({ baseUrl, apiKey });
					if (!client) throw new Error('AI connection no longer exists.');
					return (await client.models.list()).data.map((model) => model.id);
				},
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
		},
		async refresh(id: string) {
			const connection = app.ai.connections!.get(id);
			if (!connection) return;
			const result = await tryAsync({
				try: async () =>
					(await connection.client.models.list()).data.map((model) => model.id),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
			const models = unwrap(result);
			const record = app.ai.connections!.get(id);
			if (!record || record.client !== connection.client) return;
			await app.ai.connections!.update(id, {
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
