import { defineStore } from '@epicenter/app';
/**
 * What this package promises: the canonical table splices into an application's
 * own workspace, and a conversation's messages survive a restart of that
 * application's store.
 *
 * The workspace here is a stand-in for a real application's (Vocab's is the live
 * one), which is the whole point: this package publishes a table shape, not a
 * workspace id.
 */

import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';

import { InstantString } from '@epicenter/app/field';
import { createMemoryRecord, openMemory } from '@epicenter/app/memory';
import {
	asConversationId,
	conversationsTable,
	createAgentMessageStore,
	messagesTable,
} from './index.js';

const testDefinition = defineStore({
	id: 'so.epicenter.chat-test',
	kv: {},
	tables: {
		conversations: conversationsTable,
		messages: messagesTable,
	},
});

const message: AgentMessage = {
	id: 'message-1',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Durable hello' }],
};

test('concurrent rows with the same message id present one keyed message', async () => {
	await using db = await openMemory(testDefinition);
	const conversationId = asConversationId('conversation-1');
	db.tables.messages.create({ conversationId, messageId: message.id, message });
	db.tables.messages.create({ conversationId, messageId: message.id, message });
	using store = createAgentMessageStore(db.tables.messages, conversationId);
	expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
});

test('the agent store observes writes and survives a restart', async () => {
	// One durable record, two runtimes over it: the second is the restart.
	const record = createMemoryRecord();
	let rowId: string;
	try {
		{
			const db = await openMemory(testDefinition, record);
			await using _db = db;
			const now = InstantString.fromDate(new Date('2026-07-19T00:00:00.000Z'));
			const created = db.tables.conversations.create({
				accountKey: 'test-account',
				title: 'New Chat',
				model: 'test',
				createdAt: now,
				updatedAt: now,
			});
			rowId = created.id;

			const row = db.tables.conversations.get(rowId);
			if (row === undefined) throw new Error('the row has no content');
			using store = createAgentMessageStore(db.tables.messages, asConversationId(row.id));
			let observations = 0;
			const unobserve = store.observe(() => observations++);
			store.set(message.id, message);
			unobserve();
			expect(observations).toBe(1);
		}

		const db = await openMemory(testDefinition, record);
		await using _db = db;
		const row = db.tables.conversations.get(rowId);
		if (row === undefined) throw new Error('the row has no content');
		using store = createAgentMessageStore(db.tables.messages, asConversationId(row.id));
		expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
	} finally {
		record.close();
	}
});
