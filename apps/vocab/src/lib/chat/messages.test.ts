import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import { chatHistoryDefinition } from '../data.js';
import { createChatMessageStore, listChats, startChat } from './messages.js';

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
				listChats(
					db.tables.chats.rows,
					db.tables.messages.rows,
					'account-a',
				).map(({ id, title }) => ({ id, title })),
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
		expect(
			listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-b'),
		).toHaveLength(1);
		expect(
			listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
		).toHaveLength(2);
	} finally {
		record.close();
	}
});

test('a legacy chat appears after its first message', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	using chat = createChatMessageStore(
		db.tables.messages,
		'account-a',
		'new-chat',
	);
	expect([...chat.entries()]).toEqual([]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
	).toEqual([]);
	chat.set(question.id, question);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a')[0]
			?.id,
	).toBe('new-chat');
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

test('a focused chat is listed before an answer, scoped to its account, and retains text after entry deletion', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	const chat = startChat(db.tables.chats, 'account-a', [
		{ entryId: 'deleted-entry', text: 'lucid' },
	]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a'),
	).toMatchObject([
		{
			id: chat.id,
			title: 'lucid',
			focus: [{ entryId: 'deleted-entry', text: 'lucid' }],
		},
	]);
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-b'),
	).toEqual([]);
});

test('legacy title comes from the earliest question even when rows arrive out of order', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	db.tables.messages.create({
		accountKey: 'account-a',
		conversationId: 'old-chat',
		messageId: 'later',
		message: { ...nextQuestion, createdAt: 20 },
	});
	db.tables.messages.create({
		accountKey: 'account-a',
		conversationId: 'old-chat',
		messageId: 'earlier',
		message: question,
	});
	expect(
		listChats(db.tables.chats.rows, db.tables.messages.rows, 'account-a')[0]
			?.title,
	).toBe('What does "lucid" mean?');
});

test('focus requires one to three expressions', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	expect(() => startChat(db.tables.chats, 'account-a', [])).toThrow();
	expect(() =>
		startChat(
			db.tables.chats,
			'account-a',
			Array.from({ length: 4 }, (_, index) => ({
				entryId: String(index),
				text: 'word',
			})),
		),
	).toThrow();
});
