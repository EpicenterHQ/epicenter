/**
 * A chat's messages and the chat list, over one folder's
 * `messages/{chat}/{id}.md` and `chats/{id}.md` notes: each tutor
 * conversation (`createConversation` over the folder's messages) reads its
 * own as the folder shows them and writes its own.
 *
 * Key behaviors:
 * - A message is one note named by its own id, in its chat
 * - Text and tool parts read back whole; each chat reads only its own
 * - A message sent while the store is out of reach shows, and lands once
 *   it is back
 * - Chats list newest first; a refused focus writes nothing
 * - Notes that do not read are reported, never hidden among valid ones
 * - Another program's new message is heard
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { openAi } from '@epicenter/ai';
import { type AgentMessage, createConversation } from '@epicenter/ai/agent';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until, settle } = await import(
	'../vocab.test-support.js'
);
const { createChats, startChat } = await import('./chats.js');

type Folder = Awaited<ReturnType<typeof openVocabFolder>>;

/** A conversation of chat `chat` that asks no model: a sent message is only saved. */
function conversationOf(folder: Folder, chat: string) {
	return createConversation({
		messages: folder.messages,
		chat,
		ai: openAi([]),
		model: () => null,
	});
}

test('a sent message is one note in its chat, named by its own id', async () => {
	using folder = await openVocabFolder();
	const conversation = conversationOf(folder, 'chat-a');
	expectOk(await conversation.send('你好 🌿'));
	await settle(conversation, folder.lists);
	const [path] = folder.files.paths('messages');
	expect(path).toStartWith('messages/chat-a/');
	const text = folder.files.read(path!);
	expect(text).toContain('role: user');
	expect(text).toContain('- text: "你好 🌿"');
	const [saved] = conversation.snapshot().messages;
	expect(path).toBe(`messages/chat-a/${saved?.id}.md`);
	conversation[Symbol.dispose]();
});

test('multiline Markdown and tool parts read back whole', async () => {
	using folder = await openVocabFolder();
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
				input: { term: 'lucid', nested: { depth: [1, 2] } },
			},
			{
				type: 'tool-result',
				toolCallId: 'call-1',
				toolName: 'lookup',
				content: 'clear',
				details: { source: 'dictionary' },
				isError: false,
			},
		],
	};
	const { id, ...fields } = value;
	await folder.other().messages.set({ chat: 'chat-a', id }, fields);
	const conversation = conversationOf(folder, 'chat-a');
	await conversation.ready;
	expect(conversation.snapshot().unreadable).toEqual([]);
	expect(conversation.snapshot().messages).toEqual([value]);
	conversation[Symbol.dispose]();
});

test('each chat reads only its own messages', async () => {
	using folder = await openVocabFolder();
	const first = conversationOf(folder, 'chat-a');
	const second = conversationOf(folder, 'chat-b');
	expectOk(await first.send('first chat'));
	expectOk(await second.send('second chat'));
	await until(
		() =>
			first.snapshot().messages.length === 1 &&
			second.snapshot().messages.length === 1,
	);
	await Bun.sleep(20);
	expect(first.snapshot().messages.map(({ parts }) => parts)).toEqual([
		[{ type: 'text', text: 'first chat' }],
	]);
	expect(second.snapshot().messages.map(({ parts }) => parts)).toEqual([
		[{ type: 'text', text: 'second chat' }],
	]);
	first[Symbol.dispose]();
	second[Symbol.dispose]();
});

test('a message sent while the store is out of reach shows, and lands once it is back', async () => {
	using folder = await openVocabFolder();
	const back = folder.files.refuse('offline', { under: 'messages' });
	const conversation = conversationOf(folder, 'chat-a');
	expectOk(await conversation.send('x'));
	expect(conversation.snapshot().messages).toHaveLength(1);
	await Bun.sleep(20);
	expect(folder.lists.saving()).toBe(true);
	expect(folder.files.paths('messages')).toEqual([]);
	back();
	await settle(conversation, folder.lists);
	expect(folder.files.paths('messages')).toEqual([
		`messages/chat-a/${conversation.snapshot().messages[0]?.id}.md`,
	]);
	conversation[Symbol.dispose]();
});

test('chats list newest first, and a refused focus writes no chat', async () => {
	using folder = await openVocabFolder();
	const chats = createChats(folder.lists.chats);
	expect(expectErr(await startChat(folder.lists.chats, [])).name).toBe(
		'InvalidFocus',
	);
	expect(
		expectErr(
			await chats.start(
				Array.from({ length: 4 }, (_, index) => ({
					entryId: String(index),
					text: 'word',
				})),
			),
		).name,
	).toBe('InvalidFocus');
	expect(folder.files.paths('chats')).toEqual([]);

	const older = expectOk(await chats.start([{ entryId: 'a', text: 'lucid' }]));
	await Bun.sleep(2);
	const newer = expectOk(await chats.start([{ entryId: 'b', text: 'opaque' }]));
	expect(folder.files.read(`chats/${older.id}.md`)).toBe(
		`---\ncreatedAt: "${older.createdAt}"\nfocus:\n  - entryId: a\n    text: lucid\n---\n`,
	);
	expect(chats.listing.chats.map(({ id, title }) => ({ id, title }))).toEqual([
		{ id: newer.id, title: 'opaque' },
		{ id: older.id, title: 'lucid' },
	]);
});

test('notes that do not read are reported with their path, never hiding valid ones', async () => {
	const brokenChat =
		'---\ncreatedAt: "2026-01-01T00:00:00.000Z"\nfocus: []\n---\n';
	using folder = await openVocabFolder({
		'chats/broken.md': brokenChat,
		'messages/chat-a/wrong-shape.md': '---\nrole: user\n---\n',
		'messages/chat-b/other.md': 'not a note\n',
	});
	const conversation = conversationOf(folder, 'chat-a');
	expectOk(await conversation.send('saved'));
	await settle(conversation, folder.lists);
	expect(conversation.snapshot().messages).toHaveLength(1);
	const { unreadable } = conversation.snapshot();
	expect(unreadable).toHaveLength(1);
	expect(unreadable[0]?.path).toBe('messages/chat-a/wrong-shape.md');
	expect(unreadable[0]?.reason.length).toBeGreaterThan(0);
	conversation[Symbol.dispose]();

	const listing = createChats(folder.lists.chats).listing;
	expect(listing.chats).toEqual([]);
	expect(listing.unreadable.map(({ path }) => path)).toEqual([
		'chats/broken.md',
	]);
	expect(folder.files.read('chats/broken.md')).toBe(brokenChat);
});

test('a message another program saves is heard', async () => {
	using folder = await openVocabFolder();
	const conversation = conversationOf(folder, 'chat-a');
	await conversation.ready;
	let changes = 0;
	const stop = conversation.subscribe(() => changes++);
	await folder.other().messages.set(
		{ chat: 'chat-a', id: 'one' },
		{ role: 'user', createdAt: 1, parts: [{ type: 'text', text: 'outside' }] },
	);
	await until(() => conversation.snapshot().messages.length === 1);
	stop();
	expect(changes).toBeGreaterThan(0);
	expect(conversation.snapshot().messages[0]?.id).toBe('one');
	conversation[Symbol.dispose]();
});
