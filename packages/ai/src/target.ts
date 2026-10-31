import type { openEpicenterInference } from './ai.js';
import type { ConnectionCatalog } from './ai-connections.js';

export type InferenceSources = {
	errors?: string[];
	account: Awaited<ReturnType<typeof openEpicenterInference>> | null;
	connections: ConnectionCatalog | null;
};

import type OpenAI from 'openai';

export type InferenceTarget = { connectionId: string; model: string };
export type ResolvedInferenceTarget = {
	client: OpenAI;
	model: string;
	source: 'account' | 'custom';
};

/** The account source's stable id, from the identity the AI capability carries. */
export function accountInferenceId(ai: Pick<InferenceSources, 'account'>) {
	return ai.account
		? `account:${JSON.stringify([ai.account.identity.authorityId, ai.account.identity.principalId])}`
		: null;
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
	const client = ai.connections?.get(connectionId)?.client;
	return client ? { client, model, source: 'custom' } : null;
}
