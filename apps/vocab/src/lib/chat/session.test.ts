import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { custom, openAi } from '@epicenter/ai';
import type { AgentMessage } from '@epicenter/ai/agent';
import { openFolder } from '@epicenter/folder';
import { OpenFolderError } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until } = await import('../vocab.test-support.js');
const { createVocabChat } = await import('./session.svelte.js');
const { reactive } = await import('@epicenter/svelte/reactive');
const { startChat } = await import('./chats.js');
const { vocab } = await import('../contract.js');

/** A folder at a place that never opens, offline. */
function offlineFolder() {
	const place = memory();
	memoryFiles(place).refuseOpen(
		OpenFolderError.StorageUnavailable({ cause: 'offline' }).error,
	);
	return openFolder(vocab, place);
}

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

async function setup({ question = false, offline = false } = {}) {
	const folder = await openVocabFolder();
	const chatId = expectOk(
		await startChat(folder.lists.chats, [{ entryId: 'entry', text: 'lucid' }]),
	).id;
	for (const message of question ? [welcome, asked] : [welcome])
		expectOk(
			await folder.messages.create({ chat: chatId, ...message, body: '' }),
		);
	let requests = 0;
	const tutor = {
		finishReason: 'stop',
		status: 200,
		held: undefined as Promise<void> | undefined,
		answers: [] as Promise<void>[],
	};
	const tutorEndpoint = custom({
		id: 'tutor',
		baseUrl: 'https://tutor.test/v1',
		models: ['test-model'],
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
	const ai = reactive(openAi([tutorEndpoint]));
	const choices = sessionDouble<ChatOptions['choices']>({
		get: () => ({ endpoint: 'tutor', model: 'test-model' }),
		set: async () => {},
		subscribe: () => () => {},
	});
	const chat = createVocabChat({
		// Offline, a folder that does not open: its messages are never listed.
		messages: offline ? offlineFolder().messages : folder.messages,
		chatId,
		focus: [{ text: 'lucid' }],
		ai,
		choices,
	});
	return {
		chat,
		folder,
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
	const { chat, folder } = await setup();
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
	folder[Symbol.dispose]();
});

test('typing while a message saves keeps the newer draft', async () => {
	const { chat, folder } = await setup();
	const release = folder.files.hold();
	chat.inputValue = 'First message';
	const sending = chat.sendMessage();
	chat.inputValue = 'Next draft';
	release();
	await sending;
	expect(chat.inputValue).toBe('Next draft');
	await settle(chat);
	chat[Symbol.dispose]();
	folder[Symbol.dispose]();
});

test('a refused learner message stays available and asks no tutor until saved', async () => {
	const context = await setup();
	const undo = context.folder.files.refuse('refused by the test', {
		under: 'messages',
	});
	context.chat.inputValue = 'Is this lucid?';
	await context.chat.sendMessage();
	expect(context.requests).toBe(0);
	expect(context.chat.inputValue).toBe('Is this lucid?');
	expect(context.chat.unsaved).toHaveLength(1);
	undo();
	await context.chat.saveAgain();
	expect(context.chat.inputValue).toBe('');
	expect(context.chat.unsaved).toHaveLength(0);
	expect(context.requests).toBe(0);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('a refused tutor answer is retried without another tutor request', async () => {
	const context = await setup();
	// The learner's message saves; once the tutor is asked, its answer's save is refused.
	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	context.chat.inputValue = 'Is this lucid?';
	const sending = context.chat.sendMessage();
	await until(() => context.requests === 1);
	const undo = context.folder.files.refuse('refused by the test', {
		under: 'messages',
	});
	answering.resolve();
	await sending;
	await settle(context.chat);
	expect(context.requests).toBe(1);
	expect(context.chat.unsaved.map((message) => message.role)).toEqual([
		'assistant',
	]);
	undo();
	await context.chat.saveAgain();
	expect(context.chat.unsaved).toHaveLength(0);
	expect(context.requests).toBe(1);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
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
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
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
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('a stopped answer is never saved after the rest arrives', async () => {
	const context = await setup({ question: true });
	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	await context.chat.retry();
	await until(() => context.chat.streaming !== null);
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
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('stopping while the learner message saves prevents the tutor start', async () => {
	const context = await setup();
	const release = context.folder.files.hold();
	context.chat.inputValue = 'It was a lucid talk.';
	const sending = context.chat.sendMessage();
	await until(() => context.chat.isSaving);
	context.chat.stop();
	release();
	await sending;
	await settle(context.chat);
	expect(context.requests).toBe(0);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(context.chat.unsaved).toEqual([]);
	expect(context.chat.canAsk).toBe(true);
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
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
	context.folder[Symbol.dispose]();
});

test('an empty chat whose messages were never listed asks for no opening', async () => {
	const context = await setup({ offline: true });
	await context.chat.retry();
	await settle(context.chat);
	expect(context.requests).toBe(0);
	expect(context.chat.messages).toEqual([]);
	expect(context.chat.error).toBeNull();
	expect(context.chat.canAsk).toBe(false);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});
