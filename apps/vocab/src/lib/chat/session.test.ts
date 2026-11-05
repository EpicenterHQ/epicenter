import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { custom, openAi } from '@epicenter/ai';
import type { AgentMessage } from '@epicenter/ai/agent';
import { expectOk } from 'wellcrafted/testing';

const { openVocabFolder, until } = await import('../vocab.test-support.js');
const { createVocabChat } = await import('./session.svelte.js');
const { reactive } = await import('@epicenter/svelte/reactive');
const { startChat } = await import('./chats.js');

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

/** The tutor's endpoint, and Epicenter's hosted one, as the chat reaches them. */
const TUTOR = { endpoint: 'tutor', model: 'test-model' };
const HOSTED = { endpoint: 'hosted', model: 'hosted-tutor' };

async function setup({
	saved = [welcome],
	unlisted = false,
	choices = sessionDouble<ChatOptions['choices']>({
		get: () => TUTOR,
		set: async () => {},
		subscribe: () => () => {},
		ready: Promise.resolve(),
	}),
}: {
	/** The chat's messages saved before it opens. */
	saved?: AgentMessage[];
	/** The chat's messages cannot be listed until `listable()` is called. */
	unlisted?: boolean;
	/** The learner's model choices; by default the tutor's, already read. */
	choices?: ChatOptions['choices'];
} = {}) {
	const folder = await openVocabFolder();
	const chatId = expectOk(
		await startChat(folder.lists.chats, [{ entryId: 'entry', text: 'lucid' }]),
	).id;
	for (const { id, ...message } of saved)
		await folder.messages.set({ chat: chatId, id }, message);
	const listable = unlisted
		? folder.files.refuseReads('offline', { under: 'messages' })
		: () => {};
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
	let hostedRequests = 0;
	const hostedEndpoint = custom({
		id: HOSTED.endpoint,
		baseUrl: 'https://hosted.test/v1',
		models: [HOSTED.model],
		fetch: async () => {
			hostedRequests++;
			return Response.json(
				{ error: { message: 'The hosted tutor was asked.' } },
				{ status: 500 },
			);
		},
	});
	const ai = reactive(openAi([tutorEndpoint, hostedEndpoint]));
	const chat = createVocabChat({
		messages: folder.messages,
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
		listable,
		get requests() {
			return requests;
		},
		get hostedRequests() {
			return hostedRequests;
		},
		/** Wait until the tutor no longer answers and the folder's writes have landed. */
		async settle() {
			while (chat.isGenerating || folder.lists.saving())
				await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

test('a submitted draft stays until the conversation takes it, then clears', async () => {
	const context = await setup();
	const { chat, folder } = context;
	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	expect(chat.inputValue).toBe('It was a lucid talk.');
	await sending;
	expect(chat.inputValue).toBe('');
	await context.settle();
	expect(chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
		'assistant',
	]);
	chat[Symbol.dispose]();
	folder[Symbol.dispose]();
});

test('typing while a message is sent keeps the newer draft', async () => {
	const context = await setup();
	const { chat, folder } = context;
	const release = folder.files.hold();
	chat.inputValue = 'First message';
	const sending = chat.sendMessage();
	chat.inputValue = 'Next draft';
	release();
	await sending;
	expect(chat.inputValue).toBe('Next draft');
	await context.settle();
	chat[Symbol.dispose]();
	folder[Symbol.dispose]();
});

test('a message sent while the store is out of reach is answered, and both land once it is back', async () => {
	const context = await setup();
	const back = context.folder.files.refuse('offline', { under: 'messages' });
	context.chat.inputValue = 'Is this lucid?';
	await context.chat.sendMessage();
	expect(context.chat.inputValue).toBe('');
	await until(() => context.requests === 1 && !context.chat.isGenerating);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
		'assistant',
	]);
	expect(context.folder.lists.saving()).toBe(true);
	expect(context.folder.files.paths('messages')).toHaveLength(1);
	back();
	await context.settle();
	expect(context.folder.files.paths('messages')).toHaveLength(3);
	expect(context.requests).toBe(1);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('an answer cut off at the output limit saves nothing', async () => {
	const context = await setup({ saved: [welcome, asked] });
	context.tutor.finishReason = 'length';
	await context.chat.retry();
	await context.settle();
	expect(context.requests).toBe(1);
	expect(context.chat.error?.code).toBe('length');
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('a failed tutor request saves nothing and can be retried', async () => {
	const context = await setup({ saved: [welcome, asked] });
	context.tutor.status = 500;
	await context.chat.retry();
	await context.settle();
	expect(context.requests).toBe(1);
	expect(context.chat.error).not.toBeNull();
	expect(context.chat.canAsk).toBe(true);
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('a stopped answer is never saved after the rest arrives', async () => {
	const context = await setup({ saved: [welcome, asked] });
	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	await context.chat.retry();
	await until(() => context.chat.streaming !== null);
	context.chat.stop();
	answering.resolve();
	await Promise.all(context.tutor.answers);
	await context.settle();
	expect(context.chat.streaming).toBeNull();
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('stopping an answer to a sent message keeps the message and saves no answer', async () => {
	const context = await setup();
	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	context.chat.inputValue = 'It was a lucid talk.';
	await context.chat.sendMessage();
	await until(() => context.chat.streaming !== null);
	context.chat.stop();
	answering.resolve();
	await Promise.all(context.tutor.answers);
	await context.settle();
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
		'user',
	]);
	expect(context.chat.canAsk).toBe(true);
	expect(context.folder.files.paths('messages')).toHaveLength(2);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('an opening is not asked twice over a chat that already has one', async () => {
	const context = await setup();
	await context.chat.retry();
	await context.settle();
	expect(context.requests).toBe(0);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('an empty chat asks for its opening only once its messages are listed', async () => {
	const context = await setup({ saved: [], unlisted: true });
	expect(context.chat.canAsk).toBe(false);
	const asking = context.chat.retry();
	await Bun.sleep(50);
	expect(context.requests).toBe(0);
	expect(context.chat.messages).toEqual([]);
	context.listable();
	await asking;
	await context.settle();
	expect(context.requests).toBe(1);
	expect(context.chat.messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	context.chat[Symbol.dispose]();
	context.folder[Symbol.dispose]();
});

test('a learner whose own model is read after the chat opens is never sent to the hosted tutor', async () => {
	/** Choices as `modelChoices` answers them: the default until the saved ones are read. */
	let read = false;
	const reading = Promise.withResolvers<void>();
	const choices = sessionDouble<ChatOptions['choices']>({
		get: () => (read ? TUTOR : HOSTED),
		set: async () => {},
		subscribe: () => () => {},
		ready: reading.promise,
	});
	const context = await setup({ saved: [], choices });
	const opening = context.chat.retry();
	await Bun.sleep(50);
	expect(context.requests + context.hostedRequests).toBe(0);
	read = true;
	reading.resolve();
	await opening;
	await context.settle();
	expect(context.hostedRequests).toBe(0);
	expect(context.requests).toBe(1);

	read = false;
	const again = Promise.withResolvers<void>();
	const later = await setup({
		choices: sessionDouble<ChatOptions['choices']>({
			get: () => (read ? TUTOR : HOSTED),
			set: async () => {},
			subscribe: () => () => {},
			ready: again.promise,
		}),
	});
	later.chat.inputValue = 'Is this right?';
	const sending = later.chat.sendMessage();
	await Bun.sleep(50);
	read = true;
	again.resolve();
	await sending;
	await later.settle();
	expect(later.hostedRequests).toBe(0);
	expect(later.requests).toBe(1);
	for (const each of [context, later]) {
		each.chat[Symbol.dispose]();
		each.folder[Symbol.dispose]();
	}
});
