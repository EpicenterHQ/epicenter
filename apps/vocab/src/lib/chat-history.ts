import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
import type { ChatHistoryData } from './data.js';

/** Present this account's finished local messages to the tutor loop. */
export function createChatMessageStore(
	messages: ChatHistoryData['tables']['messages'],
	accountKey: string,
): AgentMessageStore {
	return {
		set(key, value) {
			const existing = messages.rows
				.filter((row) => row.accountKey === accountKey && row.messageId === key)
				.sort((left, right) => left.id.localeCompare(right.id))[0];
			if (existing) {
				const written = messages.update(existing.id, { message: value });
				if (written.error !== null) throw written.error;
			} else {
				messages.create({ accountKey, messageId: key, message: value });
			}
		},
		*entries() {
			const byId = new Map<string, { id: string; message: AgentMessage }>();
			for (const row of messages.rows) {
				if (row.accountKey !== accountKey) continue;
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
