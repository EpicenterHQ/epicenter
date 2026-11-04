import type { JsonValue } from 'wellcrafted/json';
import type { ChatMessage, ToolCall } from '../client.js';

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
