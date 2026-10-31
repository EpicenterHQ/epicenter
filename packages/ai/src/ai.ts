import type { Account } from '@epicenter/auth';
import { createInference, validateInferenceDestination } from './inference.js';

export { type CodexConnection, createCodexAi } from './codex-ai.js';
export { createEndpointAi } from './endpoint-ai.js';
export {
	type Ai,
	ReplyError,
	type ReplyEvent,
	type ReplyRequest,
} from './reply.js';
export type EndpointInferenceOptions = {
	baseURL: string;
	getAuthHeaders?: (options: {
		signal: AbortSignal;
	}) => HeadersInit | Promise<HeadersInit>;
};

export async function openEndpointInference({
	baseURL,
	getAuthHeaders,
}: EndpointInferenceOptions) {
	return createInference(
		{
			baseURL: validateInferenceDestination(baseURL),
			fetch: globalThis.fetch.bind(globalThis),
		},
		getAuthHeaders,
	);
}
export async function openEpicenterInference({
	account,
}: {
	account: Account;
}) {
	const identity = Object.freeze({
		authorityId: account.authorityId,
		principalId: account.principalId,
	});
	return Object.freeze({
		...createInference({
			baseURL: `${account.baseURL.replace(/\/+$/, '')}/v1`,
			fetch: account.fetch,
		}),
		identity,
	});
}
