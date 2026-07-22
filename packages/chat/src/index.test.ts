/** Canonical conversation document adapter and restart durability tests. */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@epicenter/agent';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import { chatLens, createAgentMessageDocumentStore } from './index.js';

const message: AgentMessage = {
	id: 'message-1',
	role: 'user',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Durable hello' }],
};

test('the agent store observes writes and survives a runtime restart', async () => {
	const workspacesRoot = mkdtempSync(join(tmpdir(), 'epicenter-chat-'));
	let rowId: string;
	try {
		{
			await using epicenter = await openBunRecordEpicenter({
				directory: workspacesRoot,
			});
			const conversations = epicenter.bind({ chat: chatLens }).chat
				.conversations;
			const now = InstantString.fromDate(new Date('2026-07-19T00:00:00.000Z'));
			const row = await conversations.create({
				title: 'New Chat',
				model: 'test',
				createdAt: now,
				updatedAt: now,
			});
			rowId = row.id;
			await using store = createAgentMessageDocumentStore(
				await conversations.openDocument(row.id),
			);
			let observations = 0;
			const unobserve = store.observe(() => observations++);
			store.set(message.id, message);
			await store.whenDurable();
			unobserve();
			expect(observations).toBe(1);
		}

		await using reopened = await openBunRecordEpicenter({
			directory: workspacesRoot,
		});
		const conversations = reopened.bind({ chat: chatLens }).chat.conversations;
		await using store = createAgentMessageDocumentStore(
			await conversations.openDocument(rowId),
		);
		expect([...store.entries()]).toEqual([{ key: message.id, val: message }]);
	} finally {
		rmSync(workspacesRoot, { recursive: true, force: true });
	}
});
