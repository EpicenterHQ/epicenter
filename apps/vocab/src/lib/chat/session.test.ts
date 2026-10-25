import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import OpenAI from 'openai';
import { expectOk } from 'wellcrafted/testing';
import { createMemory } from '../folder.test-support.js';

const { createVocabChat } = await import('./session.svelte.js');
const { createChatMessageStore } = await import('./messages.svelte.js');

import { startChat } from './chats.js';

type ChatOptions = Parameters<typeof createVocabChat>[0];
function sessionDouble<T extends object>(members: Partial<T>): T {
	// SAFETY: these tests exercise only the supplied members of the session dependency.
	return members as T;
}
const welcome: AgentMessage = {
	id: 'welcome',
	role: 'assistant',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Welcome.' }],
};

async function setup() {
	const { folder, core, host } = await createMemory();
	const chatId = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	).id;
	expectOk(
		await createChatMessageStore(folder, chatId).set(welcome.id, welcome),
	);
	let requests = 0;
	const client = new OpenAI({
		apiKey: 'test',
		baseURL: 'https://tutor.test/v1',
		maxRetries: 0,
		fetch: async () => {
			requests++;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						const event = {
							choices: [
								{
									index: 0,
									delta: { content: 'Nice.' },
									finish_reason: 'stop',
								},
							],
						};
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
							),
						);
						controller.close();
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		},
	});
	const catalogMock = sessionDouble<ChatOptions['catalog']>({
		accountId: 'account',
		ready: Promise.resolve(),
		resolve: () => ({ source: 'account', client, model: 'test-model' }),
	});
	const selectionsMock = sessionDouble<ChatOptions['selections']>({
		get: () => null,
		set: () => {},
		onChange: () => () => {},
	});
	const chat = createVocabChat({
		folder,
		chatId,
		focus: [{ text: 'lucid' }],
		catalog: catalogMock,
		selections: selectionsMock,
	});
	return {
		chat,
		core,
		host,
		chatId,
		get requests() {
			return requests;
		},
	};
}

async function settle(chat: ReturnType<typeof createVocabChat>) {
	while (chat.isGenerating || chat.isSaving)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

test('a submitted draft stays until its message is saved, then clears', async () => {
	const { chat, core, requests } = await setup();
	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	expect(chat.inputValue).toBe('It was a lucid talk.');
	await sending;
	expect(chat.inputValue).toBe('');
	await settle(chat);
	expect(chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
		'assistant',
	]);
	chat[Symbol.dispose]();
	await core.close();
});

test('typing while a message saves keeps the newer draft', async () => {
	const { chat, core, host } = await setup();
	const gate = Promise.withResolvers<void>();
	host.control.putGate = gate.promise;
	chat.inputValue = 'First message';
	const sending = chat.sendMessage();
	chat.inputValue = 'Next draft';
	gate.resolve();
	await sending;
	expect(chat.inputValue).toBe('Next draft');
	await settle(chat);
	chat[Symbol.dispose]();
	await core.close();
});

test('a refused learner message stays available and asks no tutor until saved', async () => {
	const context = await setup();
	context.host.control.beforePut = (path) => {
		if (path.startsWith('messages/'))
			context.host.control.failPut.set(path, {
				name: 'StorageFailed',
				message: 'storage refused',
				cause: 'full',
			});
	};
	context.chat.inputValue = 'Is this lucid?';
	await context.chat.sendMessage();
	expect(context.requests).toBe(0);
	expect(context.chat.inputValue).toBe('Is this lucid?');
	expect(context.chat.unsaved).toHaveLength(1);
	context.host.control.beforePut = undefined;
	context.host.control.failPut.clear();
	await context.chat.saveAgain();
	expect(context.chat.inputValue).toBe('');
	expect(context.chat.unsaved).toHaveLength(0);
	expect(context.requests).toBe(0);
	context.chat[Symbol.dispose]();
	await context.core.close();
});

test('a refused tutor answer is retried without another tutor request', async () => {
	const context = await setup();
	let messagePuts = 0;
	context.host.control.beforePut = (path) => {
		if (!path.startsWith('messages/')) return;
		messagePuts++;
		if (messagePuts === 2)
			context.host.control.failPut.set(path, {
				name: 'StorageFailed',
				message: 'storage refused',
				cause: 'full',
			});
	};
	context.chat.inputValue = 'Is this lucid?';
	await context.chat.sendMessage();
	await settle(context.chat);
	expect(context.requests).toBe(1);
	expect(context.chat.unsaved.map((message) => message.role)).toEqual([
		'assistant',
	]);
	context.host.control.beforePut = undefined;
	context.host.control.failPut.clear();
	await context.chat.saveAgain();
	expect(context.chat.unsaved).toHaveLength(0);
	expect(context.requests).toBe(1);
	context.chat[Symbol.dispose]();
	await context.core.close();
});
