/**
 * Saved chat tests.
 * The real message store, chat list, and tutor loop run over Vocab's real
 * browser folder on an in-memory OPFS stand-in. A message counts as saved once its file
 * exists, so "saved" is read back from the files and from the folder opened
 * again.
 *
 * Key behaviors:
 * - A message write resolves only after its file exists, and chats stay
 *   apart across reopening
 * - Saving a message again adds no second file, and a different message at
 *   its name is refused, not overwritten
 * - A new chat is its focus file: listed before any answer, and refused
 *   without one to three expressions
 * - A message file is named by its chat, and a chat reads only its own
 *   files and the ones an earlier version saved
 * - Earlier, message-only chats are listed by their first learner question
 * - A message file that cannot be read is reported, never dropped silently
 * - A refused or closed folder fails the write and the tutor is not asked
 */
import '../svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	type AgentEngine,
	type AgentMessage,
	createConversation,
} from '@epicenter/agent';
import { folderOptions } from '@epicenter/folder/query';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from '../data.js';
import {
	createBrowser,
	fileText,
	gated,
	gatedMessages,
	settle,
	tableFiles,
} from '../folder.test-support.js';
import { setVocabDefaults, vocabKeys, type WriteFailure } from '../query.js';
import { createQueryClient } from '../query.test-support.js';
import { type ChatListing, createChats } from './chats.js';
import { createChatMessageStore, startChat } from './messages.js';

const { createVocab } = await import('../vocab.svelte.ts');

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
	parts: [{ type: 'text', text: 'Clear and easy to understand: 清楚。' }],
};
const nextQuestion: AgentMessage = {
	id: 'next-question',
	role: 'user',
	createdAt: 3,
	parts: [{ type: 'text', text: 'How do I use "subtle"?' }],
};

async function setup() {
	const browser = createBrowser();
	return {
		browser,
		folder: await browser.open(),
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

/** One chat's messages as a store opened over this folder reads them. */
async function transcript(folder: VocabFolder, chatId: string) {
	const store = createChatMessageStore(folder, chatId);
	expectOk(await store.load());
	return [...store.entries()]
		.map(({ val }) => val)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** The chat list over `folder`, or over `over` in its place, in a cache of its own. */
function chatsOver(
	folder: VocabFolder,
	over: Partial<Pick<VocabFolder, 'tables' | 'files'>> = {},
) {
	const queryClient = createQueryClient();
	const folder$ = folderOptions(folder);
	setVocabDefaults(queryClient);
	const failures: WriteFailure[] = [];
	const chats = createChats({ ...folder, ...over }, folder$, queryClient, {
		refused: () => undefined,
		onWriteFailed: (failure) => failures.push(failure),
	});
	return {
		chats,
		failures,
		/** Read the list from the folder now, as opening the page does. */
		list: () => queryClient.fetchQuery({ ...chats.chatsQuery(), staleTime: 0 }),
		/** The list the cache holds now. */
		cachedList: () =>
			queryClient.getQueryData<ChatListing>(chats.chatsQuery().queryKey),
	};
}

/** Every chat as the folder's files list them. */
async function listed(folder: VocabFolder) {
	return (await chatsOver(folder).list()).chats;
}

/** Save a message file as an earlier version did: named by its message ID alone. */
async function saveEarlier(
	folder: VocabFolder,
	chat: string,
	message: AgentMessage,
) {
	expectOk(
		await folder.tables.messages.create(
			{ fields: { chat, message }, body: '' },
			{ stem: message.id },
		),
	);
}

test('a message write resolves only after its file exists, and chats stay apart across reopening', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const first = createChatMessageStore(folder, 'chat-a');
	const second = createChatMessageStore(folder, 'chat-b');

	const writing = first.set(question.id, question);
	// Not in the transcript on the request alone.
	expect([...first.entries()]).toEqual([]);
	expectOk(await writing);
	expect([...first.entries()]).toEqual([{ key: question.id, val: question }]);
	// Named by its chat, so a chat reads only its own files.
	expect(await tableFiles(folder, 'messages')).toEqual([
		'messages/chat-a.question.md',
	]);

	expectOk(await first.set(answer.id, answer));
	expectOk(await second.set(nextQuestion.id, nextQuestion));

	const reopened = await browser.open();
	expect(await transcript(reopened, 'chat-a')).toEqual([question, answer]);
	expect(await transcript(reopened, 'chat-b')).toEqual([nextQuestion]);
	expect(await transcript(reopened, 'chat-c')).toEqual([]);
});

test('Unicode message text survives reopening and retry; changed content cannot take its file', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	// Characters YAML treats as line breaks or must escape, and JSON leaves raw.
	const c1 = Array.from({ length: 32 }, (_, index) =>
		String.fromCharCode(0x80 + index),
	).join('');
	const text = `one\u0085two three four ${c1} tab\tend ﻿`;
	const tricky: AgentMessage = {
		id: 'tricky',
		role: 'assistant',
		createdAt: 5,
		parts: [
			{ type: 'text', text },
			{ type: 'text', text: ' ' },
		],
	};
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set(tricky.id, tricky));

	const [read] = await transcript(await browser.open(), 'chat-a');
	expect(read).toEqual(tricky);
	// The retry of an unconfirmed save compares against the file: it must
	// find its own message, not report a different one.
	const path = 'messages/chat-a.tricky.md';
	const saved = await fileText(folder, path);
	const again = createChatMessageStore(folder, 'chat-a');
	expectOk(await again.set(tricky.id, tricky));
	expect(await tableFiles(folder, 'messages')).toEqual([path]);
	expect(await fileText(folder, path)).toBe(saved);
	const other = {
		...tricky,
		parts: [{ type: 'text' as const, text: 'Other' }],
	};
	expect(expectErr(await again.set(tricky.id, other))).toMatchObject({
		name: 'WriteFailed',
		cause: { name: 'Taken' },
	});
	expect(await fileText(folder, path)).toBe(saved);
	// The same message ID in another chat is that chat's own file.
	const elsewhere = createChatMessageStore(folder, 'chat-b');
	expectOk(await elsewhere.set(tricky.id, tricky));
	expect(await fileText(folder, path)).toBe(saved);
	expect(await transcript(folder, 'chat-b')).toEqual([tricky]);
});

