import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { createChatMessageStore } from './chat-history.js';
import { chatHistoryDefinition } from './data.js';

const question: AgentMessage = {
	id: 'question',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'What does "lucid" mean?' }],
};

const answer: AgentMessage = {
	id: 'answer',
	role: 'assistant',
	createdAt: 2,
	parts: [{ type: 'text', text: 'Clear and easy to understand.' }],
};

const orderedMessages = (store: ReturnType<typeof createChatMessageStore>) =>
	[...store.entries()]
		.map(({ val }) => val)
		.sort((left, right) => left.createdAt - right.createdAt);

test('finished messages survive reopening and stay within their account', async () => {
	const record = createMemoryRecord();
	try {
		{
			await using db = await openMemory(chatHistoryDefinition, record);
			using first = createChatMessageStore(db.tables.messages, 'first');
			using second = createChatMessageStore(db.tables.messages, 'second');
			first.set(question.id, question);
			first.set(answer.id, answer);
			second.set(question.id, {
				...question,
				parts: [{ type: 'text', text: 'Other account' }],
			});
			expect(orderedMessages(first)).toEqual([question, answer]);
			expect([...second.entries()]).toHaveLength(1);
		}

		await using db = await openMemory(chatHistoryDefinition, record);
		using first = createChatMessageStore(db.tables.messages, 'first');
		using second = createChatMessageStore(db.tables.messages, 'second');
		expect(orderedMessages(first)).toEqual([question, answer]);
		db.transact(() => {
			for (const row of db.tables.messages.rows) {
				if (row.accountKey === 'first') db.tables.messages.delete(row.id);
			}
		});
		expect([...first.entries()]).toEqual([]);
		expect([...second.entries()]).toHaveLength(1);
	} finally {
		record.close();
	}
});

test('duplicate message rows present one stable value', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	db.tables.messages.create({
		accountKey: 'first',
		messageId: question.id,
		message: question,
	});
	db.tables.messages.create({
		accountKey: 'first',
		messageId: question.id,
		message: question,
	});
	using store = createChatMessageStore(db.tables.messages, 'first');
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
});
