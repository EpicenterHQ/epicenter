/**
 * `@epicenter/ai`: every source of models is an endpoint, and `openAi`
 * merges the endpoints an app passes. Requests use the
 * OpenAI-compatible vocabulary for audio transcriptions.
 */

export { AiError } from './client.js';
export { custom } from './custom.js';
export {
	type ConnectionRecord,
	type ConnectionStore,
	customEndpoints,
} from './custom-endpoints.js';
export type { Endpoint, EndpointModel } from './endpoint.js';
export { localServers } from './local-servers.js';
export { type Ai, type ModelChoice, openAi } from './open-ai.js';
