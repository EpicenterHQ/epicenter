/** OpenAI-compatible inference: agent engine, connection presets, and errors. */

export type {
	AgentEngine,
	AgentEngineRequest,
} from '@epicenter/agent-protocol';
export { CONNECTION_PRESETS, type PresetId } from './connection-presets.js';
export { ListModelsError, TranscribeError } from './inference-errors.js';
export {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from './openai-provider.js';
