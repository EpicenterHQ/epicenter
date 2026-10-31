/**
 * A chat's messages and the chat list, over Vocab's one lists of
 * `messages/{chat}/{id}.md` and `chats/{id}.md` notes.
 *
 * Key behaviors:
 * - A message is one note named by its own id: saving it again changes
 *   nothing, and another message at that id is refused
 * - Text and tool parts read back whole; each chat reads only its own
 * - Chats list newest first; a refused focus writes nothing
 * - Notes that do not read are reported, never hidden among valid ones
 * - Another program's new message is heard
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { expectErr, expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until } = await import('../vocab.test-support.js');
const { createChatMessageStore } = await import('./messages.svelte.js');
const { createChats, startChat } = await import('./chats.js');
const { flushSync } = await import('svelte');

const message = (id: string, text: string, createdAt = 1): AgentMessage => ({
	id,
	role: 'user',
	createdAt,
	parts: [{ type: 'text', text }],
});

test('a message is one note, and saving it again changes nothing', async () => {
	await using folder = await openVocabFolder();
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	const value = message('one', '你好 🌿');
	expectOk(await store.set(value.id, value));
	expect(await folder.text('messages/chat-a/one.md')).toBe(
		'---\nrole: user\ncreatedAt: 1\nparts:\n  - text: "你好 🌿"\n    type: text\n---\n',
	);
	expect([...store.entries()]).toEqual([{ key: 'one', val: value }]);
	expectOk(await store.set(value.id, value));
	expect([...store.entries()]).toHaveLength(1);
});

test('multiline Markdown and tool parts read back whole', async () => {
	await using folder = await openVocabFolder();
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
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	expectOk(await store.set(value.id, value));
	expect(folder.lists.messages.invalid).toEqual([]);
	expect([...store.entries()][0]?.val).toEqual(value);
});

test('another message at a saved id is refused', async () => {
	await using folder = await openVocabFolder();
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	expectOk(await store.set('one', message('one', 'first')));
	expect(expectErr(await store.set('one', message('one', 'other'))).name).toBe(
		'WriteFailed',
	);
});

test('each chat reads only its own messages, and a later store finds an earlier save', async () => {
	await using folder = await openVocabFolder();
	const first = createChatMessageStore(folder.lists.messages, 'chat-a');
	const second = createChatMessageStore(folder.lists.messages, 'chat-b');
	expectOk(await first.set('one', message('one', 'first chat')));
	expectOk(await second.set('two', message('two', 'second chat')));
	expect([...first.entries()].map(({ key }) => key)).toEqual(['one']);
	expect([...second.entries()].map(({ key }) => key)).toEqual(['two']);
	expectOk(
		await createChatMessageStore(folder.lists.messages, 'chat-a').set(
			'one',
			message('one', 'first chat'),
		),
	);
});

test('a refused save answers WriteFailed', async () => {
	await using folder = await openVocabFolder();
	folder.control.refuse = (collection) => collection === 'messages';
	expect(
		expectErr(
			await createChatMessageStore(folder.lists.messages, 'chat-a').set(
				'one',
				message('one', 'x'),
			),
		).name,
	).toBe('WriteFailed');
});

test('chats list newest first, and a refused focus writes no chat', async () => {
	await using folder = await openVocabFolder();
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
	expect(await folder.files('chats')).toEqual([]);

	const older = expectOk(await chats.start([{ entryId: 'a', text: 'lucid' }]));
	await Bun.sleep(2);
	const newer = expectOk(await chats.start([{ entryId: 'b', text: 'opaque' }]));
	expect(await folder.text(`chats/${older.id}.md`)).toBe(
		`---\ncreatedAt: "${older.createdAt}"\nfocus:\n  - entryId: a\n    text: lucid\n---\n`,
	);
	expectOk(
		await createChatMessageStore(folder.lists.messages, older.id).set(
			'one',
			message('one', 'hello'),
		),
	);
	expect(chats.listing.chats.map(({ id, title }) => ({ id, title }))).toEqual([
		{ id: newer.id, title: 'opaque' },
		{ id: older.id, title: 'lucid' },
	]);
});

test('notes that do not read are reported with their path, never hiding valid ones', async () => {
	const brokenChat =
		'---\ncreatedAt: "2026-01-01T00:00:00.000Z"\nfocus: []\n---\n';
	await using folder = await openVocabFolder({
		'chats/broken.md': brokenChat,
		'messages/chat-a/wrong-shape.md': '---\nrole: user\n---\n',
		'messages/chat-b/other.md': 'not a note\n',
	});
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	expectOk(await store.set('one', message('one', 'saved')));
	await until(() => folder.lists.messages.invalid.length === 2);
	expect([...store.entries()].map(({ key }) => key)).toEqual(['one']);
	expect(store.unreadable).toHaveLength(1);
	expect(store.unreadable[0]?.path).toBe('messages/chat-a/wrong-shape.md');
	expect(store.unreadable[0]?.reason.length).toBeGreaterThan(0);

	const listing = createChats(folder.lists.chats).listing;
	expect(listing.chats).toEqual([]);
	expect(listing.unreadable.map(({ path }) => path)).toEqual([
		'chats/broken.md',
	]);
	expect(await folder.text('chats/broken.md')).toBe(brokenChat);
});

test('observe hears a message another program saves', async () => {
	await using folder = await openVocabFolder();
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	let changes = 0;
	const stop = store.observe(() => changes++);
	flushSync();
	expect(changes).toBe(0);
	expectOk(
		await folder.other().messages.create({
			chat: 'chat-a',
			id: 'one',
			role: 'user',
			createdAt: 1,
			parts: [{ type: 'text', text: 'outside' }],
		}),
	);
	await until(() => changes > 0);
	stop();
	expect([...store.entries()][0]?.key).toBe('one');
});
