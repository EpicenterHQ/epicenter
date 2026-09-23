import { defineTable, field, jsonValue, type RowOf } from '@epicenter/app/definition';
import type { TypedTableHandle } from '@epicenter/app/store';
import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/** Account-scoped conversation metadata. Finished messages use sibling rows. */
export const conversationsTable = defineTable({
	fields: {
		accountKey: field.string(),
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
});

/** One finished agent message per row, linked to its conversation. */
export const messagesTable = defineTable({
	fields: {
		conversationId: field.string(),
		messageId: field.string(),
		message: field.json(jsonValue),
	},
});

export type Conversation = RowOf<typeof conversationsTable>;
export type ConversationsTable = TypedTableHandle<typeof conversationsTable>;
export type MessagesTable = TypedTableHandle<typeof messagesTable>;

/** Present one conversation's message rows to the agent loop. */
export function createAgentMessageStore(
	messages: MessagesTable,
	conversationId: ConversationId,
): AgentMessageStore {
	return {
		set(key, value) {
			const existing = messages.rows
				.filter((row) => row.conversationId === conversationId && row.messageId === key)
				.sort((left, right) => left.id.localeCompare(right.id))[0];
			if (existing) {
				const written = messages.update(existing.id, { message: value });
				if (written.error !== null) throw written.error;
			} else {
				messages.create({ conversationId, messageId: key, message: value });
			}
		},
		*entries() {
			const byId = new Map<string, { id: string; message: AgentMessage }>();
			for (const row of messages.rows) {
				if (row.conversationId !== conversationId) continue;
				const previous = byId.get(row.messageId);
				if (previous === undefined || row.id < previous.id) {
					byId.set(row.messageId, { id: row.id, message: row.message as AgentMessage });
				}
			}
			for (const [key, row] of byId) {
				yield { key, val: row.message };
			}
		},
		observe(handler) {
			return messages.subscribe(handler);
		},
		[Symbol.dispose]() {},
	};
}
