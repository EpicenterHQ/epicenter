import type { Account } from '@epicenter/account';
import { createInference, validateInferenceDestination } from './inference.js';

export {
	AiError,
	type ChatChunk,
	type ChatMessage,
	type ChatRequest,
	type ChatTool,
	type Client,
	createClient,
	type Embeddings,
	type EmbeddingsRequest,
	type ToolCall,
	type ToolCallDelta,
	type Transcription,
	type TranscriptionRequest,
} from './client.js';
export { type CodexConnection, createCodexAi } from './codex-ai.js';
export { custom } from './custom.js';
export {
	type Capability,
	type Endpoint,
	type EndpointFetch,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
	type Source,
} from './endpoint.js';
export { createEndpointAi } from './endpoint-ai.js';
export { hosted } from './hosted.js';
export { localServers } from './local-servers.js';
export {
	type EndpointEntry,
	type Model,
	type ModelChoice,
	openAi,
} from './open-ai.js';
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