test('a new chat is its focus file: listed before any answer, there after reopening, and it keeps the expression text', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const { chats, list, cachedList } = chatsOver(folder);
	await list();

	const starting = chats.start([
		{ entryId: 'deleted-entry', text: '顺便 lucid' },
	]);
	expect(cachedList()?.chats).toEqual([]);
	const chat = expectOk(await starting);
	const expected = [
		{
			id: chat.id,
			title: '顺便 lucid',
			focus: [{ entryId: 'deleted-entry', text: '顺便 lucid' }],
			legacy: false,
		},
	];
	expect(cachedList()?.chats).toMatchObject(expected);
	expect(await tableFiles(folder, 'chats')).toEqual([`chats/${chat.id}.md`]);
	expect(await listed(await browser.open())).toMatchObject(expected);
});

test('focus requires one to three expressions, and a refused focus writes nothing', async () => {
	await using context = await setup();
	const { folder } = context;
	expect(expectErr(await startChat(folder.tables.chats, [])).name).toBe(
		'InvalidFocus',
	);
	expect(
		expectErr(
			await startChat(
				folder.tables.chats,
				Array.from({ length: 4 }, (_, index) => ({
					entryId: String(index),
					text: 'word',
				})),
			),
		).name,
	).toBe('InvalidFocus');
	expect(await tableFiles(folder, 'chats')).toEqual([]);
});

test('a chat the folder refuses is not listed, and a closed folder reports that it cannot list', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated(folder.tables.chats);
	const { chats, list, cachedList } = chatsOver(folder, {
		tables: { ...folder.tables, chats: table },
	});
	await list();

	gate.failing = true;
	expect(
		expectErr(await chats.start([{ entryId: 'entry', text: 'lucid' }])).name,
	).toBe('NotSaved');
	expect(cachedList()?.chats).toEqual([]);
	expect(await tableFiles(folder, 'chats')).toEqual([]);

	gate.failing = false;
	await folder.close();
	expect(
		expectErr(await chats.start([{ entryId: 'entry', text: 'lucid' }])).name,
	).toBe('NotSaved');
	expect(list()).rejects.toBeDefined();
});

test('chats are ordered newest first, and an earlier message-only chat is titled by its first question', async () => {
	await using context = await setup();
	const { folder } = context;
	const focused = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	);
	// Saved out of order: the title is still the earliest question.
	await saveEarlier(folder, 'old-chat', {
		...nextQuestion,
		id: 'later',
		createdAt: 20,
	});
	await saveEarlier(folder, 'old-chat', { ...question, id: 'earlier' });
	// A message saved now is named by its chat; the list does not read it.
	expectOk(
		await createChatMessageStore(folder, 'old-chat').set(answer.id, answer),
	);

	expect(
		(await listed(folder)).map(({ id, title, legacy, focus }) => ({
			id,
			title,
			legacy,
			focus,
		})),
	).toEqual([
		{
			id: focused.id,
			title: 'lucid',
			legacy: false,
			focus: [{ entryId: 'entry', text: 'lucid' }],
		},
		{
			id: 'old-chat',
			title: 'What does "lucid" mean?',
			legacy: true,
			focus: [],
		},
	]);
});

