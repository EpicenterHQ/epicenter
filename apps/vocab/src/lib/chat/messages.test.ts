/**
 * Saved chat tests.
 * The real message store, chat list, and tutor loop run over Vocab's real
 * local folder on an in-memory IndexedDB. A message counts as saved once its
 * file exists, so "saved" is read back from the files and from the folder
 * opened again.
 *
 * Key behaviors:
 * - A message write resolves only after its file exists, and chats stay
 *   apart across reopening
 * - Saving a message again adds no second file, and a different message at
 *   its name is refused, not overwritten
 * - A new chat is its focus file: listed before any answer, and refused
 *   without one to three expressions
 * - A message file is named by its chat, and a chat reads only its own
 *   files; the chat list reads none
 * - A message file that cannot be read is reported, never dropped silently
 * - A refused or closed folder fails the write and the tutor is not asked
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	type AgentEngine,
	type AgentMessage,
	createConversation,
} from '@epicenter/agent';
import { QueryObserver } from '@tanstack/query-core';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { RowOf, VocabFolder } from '../data.js';
import {
	createBrowser,
	fileText,
	gated,
	gatedMessages,
	put,
	settle,
	tableFiles,
} from '../folder.test-support.js';
import type { VocabContext } from '../vocab.svelte.js';
import { type ChatListing, createChats, listingOf } from './chats.js';
import { createChatMessageStore, startChat } from './messages.js';

const { createFolderContext } = await import(
	'@epicenter/svelte/folder'
);
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
async function transcript(
	folder: Pick<VocabFolder, 'tables' | 'files'>,
	chatId: string,
) {
	const store = createChatMessageStore(folder, chatId);
	expectOk(await store.load());
	return [...store.entries()]
		.map(({ val }) => val)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** The one context each folder handle takes, as one page holds one. */
const contexts = new WeakMap<VocabFolder, VocabContext>();

/** The chat list over `folder`, with `tables` in place of its own, in the folder's one context. */
function chatsOver(
	folder: VocabFolder,
	tables: Partial<VocabFolder['tables']> = {},
) {
	const context = contexts.get(folder) ?? createFolderContext(folder);
	contexts.set(folder, context);
	const chats = createChats({
		...context,
		folder: { ...folder, tables: { ...folder.tables, ...tables } },
	});
	const rows = context.queries.rows('chats');
	// The history screen observes the list, so a change reads it again.
	new QueryObserver(context.queryClient, chats.chatsQuery()).subscribe(
		() => {},
	);
	return {
		chats,
		/** Read the list from the folder now, as opening the page does. */
		list: async (): Promise<ChatListing> =>
			listingOf(
				await context.queryClient.fetchQuery({ ...rows, staleTime: 0 }),
			),
		/** The list the cache holds now. */
		cachedList: () => {
			const cached = context.queryClient.getQueryData<RowOf<'chats'>[]>(
				rows.queryKey,
			);
			return cached === undefined ? undefined : listingOf(cached);
		},
	};
}

