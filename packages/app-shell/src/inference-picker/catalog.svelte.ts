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
	ai: sources,
    signal,
	hostedModels,
}: {
	ai: InferenceSources | Promise<InferenceSources>;
    signal?: AbortSignal;
	hostedModels: HostedModel[];
}) {
    function observe(ai: InferenceSources) {
        return { ai, changed: createSubscriber((update) => ai.connections?.subscribe(() => update())) };
    }
    let current = $state.raw(observe(sources instanceof Promise ? { account: null, runtime: null, connections: null } : sources));
    let loading = $state.raw(sources instanceof Promise);
    const ready = sources instanceof Promise ? sources.then((ai) => {
        current = observe(ai);
        loading = false;
    }, (cause) => {
        current = observe({ account: null, runtime: null, connections: null, errors: [String(cause)] });
        loading = false;
    }) : Promise.resolve();
	let runtimeModels = $state.raw<string[]>([]);
    let runtimeError = $state.raw<string | null>(null);
	return {
        ready,
        get ai() { return current.ai; },
        get loading() { return loading; },
        get errors() { return current.ai.errors ?? []; },
        get accountId() { return accountInferenceId(current.ai); },
        get accountLabel() { return current.ai.account ? new URL(current.ai.account.client.baseURL).host : ''; },
        get runtimeId() { return runtimeInferenceId(current.ai); },
		get runtimeError() { return runtimeError; },
        get runtimeModels() {
			return runtimeModels;
		},
		async refreshRuntime() {
			const ai = current.ai;
			if (!ai.runtime) return;
			const result = await ai.runtime.listModels({ signal });
            if (signal?.aborted) return result;
            runtimeError = result.error?.message ?? null;
            if (!result.error) runtimeModels = result.data.map((model) => model.id);
            return result;
		},
		hostedModels,
		get custom() {
			current.changed();
			return current.ai.connections?.getAll() ?? [];
		},
		discover(client: OpenAI) {
			return discoverModels(() => client, signal);
		},
		async refresh(id: string) {
			const ai = current.ai;
            const connection = ai.connections?.get(id);
			if (!connection) return;
			const result = await discoverModels(() => connection.client, signal);
			const models = unwrap(result);
			const record = ai.connections!.get(id);
			if (signal?.aborted || !record || record.client !== connection.client) return;
			await ai.connections!.update(id, {
				models: [...new Set([...record.models, ...models])],
			});
		},
		resolve(target: InferenceTarget | null) {
			current.changed();
			return resolveInferenceTarget(current.ai, target);
		},
	};
}
export type InferenceCatalog = ReturnType<typeof createInferenceCatalog>;

/** Keep SDK request failures distinct from unusable model suggestions. */
async function discoverModels(
	client: () => OpenAI,
    signal?: AbortSignal,
): Promise<Result<string[], ListModelsError>> {
	const result = await tryAsync({
		try: async () => client().models.list({ signal }),
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