test('a message file that cannot be read is reported and left as it is, and two files with one message id show one message', async () => {
	await using context = await setup();
	const { folder } = context;
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set(question.id, question));
	// A second file holding the same message, as an import or another program can leave.
	expectOk(
		await folder.tables.messages.create(
			{ fields: { chat: 'chat-a', message: question }, body: '' },
			{ stem: 'chat-a.zz-copy' },
		),
	);
	const wrongShape = '---\nchat: chat-a\nmessage:\n  id: broken\n---\n';
	const unparsed = 'not a row\n';
	expectOk(
		await folder.files.create('messages/chat-a.wrong-shape.md', wrongShape),
	);
	// An earlier file, named by message ID alone, names no chat it can be read for.
	expectOk(await folder.files.create('messages/unparsed.md', unparsed));

	expectOk(await store.load());
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
	// The file named for this chat is this chat's to report.
	expect(store.unreadable.map((file) => file.path)).toEqual([
		'messages/chat-a.wrong-shape.md',
	]);

	// The chat list reports the earlier file, which belongs to no chat it can name.
	const { unreadable } = await chatsOver(folder).list();
	expect(unreadable.map((file) => file.path)).toEqual(['messages/unparsed.md']);
	expect(await fileText(folder, 'messages/chat-a.wrong-shape.md')).toBe(
		wrongShape,
	);
	expect(await fileText(folder, 'messages/unparsed.md')).toBe(unparsed);
});

test('a chat reads its own files and the earlier ones, never another chat’s', async () => {
	await using context = await setup();
	const { folder } = context;
	await saveEarlier(folder, 'chat-a', question);
	await saveEarlier(folder, 'chat-b', nextQuestion);
	expectOk(
		await createChatMessageStore(folder, 'chat-a').set(answer.id, answer),
	);
	expectOk(
		await createChatMessageStore(folder, 'chat-b').set('other', {
			...answer,
			id: 'other',
		}),
	);
	const reads: string[] = [];
	const counted = {
		...folder,
		tables: {
			...folder.tables,
			messages: {
				...folder.tables.messages,
				get(stem: string) {
					reads.push(stem);
					return folder.tables.messages.get(stem);
				},
			},
		},
	};
	expect(await transcript(counted as VocabFolder, 'chat-a')).toEqual([
		question,
		answer,
	]);
	expect(reads.sort()).toEqual(['chat-a.answer', 'next-question', 'question']);
});

test('a message saved again after its answer was lost is found by its own file, with no second one', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const store = createChatMessageStore(gatedFolder, 'chat-a');
	const withDetails: AgentMessage = {
		id: 'result',
		role: 'assistant',
		createdAt: 4,
		parts: [
			{
				type: 'tool-result',
				toolCallId: 'call',
				toolName: 'lookup',
				content: 'found',
				details: { b: 1, a: [true, null] },
				isError: false,
			},
		],
	};
	gate.losingReceipt = true;
	expect(expectErr(await store.set(withDetails.id, withDetails)).name).toBe(
		'WriteFailed',
	);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);
	expectOk(await store.set(withDetails.id, withDetails));
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);
	expect(await transcript(folder, 'chat-a')).toEqual([withDetails]);
});

test('a closed folder fails the write and the read without rejecting', async () => {
	await using context = await setup();
	const { browser, folder } = context;
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set(question.id, question));
	await folder.close();

	expect(expectErr(await store.set(answer.id, answer)).name).toBe(
		'WriteFailed',
	);
	expect(expectErr(await store.load()).name).toBe('NotRead');
	// A failed read leaves what the store had; the file is as it was.
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
	expect(await transcript(await browser.open(), 'chat-a')).toEqual([question]);
});

test('a tutor conversation over a folder that refuses writes asks nothing, then keeps one file per message once it recovers', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	let calls = 0;
	const engine: AgentEngine = async function* () {
		calls++;
		// The folder stops taking writes while the tutor is answering.
		gate.failing = true;
		yield { type: 'text-delta', delta: 'Clear.' };
	};
	const conversation = createConversation({
		store: createChatMessageStore(gatedFolder, 'chat-a'),
		engine,
		generateId: () => crypto.randomUUID(),
	});
	const roles = () =>
		conversation.snapshot().messages.map((message) => message.role);

	gate.failing = true;
	expectErr(await conversation.send('What does "lucid" mean?'));
	await settle(conversation);
	expect(calls).toBe(0);
	expect(roles()).toEqual(['user']);
	expect(await tableFiles(folder, 'messages')).toEqual([]);

	gate.failing = false;
	expectOk(await conversation.save());
	expect(calls).toBe(0);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);

	conversation.retry();
	await settle(conversation);
	expect(calls).toBe(1);
	const unsavedAnswer = conversation.snapshot().unsaved;
	expect(unsavedAnswer.map((message) => message.role)).toEqual(['assistant']);
	expect(roles()).toEqual(['user', 'assistant']);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);

	gate.failing = false;
	expectOk(await conversation.save());
	expect(calls).toBe(1);
	expect(conversation.snapshot().unsaved).toEqual([]);
	expect(roles()).toEqual(['user', 'assistant']);
	expect(await transcript(folder, 'chat-a')).toEqual(
		conversation.snapshot().messages,
	);
	expect(conversation.snapshot().messages[1]).toEqual(unsavedAnswer[0]);
	conversation[Symbol.dispose]();
});

