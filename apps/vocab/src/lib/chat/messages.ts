import {
	type AgentMessage,
	type AgentMessageStore,
	agentMessageText,
} from '@epicenter/agent';
import { InstantString } from '@epicenter/app/field';
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

/** Persist the learner's focus before requesting the tutor opening. */
export function startChat(
	chats: ChatHistoryData['tables']['chats'],
	accountKey: string,
	focus: { entryId: string; text: string }[],
) {
	if (
		focus.length < 1 ||
		focus.length > 3 ||
		focus.some((item) => !item.entryId || !item.text.trim())
	)
		throw new Error('Choose one to three saved expressions.');
	return chats.create({
		accountKey,
		focus: focus.map((item) => ({ ...item })),
		createdAt: InstantString.now(),
	});
}

/** Keep pre-redesign, message-only conversations visible without inventing focus for them. */
export function listChats(
	chats: ChatHistoryData['tables']['chats']['rows'],
	messages: MessagesTable['rows'],
	accountKey: string,
) {
	const summaries = new Map<
		string,
		{
			id: string;
			title: string;
			focus: { entryId: string; text: string }[];
			updatedAt: number;
			legacy: boolean;
		}
	>();
	const firstQuestion = new Map<string, { time: number; id: string }>();
	for (const row of chats) {
		if (row.accountKey !== accountKey) continue;
		summaries.set(row.id, {
			id: row.id,
			title: row.focus.map((item) => item.text).join(', '),
			focus: row.focus,
			updatedAt: Date.parse(row.createdAt),
			legacy: false,
		});
	}
	for (const row of messages) {
		if (row.accountKey !== accountKey) continue;
		const message = row.message as AgentMessage;
		let chat = summaries.get(row.conversationId);
		if (!chat) {
			chat = {
				id: row.conversationId,
				title: 'Earlier chat',
				focus: [],
				updatedAt: 0,
				legacy: true,
			};
			summaries.set(row.conversationId, chat);
		}
		chat.updatedAt = Math.max(chat.updatedAt, message.createdAt);
		const previous = firstQuestion.get(chat.id);
		if (
			chat.legacy &&
			message.role === 'user' &&
			(!previous ||
				message.createdAt < previous.time ||
				(message.createdAt === previous.time && row.id < previous.id))
		) {
			firstQuestion.set(chat.id, { time: message.createdAt, id: row.id });
			chat.title =
				agentMessageText(message).trim().slice(0, 60) || 'Earlier chat';
		}
	}
	return [...summaries.values()].sort(
		(a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
	);
}

export type ChatSummary = ReturnType<typeof listChats>[number];
