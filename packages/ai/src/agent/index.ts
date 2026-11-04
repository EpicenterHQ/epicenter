/** `@epicenter/ai/agent`: a UI-free agent loop over explicit host capabilities. */

export { type ChatTurn, createChatEngine } from './chat-engine.js';
export type {
	AgentEngine,
	AgentEngineRequest,
	EngineChunk,
} from './engine.js';
export {
	type AgentMessageStore,
	AgentMessageStoreError,
	ConversationAdmissionError,
	type ConversationError,
	type ConversationHandle,
	type ConversationOptions,
	type ConversationSnapshot,
	createConversation,
} from './loop.js';
export {
	type AgentMessage,
	type AgentMessagePart,
	type AgentMessageRole,
	type AgentTextPart,
	type AgentToolCallPart,
	type AgentToolResultPart,
	agentMessageText,
	isPersistableMessage,
	toChatMessages,
} from './message.js';
export {
	type AgentToolCall,
	type AgentToolDefinition,
	type AgentToolOutcome,
	type Approval,
	type ApprovalDecision,
	defaultApprovalDecision,
	NO_TOOLS,
	resolveApprovedToolCall,
	type ToolCatalog,
	toChatTools,
} from './tools.js';
