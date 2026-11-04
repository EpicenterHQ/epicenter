/**
 * `@epicenter/ai`: every source of models is an endpoint, and `openAi`
 * merges the endpoints an app passes (ADR-0757). Requests use the
 * OpenAI-compatible vocabulary: chat completions, audio transcriptions, and
 * embeddings.
 */

export { customEndpoints } from '#device-settings';
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
export { custom } from './custom.js';
export type { CustomEndpoints } from './custom-endpoints.js';
export {
	type Capability,
	type Endpoint,
	type EndpointFetch,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
	type Source,
} from './endpoint.js';
export { hosted, type LiveAccount } from './hosted.js';
export { localServers } from './local-servers.js';
export {
	type Ai,
	type EndpointEntry,
	type LiveEndpoints,
	type Model,
	type ModelChoice,
	openAi,
} from './open-ai.js';
