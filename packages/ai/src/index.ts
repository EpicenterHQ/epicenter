/**
 * `@epicenter/ai`: every source of models is an endpoint, and `openAi`
 * merges the endpoints an app passes (ADR-0757). Requests use the
 * OpenAI-compatible vocabulary for audio transcriptions.
 */

export {
	AiError,
	type Client,
	createClient,
	type Transcription,
	type TranscriptionRequest,
} from './client.js';
export { custom } from './custom.js';
export {
	type ConnectionKeys,
	type ConnectionRecord,
	type ConnectionSnapshot,
	type ConnectionStore,
	type CustomConnectionInput,
	type CustomEndpoints,
	customEndpoints,
} from './custom-endpoints.js';
export {
	type Capability,
	type Endpoint,
	type EndpointFetch,
	type EndpointKey,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
	type Source,
} from './endpoint.js';
export { localServers } from './local-servers.js';
export {
	type Ai,
	type EndpointEntry,
	type LiveEndpoints,
	type Model,
	type ModelChoice,
	openAi,
} from './open-ai.js';
