import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { expectOk } from 'wellcrafted/testing';
import { createBrowser, createMemory, until } from '../folder.test-support.js';

const { createChatMessageStore, messageId } = await import(
	'./messages.svelte.js'
);

import { createChats, startChat } from './chats.js';

const { flushSync } = await import('svelte');

const message = (id: string, text: string, createdAt = 1): AgentMessage => ({
	id,
	role: 'user',
	createdAt,
	parts: [{ type: 'text', text }],
});

test('a message save answers when its file and row exist', async () => {
	const { folder, core } = await createMemory();
	const store = createChatMessageStore(folder, 'chat-a');
	const value = message('one', '你好 🌿');
	expectOk(await store.set(value.id, value));
	expect(
		folder.tables.messages.row(messageId('chat-a', 'one'))?.issues,
	).toBeNull();
	expect([...store.entries()][0]?.val.parts).toEqual(value.parts);
	expectOk(await store.set(value.id, value));
	expect([...store.entries()]).toHaveLength(1);
	await core.close();
});

test('multiline Markdown and tool parts read back through the row schema', async () => {
	const { folder, core } = await createMemory();
	const value: AgentMessage = {
		id: 'rich',
		role: 'assistant',
		createdAt: 2,
		parts: [
			{ type: 'text', text: '你好 🌿\n---\nA second line' },
			{
				type: 'tool-call',
				toolCallId: 'call-1',
				toolName: 'lookup',
				input: { term: 'lucid' },
			},
			{
				type: 'tool-result',
				toolCallId: 'call-1',
				toolName: 'lookup',
				content: 'clear',
				isError: false,
			},
		],
	};
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set(value.id, value));
	expect([...store.entries()][0]?.val.parts).toEqual(value.parts);
	await core.close();
});

test('a conflicting message id is refused', async () => {
	const { folder, core } = await createMemory();
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set('one', message('one', 'first')));
	expect((await store.set('one', message('one', 'other'))).error?.name).toBe(
		'WriteFailed',
	);
	await core.close();
});

test('each chat reads only its message files and duplicate ids use the lowest filename', async () => {
	const { folder, core } = await createMemory();
	const first = createChatMessageStore(folder, 'chat-a');
	const second = createChatMessageStore(folder, 'chat-b');
	expectOk(await first.set('z', message('duplicate', 'high')));
	expectOk(await first.set('a', message('duplicate', 'low')));
	expectOk(await second.set('x', message('other', 'other chat')));
	expect([...first.entries()].map(({ val }) => val.parts)).toEqual([
		message('duplicate', 'low').parts,
	]);
	expect([...second.entries()].map(({ key }) => key)).toEqual(['other']);
	await core.close();
});

test('retry finds a message saved by an earlier attempt', async () => {
	const { folder, core } = await createMemory();
	const value = message('one', 'saved');
	expectOk(await createChatMessageStore(folder, 'chat-a').set('one', value));
	expectOk(await createChatMessageStore(folder, 'chat-a').set('one', value));
	await core.close();
});

test('a closed folder answers WriteFailed', async () => {
	const { folder, core } = await createMemory();
	await core.close();
	expect(
		(
			await createChatMessageStore(folder, 'chat-a').set(
				'one',
				message('one', 'x'),
			)
		).error?.name,
	).toBe('WriteFailed');
});

test('chat listing follows the mirror', async () => {
	const { folder, core } = await createMemory();
	const chats = createChats(folder);
	const started = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'word', text: 'lucid' }]),
	);
	expect(chats.listing.chats[0]?.id).toBe(started.id);
	await core.close();
});

test('observe fires when another tab adds a message', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	const otherFolder = await browser.open();
	const store = createChatMessageStore(folder, 'chat-a');
	let changes = 0;
	const stop = store.observe(() => changes++);
	flushSync();
	const value = message('one', 'outside');
	const other = createChatMessageStore(otherFolder, 'chat-a');
	expectOk(await other.set('one', value));
	await until(() => {
		flushSync();
		return changes > 0;
	}, 'message observation');
	stop();
	expect([...store.entries()][0]?.key).toBe('one');
});
