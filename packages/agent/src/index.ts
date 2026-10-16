/** `@epicenter/agent`: a UI-free agent loop over explicit host capabilities. */

export type {
	AgentEngine,
	AgentEngineRequest,
	EngineChunk,
} from '@epicenter/agent-protocol';
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
	type ModelMessage,
	type ModelToolCall,
	toModelMessages,
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
} from './tools.js';
