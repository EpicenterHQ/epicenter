import type {
	openEpicenterInference,
	openRuntimeInference,
} from '@epicenter/app/ai';
import type { ConnectionCatalog } from '@epicenter/app/ai-connections';

export type InferenceSources = {
	account: Awaited<ReturnType<typeof openEpicenterInference>> | null;
	runtime: Awaited<ReturnType<typeof openRuntimeInference>>;
	connections: ConnectionCatalog | null;
};
import type OpenAI from 'openai';

export type InferenceTarget = { connectionId: string; model: string };
export type ResolvedInferenceTarget = {
	client: OpenAI;
	model: string;
	source: 'account' | 'runtime' | 'custom';
};

/** The account source's stable id, from the identity the AI capability carries. */
export function accountInferenceId(ai: Pick<InferenceSources, 'account'>) {
	return ai.account
		? `account:${JSON.stringify([ai.account.identity.authorityId, ai.account.identity.principalId])}`
		: null;
}

export function runtimeInferenceId(ai: Pick<InferenceSources, 'runtime'>) {
	return ai.runtime ? `runtime:${ai.runtime.client.baseURL}` : null;
}

/** Resolve an explicit destination; missing identities never select another source. */
export function resolveInferenceTarget(
	ai: InferenceSources,
	target: InferenceTarget | null,
): ResolvedInferenceTarget | null {
	if (!target || !target.model.trim()) return null;
	const { model, connectionId } = target;
	if (connectionId === accountInferenceId(ai) && ai.account)
		return { client: ai.account.client, model, source: 'account' };
	if (connectionId === runtimeInferenceId(ai) && ai.runtime)
		return { client: ai.runtime.client, model, source: 'runtime' };
	const client = ai.connections?.get(connectionId)?.client;
	return client ? { client, model, source: 'custom' } : null;
}
