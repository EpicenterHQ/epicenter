import type { NoteOf } from '@epicenter/definition/contract';
import type { JsonValue } from 'wellcrafted/json';
import type { ChatMessage, ToolCall } from '../client.js';

const text = { type: 'string' } as const;

/**
 * The collection a contract keeps an agent's finished messages in, one note
 * per message: `messages/{chat}/{id}.md`, holding who wrote it, when
 * (milliseconds), and its parts (text, and the model's tool calls and their
 * results). An app adds it to its contract (`messages: messagesCollection`)
 * and hands the folder's collection (`folder.messages`) to `createConversation`.
 */
export const messagesCollection = {
	path: 'messages/{chat}/{id}.md',
	fields: {
		role: { enum: ['user', 'assistant'] },
		createdAt: { type: 'number' },
		parts: {
			type: 'array',
			items: {
				anyOf: [
					{
						type: 'object',
						properties: { type: { const: 'text' }, text },
						required: ['type', 'text'],
					},
					{
						type: 'object',
						properties: {
							type: { const: 'tool-call' },
							toolCallId: text,
							toolName: text,
							input: {},
						},
						required: ['type', 'toolCallId', 'toolName', 'input'],
					},
					{
						type: 'object',
						properties: {
							type: { const: 'tool-result' },
							toolCallId: text,
							toolName: text,
							content: text,
							details: {},
							isError: { type: 'boolean' },
						},
						required: ['type', 'toolCallId', 'toolName', 'content', 'isError'],
					},
				],
			},
		},
	},
	required: ['role', 'createdAt', 'parts'],
} as const;
export type MessagesCollection = typeof messagesCollection;

/** One message's note, as the collection reads it. */
export type MessageNote = NoteOf<MessagesCollection>;

/** A message note as the loop holds it: a plain copy, its own. */
export function readMessage(note: MessageNote): AgentMessage {
	const { id, role, createdAt, parts } = note;
	// SAFETY: the collection's parts are the agent's parts, as JSON.
	return structuredClone({ id, role, createdAt, parts }) as AgentMessage;
}

export type AgentTextPart = { type: 'text'; text: string };

export type AgentToolCallPart = {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	input: JsonValue;
};

export type AgentToolResultPart = {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	content: string;
	details?: JsonValue;
	isError: boolean;
};

export type AgentMessagePart =
	| AgentTextPart
	| AgentToolCallPart
	| AgentToolResultPart;

export type AgentMessageRole = 'user' | 'assistant';

/** One finished message, persisted whole under its globally unique id. */
export type AgentMessage = {
	id: string;
	role: AgentMessageRole;
	createdAt: number;
	parts: AgentMessagePart[];
};

export function agentMessageText(message: AgentMessage): string {
	let text = '';
	for (const part of message.parts) {
		if (part.type === 'text') text += part.text;
	}
	return text;
}

export function isPersistableMessage(message: AgentMessage): boolean {
	return message.parts.some(
		(part) =>
			(part.type === 'text' && part.text.length > 0) ||
			part.type === 'tool-call' ||
			part.type === 'tool-result',
	);
}

/**
 * Freeze the durable transcript into the OpenAI chat messages a model reads:
 * a user message's text, an assistant message's text with its tool calls, and
 * one `tool` message per tool result after the assistant message that asked.
 */
export function toChatMessages(messages: AgentMessage[]): ChatMessage[] {
	const prompt: ChatMessage[] = [];
	for (const message of messages) {
		if (message.role === 'user') {
			const content = agentMessageText(message);
			if (content.length > 0) prompt.push({ role: 'user', content });
			continue;
		}

		const toolCalls: ToolCall[] = [];
		for (const part of message.parts) {
			if (part.type !== 'tool-call') continue;
			toolCalls.push({
				id: part.toolCallId,
				type: 'function',
				function: {
					name: part.toolName,
					arguments: JSON.stringify(part.input),
				},
			});
		}
		prompt.push({
			role: 'assistant',
			content: agentMessageText(message),
			...(toolCalls.length > 0 && { tool_calls: toolCalls }),
		});

		for (const part of message.parts) {
			if (part.type !== 'tool-result') continue;
			prompt.push({
				role: 'tool',
				tool_call_id: part.toolCallId,
				content: part.content,
			});
		}
	}
	return prompt;
}
