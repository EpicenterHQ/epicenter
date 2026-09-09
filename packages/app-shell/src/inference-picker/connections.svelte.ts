import type { App } from '@epicenter/app';
import type { AiTarget } from '@epicenter/app/ai-configuration';
import { type Connection, ListModelsError } from '@epicenter/client';
import type { DataDefinition } from '@epicenter/data/definition';
import { createSubscriber } from 'svelte/reactivity';
import { tryAsync } from 'wellcrafted/result';

export type HostedModel = { id: string; label: string; credits: number };
export type InferenceTarget = AiTarget;

/** Observe one App's configuration and resolve exact saved workflow destinations. */
export function createInferenceConnections({
	app,
	hostedModels,
}: {
	app: Pick<App<DataDefinition>, 'ai' | 'account'>;
	hostedModels: HostedModel[];
}) {
	const configuration = app.ai.configuration;
	if (!configuration)
		throw new Error('This App has no AI configuration binding.');
	const observe = createSubscriber((update) => configuration.onChange(update));
	const accountId =
		app.account === null
			? null
			: `account:${JSON.stringify([app.account.authorityId, app.account.principalId])}`;
	const accountLabel = app.ai.account
		? new URL(app.ai.account.client.baseURL).host
		: '';
	const runtimeId = app.ai.runtime
		? `runtime:${app.ai.runtime.client.baseURL}`
		: null;
	let runtimeModels = $state.raw<string[]>([]);
	function target(scope: string, model: string) {
		observe();
		return configuration!.target(scope, model);
	}
	function resolve(scope: string, model: string) {
		const selected = target(scope, model);
		if (!selected) return null;
		if (selected.connectionId === accountId)
			return app.ai.account?.client ?? null;
		if (selected.connectionId === runtimeId)
			return app.ai.runtime?.client ?? null;
		return (
			app.ai.configured().find((entry) => entry.id === selected.connectionId)
				?.client ?? null
		);
	}
	return {
		ai: app.ai,
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
			observe();
			const snapshot = app.ai.configured();
			return configuration.read().map((record) => ({
				...record,
				...snapshot.find((entry) => entry.id === record.id)!,
			}));
		},
		add(connection: Connection & { name?: string }, models: string[] = []) {
			return configuration.add({
				...connection,
				name: connection.name,
				models,
			});
		},
		update: configuration.update,
		remove: configuration.remove,
		reorder: configuration.reorder,
		discover(baseUrl: string, apiKey?: string) {
			const client = configuration.preview({ baseUrl, apiKey });
			return tryAsync({
				try: async () =>
					(await client.models.list()).data.map((model) => model.id),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
		},
		async refresh(id: string) {
			const connection = app.ai.configured().find((entry) => entry.id === id);
			if (!connection) return;
			const result = await tryAsync({
				try: async () =>
					(await connection.client.models.list()).data.map((model) => model.id),
				catch: (cause) => ListModelsError.Unreachable({ cause }),
			});
			if (result.error) return;
			const record = configuration.read().find((entry) => entry.id === id);
			if (
				!record ||
				app.ai.configured().find((entry) => entry.id === id)?.client !==
					connection.client
			)
				return;
			configuration.update(id, {
				models: [...new Set([...record.models, ...result.data])],
			});
		},
		select: configuration.select,
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
