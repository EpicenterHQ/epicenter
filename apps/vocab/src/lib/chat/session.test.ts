import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import { until } from '@epicenter/folder/testing';
import OpenAI from 'openai';
import { expectOk } from 'wellcrafted/testing';
import { createMemory, tableFiles } from '../folder.test-support.js';

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

const asked: AgentMessage = {
	id: 'question',
	role: 'user',
	createdAt: 2,
	parts: [{ type: 'text', text: 'Is this right?' }],
};

async function setup({ question = false } = {}) {
	const { folder, core, host } = await createMemory();
	const chatId = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	).id;
	const store = createChatMessageStore(folder, chatId);
	expectOk(await store.set(welcome.id, welcome));
	if (question) expectOk(await store.set(asked.id, asked));
	let requests = 0;
	const tutor = {
		finishReason: 'stop',
		status: 200,
		held: undefined as Promise<void> | undefined,
		answers: [] as Promise<void>[],
	};
	const client = new OpenAI({
		apiKey: 'test',
		baseURL: 'https://tutor.test/v1',
		maxRetries: 0,
		fetch: async () => {
			requests++;
			if (tutor.status !== 200)
				return Response.json(
					{ error: { message: 'The tutor is unavailable.' } },
					{ status: tutor.status },
				);
			const event = (finishReason: string | null) =>
				new TextEncoder().encode(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Nice.' }, finish_reason: finishReason }] })}\n\n`,
				);
			const held = tutor.held;
			const answered = Promise.withResolvers<void>();
			tutor.answers.push(answered.promise);
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						try {
							if (held) {
								controller.enqueue(event(null));
								await held;
							}
							controller.enqueue(event(tutor.finishReason));
							controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
							controller.close();
						} catch {
							// Stopping can cancel the stream before its held answer resumes.
						} finally {
							answered.resolve();
						}
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
		folder,
		core,
		host,
		chatId,
		tutor,
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
	const { chat, core } = await setup();
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

test('an answer cut off at the output limit saves nothing', async () => {
	const context = await setup({ question: true });
	context.tutor.finishReason = 'length';
	await context.chat.retry();
	await settle(context.chat);
	expect(context.requests).toBe(1);
	expect(context.chat.error?.code).toBe('length');
	expect(context.chat.unsaved).toEqual([]);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(tableFiles(context.folder, 'messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	await context.core.close();
});

test('a failed tutor request saves nothing and can be retried', async () => {
	const context = await setup({ question: true });
	context.tutor.status = 500;
	await context.chat.retry();
	await settle(context.chat);
	expect(context.requests).toBe(1);
	expect(context.chat.error).not.toBeNull();
	expect(context.chat.unsaved).toEqual([]);
	expect(context.chat.canAsk).toBe(true);
	expect(tableFiles(context.folder, 'messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	await context.core.close();
});

test('a stopped answer is never saved after the rest arrives', async () => {
	const context = await setup({ question: true });
	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	await context.chat.retry();
	await until(() => context.chat.streaming !== null, { timeout: 4000 });
	context.chat.stop();
	answering.resolve();
	await Promise.all(context.tutor.answers);
	await settle(context.chat);
	expect(context.chat.streaming).toBeNull();
	expect(context.chat.unsaved).toEqual([]);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(tableFiles(context.folder, 'messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	await context.core.close();
});

test('stopping while the learner message saves prevents the tutor start', async () => {
	const context = await setup();
	const saving = Promise.withResolvers<void>();
	context.host.control.putGate = saving.promise;
	context.chat.inputValue = 'It was a lucid talk.';
	const sending = context.chat.sendMessage();
	await until(() => context.chat.isSaving, { timeout: 4000 });
	context.chat.stop();
	saving.resolve();
	await sending;
	await settle(context.chat);
	expect(context.requests).toBe(0);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(context.chat.unsaved).toEqual([]);
	expect(context.chat.canAsk).toBe(true);
	expect(tableFiles(context.folder, 'messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	await context.core.close();
});

test('an opening is not asked twice over a chat that already has one', async () => {
	const context = await setup();
	await context.chat.retry();
	await settle(context.chat);
	expect(context.requests).toBe(0);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	context.chat[Symbol.dispose]();
	await context.core.close();
});