/** Every chat as the folder's files list them. */
async function listed(folder: VocabFolder) {
	return (await chatsOver(folder).list()).chats;
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
	const text = `one\u0085two three four ${c1} tab\tend ﻿`;
	const tricky: AgentMessage = {
		id: 'tricky',
		role: 'assistant',
		createdAt: 5,
		parts: [
			{ type: 'text', text },
			{ type: 'text', text: ' ' },
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

test('a chat the folder refuses is not listed, and a closed folder reports that it cannot start or list', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, table } = gated<'chats'>(folder.tables.chats);
	const { chats, list, cachedList } = chatsOver(folder, { chats: table });
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

test('chats are ordered newest first by when they started, and a message does not move one', async () => {
	await using context = await setup();
	const { folder } = context;
	const older = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	);
	await Bun.sleep(2);
	const newer = expectOk(
		await startChat(folder.tables.chats, [
			{ entryId: 'entry', text: 'opaque' },
		]),
	);
	expectOk(
		await createChatMessageStore(folder, older.id).set(question.id, question),
	);
	expect(
		(await listed(folder)).map(({ id, title }) => ({ id, title })),
	).toEqual([
		{ id: newer.id, title: 'opaque' },
		{ id: older.id, title: 'lucid' },
	]);
});

test('a chat file that does not read as a chat is listed with why, and left as it is', async () => {
	await using context = await setup();
	const { folder } = context;
	const broken = '---\ncreatedAt: 2026-01-01T00:00:00.000Z\nfocus: []\n---\n';
	await put(folder, 'chats/broken.md', broken);
	expect((await chatsOver(folder).list()).unreadable).toMatchObject([
		{ path: 'chats/broken.md', id: 'broken' },
	]);
	expect(await listed(folder)).toEqual([]);
	expect(await fileText(folder, 'chats/broken.md')).toBe(broken);
});

test('a message file that cannot be read is reported and left as it is, and two files with one message id show one message', async () => {
	await using context = await setup();
	const { folder } = context;
	const store = createChatMessageStore(folder, 'chat-a');
	expectOk(await store.set(question.id, question));
	// A second file holding the same message, as an import or another program can leave.
	expectOk(
		await folder.tables.messages.set('chat-a.zz-copy', null, {
			fields: { chat: 'chat-a', message: question },
			body: '',
		}),
	);
	const wrongShape = '---\nchat: chat-a\nmessage:\n  id: broken\n---\n';
	const unparsed = 'not a row\n';
	await put(folder, 'messages/chat-a.wrong-shape.md', wrongShape);
	// A file named for no chat is read by none.
	await put(folder, 'messages/unparsed.md', unparsed);

	expectOk(await store.load());
	expect([...store.entries()]).toEqual([{ key: question.id, val: question }]);
	// The file named for this chat is this chat's to report.
	expect(store.unreadable.map((file) => file.path)).toEqual([
		'messages/chat-a.wrong-shape.md',
	]);

	// The chat list reads no message file.
	expect((await chatsOver(folder).list()).unreadable).toEqual([]);
	expect(await fileText(folder, 'messages/chat-a.wrong-shape.md')).toBe(
		wrongShape,
	);
	expect(await fileText(folder, 'messages/unparsed.md')).toBe(unparsed);
});

test('a chat reads its own files, never another chat’s', async () => {
	await using context = await setup();
	const { folder } = context;
	expectOk(
		await createChatMessageStore(folder, 'chat-a').set(question.id, question),
	);
	expectOk(
		await createChatMessageStore(folder, 'chat-b').set(
			nextQuestion.id,
			nextQuestion,
		),
	);
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
		files: folder.files,
		tables: {
			...folder.tables,
			messages: {
				...folder.tables.messages,
				get(id: string) {
					reads.push(id);
					return folder.tables.messages.get(id);
				},
			},
		},
	};
	expect(await transcript(counted, 'chat-a')).toEqual([question, answer]);
	expect(reads.sort()).toEqual(['chat-a.answer', 'chat-a.question']);
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

test('one chat’s message writes run one at a time, and close lets the started one land', async () => {
	await using context = await setup();
	const { folder } = context;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const local = createFolderContext(gatedFolder);
	const vocab = createVocab(local);
	const store = createChatMessageStore(
		gatedFolder,
		'chat-a',
		vocab.chats.messageWriter('chat-a'),
	);
	const writing = Promise.withResolvers<void>();
	gate.heldSet = writing.promise;
	const first = store.set(question.id, question);
	const second = store.set(answer.id, answer);
	await Bun.sleep(5);
	// The answer waits its turn behind the question.
	expect(gate.sets).toBe(0);
	expect(
		vocab.folder.getStatus().saving ||
			vocab.folder.getStatus().unsaved.length > 0,
	).toBe(false);
	writing.resolve();
	expectOk(await first);
	expectOk(await second);
	expect(gate.sets).toBe(2);
	expect(
		vocab.folder.getStatus().saving ||
			vocab.folder.getStatus().unsaved.length > 0,
	).toBe(false);

	// Close drains both an active save and the next message already waiting its turn.
	const landing = Promise.withResolvers<void>();
	gate.heldSet = landing.promise;
	const started = store.set(nextQuestion.id, nextQuestion);
	const queued = store.set('next-answer', { ...answer, id: 'next-answer' });
	await Bun.sleep(5);
	let closed = false;
	const closing = local.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	gate.heldSet = undefined;
	landing.resolve();
	expectOk(await started);
	expectOk(await queued);
	await closing;
	expect(await tableFiles(await context.browser.open(), 'messages')).toEqual([
		'messages/chat-a.answer.md',
		'messages/chat-a.next-answer.md',
		'messages/chat-a.next-question.md',
		'messages/chat-a.question.md',
	]);
	// Nothing is written once closing began.
	expect(
		expectErr(await store.set('late', { ...question, id: 'late' })).name,
	).toBe('WriteFailed');
});

test('a new chat admitted before close finishes saving its focus', async () => {
	await using context = await setup();
	const local = createFolderContext(context.folder);
	const vocab = createVocab(local);
	const starting = vocab.chats.start([{ entryId: 'entry', text: 'lucid' }]);
	const closing = local.close();
	const chat = expectOk(await starting);
	await closing;
	const reopened = await context.browser.open();
	expect(
		expectOk(await reopened.tables.chats.get(chat.id))?.fields,
	).toMatchObject({
		focus: [{ entryId: 'entry', text: 'lucid' }],
	});
});
