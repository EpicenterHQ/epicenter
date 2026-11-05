/**
 * `@epicenter/ai/agent`: a UI-free agent loop over values. It takes a
 * contract's messages collection (`messagesCollection`), the chat it is,
 * `ai`, the model, the system prompt, and the tools as an array. Svelte
 * reads a conversation through `reactive` from `@epicenter/svelte/reactive`.
 */

export {
	ConversationAdmissionError,
	type ConversationError,
	type ConversationHandle,
	type ConversationMessages,
	type ConversationOptions,
	type ConversationSnapshot,
	createConversation,
	type UnreadableMessage,
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
	type MessageNote,
	type MessagesCollection,
	messagesCollection,
} from './message.js';
export type {
	AgentTool,
	AgentToolCall,
	AgentToolOutcome,
	Approve,
} from './tools.js';