// ============================================================================
// Listings delivered late
// ============================================================================

test('a listing delivered after a newer message was saved does not remove that message, and the tutor is asked over it', async () => {
	await using context = await setup();
	const { folder } = context;
	const seeded = createChatMessageStore(folder, 'chat-a');
	expectOk(await seeded.set(answer.id, { ...answer, createdAt: 1 }));

	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const store = createChatMessageStore(gatedFolder, 'chat-a');
	expectOk(await store.load());
	const requests: number[] = [];
	const conversation = createConversation({
		store,
		engine: async function* (request) {
			requests.push(request.messages.length);
			yield { type: 'text-delta', delta: 'Yes.' };
		},
		generateId: () => crypto.randomUUID(),
	});
	const roles = () =>
		conversation.snapshot().messages.map((message) => message.role);

	// A listing is read now, holding only the first answer, and is delivered
	// after the learner's message has been saved and answered.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const stale = store.load();
	gate.heldListing = undefined;
	await gate.listingRead.promise;

	expectOk(await conversation.send('Is "lucid" formal?'));
	await settle(conversation);
	expect(roles()).toEqual(['assistant', 'user', 'assistant']);
	expect([...store.entries()]).toHaveLength(3);

	delivery.resolve();
	expectOk(await stale);
	// The late listing knew neither new message. Both are still the transcript.
	expect(roles()).toEqual(['assistant', 'user', 'assistant']);
	expect([...store.entries()]).toHaveLength(3);
	// The tutor was asked over the saved learner message, once.
	expect(requests).toEqual([2]);
	expect(conversation.snapshot().unsaved).toEqual([]);
	expect(await transcript(folder, 'chat-a')).toEqual(
		conversation.snapshot().messages,
	);
	conversation[Symbol.dispose]();
});

test('an older listing delivered after a newer one does not replace it', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const store = createChatMessageStore(gatedFolder, 'chat-a');

	// The first load reads an empty chat and is delivered late.
	const delivery = Promise.withResolvers<void>();
	gate.heldListing = delivery.promise;
	const older = store.load();
	gate.heldListing = undefined;
	await gate.listingRead.promise;

	// Another tab saves a message, and a second load reads it.
	const otherTab = createChatMessageStore(folder, 'chat-a');
	expectOk(await otherTab.set(question.id, question));
	expectOk(await store.load());
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);

	delivery.resolve();
	expectOk(await older);
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
});

test('one chat’s message writes run one at a time through its scope, and close waits for them', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const vocab = createVocab(
		{ ...folder, ...gatedFolder } as VocabFolder,
		createQueryClient(),
	);
	const store = createChatMessageStore(
		gatedFolder,
		'chat-a',
		vocab.chats.messageWriter('chat-a'),
	);
	const writing = Promise.withResolvers<void>();
	gate.heldCreate = writing.promise;
	const first = store.set(question.id, question);
	const second = store.set(answer.id, answer);
	await Bun.sleep(5);
	// The answer waits in the chat's scope; only the question is being written.
	expect(gate.creates).toBe(0);
	expect(
		vocab.queryClient
			.getMutationCache()
			.findAll({ mutationKey: vocabKeys.message('chat-a') })
			.map((write) => write.state.isPaused),
	).toEqual([false, true]);
	expect(vocab.busy).toBe(true);
	let closed = false;
	const closing = vocab.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	writing.resolve();
	expectOk(await first);
	expectOk(await second);
	await closing;
	expect(gate.creates).toBe(2);
	// The folder closed after both landed; a reload reads them.
	expect(await tableFiles(await context.browser.open(), 'messages')).toEqual([
		'messages/chat-a.answer.md',
		'messages/chat-a.question.md',
	]);
	// Nothing is written once closing began.
	expect(expectErr(await store.set(nextQuestion.id, nextQuestion)).name).toBe(
		'WriteFailed',
	);
});

test('a message write the folder refuses is reported with its text', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const { chats, failures } = chatsOver(folder, gatedFolder);
	const store = createChatMessageStore(
		gatedFolder,
		'chat-a',
		chats.messageWriter('chat-a'),
	);
	gate.failing = true;
	expectErr(await store.set(answer.id, answer));
	expect(failures).toMatchObject([
		{
			path: 'messages/chat-a.answer.md',
			lost: 'Clear and easy to understand: 清楚。',
		},
	]);
});
