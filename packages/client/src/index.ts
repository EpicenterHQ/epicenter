/**
 * `@epicenter/client`: portable OpenAI-compatible inference clients.
 *
 * The package owns no Epicenter data API. Universal records, documents, and
 * immutable record blobs are bound through `@epicenter/data`.
 */

export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
	EngineFetch,
	ModelMessage,
	ModelToolCall,
} from './agent-engine.js';
export { CompleteError, complete } from './complete.js';
export {
	CONNECTION_PRESETS,
	type Connection,
	type ConnectionPreset,
	ListModelsError,
	listModels,
	type PresetId,
	type ResolvedConnection,
	resolveConnection,
} from './connection.js';
export {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from './openai-provider.js';
export { TranscribeError, transcribe } from './transcribe.js';
