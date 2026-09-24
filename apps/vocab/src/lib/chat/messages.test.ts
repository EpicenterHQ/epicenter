import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { chatHistoryDefinition } from '../data.js';
import { createChatMessageStore, listChats } from './messages.js';

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
const nextQuestion: AgentMessage = {
	id: 'next-question',
	role: 'user',
	createdAt: 3,
	parts: [{ type: 'text', text: 'How do I use "subtle"?' }],
};

test('saved chats survive reopening and stay within their account and conversation', async () => {
	const record = createMemoryRecord();
	try {
		{
			await using db = await openMemory(chatHistoryDefinition, record);
			using first = createChatMessageStore(
				db.tables.messages,
				'account-a',
				'chat-a',
			);
			using second = createChatMessageStore(
				db.tables.messages,
				'account-a',
				'chat-b',
			);
			using otherAccount = createChatMessageStore(
				db.tables.messages,
				'account-b',
				'chat-a',
			);
			first.set(question.id, question);
			first.set(answer.id, answer);
			second.set(nextQuestion.id, nextQuestion);
			otherAccount.set(question.id, {
				...question,
				parts: [{ type: 'text', text: 'Private' }],
			});
			expect(
				[...first.entries()]
					.map(({ val }) => val)
					.sort((a, b) => a.createdAt - b.createdAt),
			).toEqual([question, answer]);
			expect([...second.entries()].map(({ val }) => val)).toEqual([
				nextQuestion,
			]);
			expect(
				listChats(db.tables.messages.rows, 'account-a').map(
					({ id, title }) => ({ id, title }),
				),
			).toEqual([
				{ id: 'chat-b', title: 'How do I use "subtle"?' },
				{ id: 'chat-a', title: 'What does "lucid" mean?' },
			]);
		}

		await using db = await openMemory(chatHistoryDefinition, record);
		using first = createChatMessageStore(
			db.tables.messages,
			'account-a',
			'chat-a',
		);
		using second = createChatMessageStore(
			db.tables.messages,
			'account-a',
			'chat-b',
		);
		expect([...first.entries()]).toHaveLength(2);
		expect([...second.entries()]).toHaveLength(1);
		expect(listChats(db.tables.messages.rows, 'account-b')).toHaveLength(1);
		expect(listChats(db.tables.messages.rows, 'account-a')).toHaveLength(2);
	} finally {
		record.close();
	}
});

test('an empty new chat has no durable row until its first message', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	using chat = createChatMessageStore(
		db.tables.messages,
		'account-a',
		'new-chat',
	);
	expect([...chat.entries()]).toEqual([]);
	expect(listChats(db.tables.messages.rows, 'account-a')).toEqual([]);
	chat.set(question.id, question);
	expect(listChats(db.tables.messages.rows, 'account-a')[0]?.id).toBe(
		'new-chat',
	);
});

test('duplicate message rows present one stable value inside one conversation', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	for (let index = 0; index < 2; index++) {
		db.tables.messages.create({
			accountKey: 'account-a',
			conversationId: 'chat-a',
			messageId: question.id,
			message: question,
		});
	}
	using chat = createChatMessageStore(
		db.tables.messages,
		'account-a',
		'chat-a',
	);
	expect([...chat.entries()]).toEqual([{ key: question.id, val: question }]);
});
