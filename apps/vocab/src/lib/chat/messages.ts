import {
	type AgentMessage,
	type AgentMessageStore,
	agentMessageText,
} from '@epicenter/agent';
import type { ChatHistoryData } from '../data.js';

type MessagesTable = ChatHistoryData['tables']['messages'];

/** Present one account's one conversation to the tutor loop. */
export function createChatMessageStore(
	messages: MessagesTable,
	accountKey: string,
	conversationId: string,
): AgentMessageStore {
	return {
		set(key, value) {
			const existing = messages.rows
				.filter(
					(row) =>
						row.accountKey === accountKey &&
						row.conversationId === conversationId &&
						row.messageId === key,
				)
				.sort((left, right) => left.id.localeCompare(right.id))[0];
			if (existing) {
				const written = messages.update(existing.id, { message: value });
				if (written.error !== null) throw written.error;
			} else {
				messages.create({
					accountKey,
					conversationId,
					messageId: key,
					message: value,
				});
			}
		},
		*entries() {
			const byId = new Map<string, { id: string; message: AgentMessage }>();
			for (const row of messages.rows) {
				if (
					row.accountKey !== accountKey ||
					row.conversationId !== conversationId
				)
					continue;
				const previous = byId.get(row.messageId);
				if (!previous || row.id < previous.id) {
					byId.set(row.messageId, {
						id: row.id,
						message: row.message as AgentMessage,
					});
				}
			}
			for (const [key, row] of byId) yield { key, val: row.message };
		},
		observe(handler) {
			return messages.subscribe(handler);
		},
		[Symbol.dispose]() {},
	};
}

/** A chat exists in the sidebar only after its first sent question. */
export function listChats(rows: MessagesTable['rows'], accountKey: string) {
	const chats = new Map<
		string,
		{
			id: string;
			title: string;
			firstQuestionAt: number;
			updatedAt: number;
		}
	>();
	for (const row of rows) {
		if (row.accountKey !== accountKey) continue;
		const message = row.message as AgentMessage;
		const chat = chats.get(row.conversationId) ?? {
			id: row.conversationId,
			title: 'Chat',
			firstQuestionAt: Number.POSITIVE_INFINITY,
			updatedAt: Number.NEGATIVE_INFINITY,
		};
		chat.updatedAt = Math.max(chat.updatedAt, message.createdAt);
		if (message.role === 'user' && message.createdAt < chat.firstQuestionAt) {
			chat.firstQuestionAt = message.createdAt;
			chat.title = agentMessageText(message).trim().slice(0, 60) || 'Chat';
		}
		chats.set(row.conversationId, chat);
	}
	return [...chats.values()].sort(
		(left, right) =>
			right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
	);
}

export type ChatSummary = ReturnType<typeof listChats>[number];
