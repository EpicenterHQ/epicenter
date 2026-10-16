/**
 * Vocab chat session tests.
 * The real session, loop, and message store run over Vocab's real browser
 * folder on an in-memory OPFS stand-in, with the tutor behind an OpenAI client whose
 * requests are answered in-process and counted. What is saved is read from
 * the message files.
 *
 * Key behaviors:
 * - The draft stays until the learner message is a file, and typing that
 *   arrives meanwhile is never cleared
 * - A refused write asks the tutor nothing; saving again asks nothing either
 * - A finished answer the folder refuses stays whole and is saved again
 *   without a second tutor request
 * - A stopped, cut-off, or failed answer is never saved
 * - Stop while a message or the transcript is being saved or read prevents
 *   the late tutor start
 * - A closed or unreadable folder asks the tutor nothing
 * - A finished chat is there when the folder is opened again
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AgentMessage } from '@epicenter/agent';
import OpenAI from 'openai';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from '../data.js';
import {
	createBrowser,
	gatedMessages,
	tableFiles,
} from '../folder.test-support.js';
import { createQueryClient } from '../query.test-support.js';
import type { TutorRoute } from '../tutor.js';
import {
	createChatMessageStore,
	type MessageWrite,
	startChat,
} from './messages.js';

const { createVocabChat } = await import('./session.svelte.js');
const { createVocab } = await import('../vocab.svelte.ts');

const welcome: AgentMessage = {
	id: 'welcome',
	role: 'assistant',
	createdAt: 1,
	parts: [{ type: 'text', text: 'Welcome! Try "lucid" in a sentence.' }],
};
const asked: AgentMessage = {
	id: 'question',
	role: 'user',
	createdAt: 2,
	parts: [{ type: 'text', text: 'Is this right?' }],
};

/** One chat over a folder that can refuse or delay, and a counted tutor. */
async function setup() {
	const browser = createBrowser();
	const folder = await browser.open();
	const chatId = expectOk(
		await startChat(folder.tables.chats, [{ entryId: 'entry', text: 'lucid' }]),
	).id;
	const { gate, folder: gatedFolder } = gatedMessages(folder);
	const tutor = {
		requests: 0,
		finishReason: 'stop',
		/** Set to keep the answer's stream open after its first words. */
		held: undefined as Promise<void> | undefined,
		status: 200,
		/** One per answer stream, settled once the tutor has sent all of it. */
		answers: [] as Promise<void>[],
	};
	const client = new OpenAI({
		apiKey: 'test',
		baseURL: 'https://tutor.test/v1',
		maxRetries: 0,
		fetch: async () => {
			tutor.requests += 1;
			if (tutor.status !== 200)
				return Response.json(
					{ error: { message: 'The tutor is unavailable.' } },
					{ status: tutor.status },
				);
			const event = (finishReason: string | null) =>
				new TextEncoder().encode(
					`data: ${JSON.stringify({
						choices: [
							{
								index: 0,
								delta: { content: 'Nice.' },
								finish_reason: finishReason,
							},
						],
					})}\n\n`,
				);
			const { held } = tutor;
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
							// The client stopped reading: the rest was sent to a cancelled stream.
						} finally {
							answered.resolve();
						}
					},
				}),
				{ headers: { 'content-type': 'text/event-stream' } },
			);
		},
	});
	const open = (
		target: Pick<VocabFolder, 'tables' | 'files'> = gatedFolder,
		write?: MessageWrite,
		route: () => Promise<Result<TutorRoute, string>> = async () =>
			Ok({ client, model: 'test-model' }),
	) =>
		createVocabChat({
			folder: target,
			write,
			chatId,
			focus: [{ text: 'lucid' }],
			tutor: { canServe: true, route },
		});
	return {
		browser,
		folder,
		gatedFolder,
		chatId,
		gate,
		tutor,
		open,
		/** Save a message file directly, as an earlier session left it. */
		async seed(...messages: AgentMessage[]) {
			const store = createChatMessageStore(folder, chatId);
			for (const message of messages)
				expectOk(await store.set(message.id, message));
		},
		/** The roles a reload would show, from the folder opened again. */
		async savedRoles() {
			const store = createChatMessageStore(await browser.open(), chatId);
			expectOk(await store.load());
			return [...store.entries()]
				.map(({ val }) => val)
				.sort((a, b) => a.createdAt - b.createdAt)
				.map((message) => message.role);
		},
		[Symbol.asyncDispose]: () => browser[Symbol.asyncDispose](),
	};
}

type Chat = ReturnType<typeof createVocabChat>;

/** Let one event-loop turn pass, so off-thread work can report back. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Wait until the chat has nothing in flight.
 *
 * The folder hashes files with `crypto.subtle`, which answers from a worker
 * thread, so how many turns a read or write takes depends on machine load.
 * There is no turn budget: a chat that never settles fails on the test timeout.
 */
async function settle(chat: Chat) {
	while (chat.isGenerating || chat.isSaving || chat.isReading) await nextTurn();
}

/** A mounted chat whose transcript has been read. */
async function ready(chat: Chat) {
	await settle(chat);
	return chat;
}

const roles = (chat: { messages: AgentMessage[] }) =>
	chat.messages.map((message) => message.role);

test('the draft stays until the learner message is a file, then clears, and the chat is there after reopening', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(context.open());

	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	expect(chat.inputValue).toBe('It was a lucid talk.');
	expect(chat.isSaving).toBe(true);
	expect(chat.canSend).toBe(false);

	await sending;
	expect(chat.inputValue).toBe('');
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
	expect(chat.unsaved).toEqual([]);
	expect(await context.savedRoles()).toEqual([
		'assistant',
		'user',
		'assistant',
	]);

	// A reload: a new session over the folder opened again shows the same chat.
	using reopened = await ready(context.open(await context.browser.open()));
	expect(reopened.messages).toEqual(chat.messages);
	expect(context.tutor.requests).toBe(1);
});

test('nothing is sent before the transcript has been read', async () => {
	await using context = await setup();
	await context.seed(welcome);
	const reading = Promise.withResolvers<void>();
	context.gate.heldList = reading.promise;
	using chat = context.open();

	chat.inputValue = 'It was a lucid talk.';
	expect(chat.isReading).toBe(true);
	expect(chat.canSend).toBe(false);
	await chat.sendMessage();
	expect(chat.inputValue).toBe('It was a lucid talk.');
	expect(context.gate.creates).toBe(0);

	reading.resolve();
	await settle(chat);
	expect(roles(chat)).toEqual(['assistant']);
	expect(chat.canSend).toBe(true);
});

test('typing that arrives while the learner message is saving is not cleared', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(context.open());

	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	chat.inputValue = 'It was a lucid talk. Also,';
	await sending;
	expect(chat.inputValue).toBe('It was a lucid talk. Also,');
	await settle(chat);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
});

test('a refused write keeps the draft and asks the tutor nothing, and saving again asks nothing either', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(context.open());

	context.gate.failing = true;
	chat.inputValue = 'It was a lucid talk.';
	await chat.sendMessage();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.inputValue).toBe('It was a lucid talk.');
	expect(chat.saveError?.name).toBe('WriteFailed');
	expect(chat.unsaved.map((message) => message.role)).toEqual(['user']);
	expect(chat.canSend).toBe(false);
	expect(await context.savedRoles()).toEqual(['assistant']);

	// Neither a second send nor a tutor retry gets past the unsaved message.
	await chat.sendMessage();
	await chat.retry();
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(0);
	expect(await context.savedRoles()).toEqual(['assistant']);
	expect(chat.inputValue).toBe('It was a lucid talk.');

	context.gate.failing = false;
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(0);
	expect(chat.inputValue).toBe('');
	expect(chat.unsaved).toEqual([]);
	expect(chat.saveError).toBeNull();
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);

	// Asking the tutor is the learner's separate step.
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
});

test('a tutor answer the folder refuses is kept whole and saved again without a second tutor request', async () => {
	await using context = await setup();
	await context.seed(welcome, asked);
	using chat = await ready(context.open());

	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	await chat.retry();
	// The folder stops taking writes while the tutor is answering.
	context.gate.failing = true;
	answering.resolve();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(chat.error).toBeNull();
	expect(chat.saveError?.name).toBe('WriteFailed');
	const [kept] = chat.unsaved;
	expect(kept?.role).toBe('assistant');
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);

	chat.stop();
	await chat.retry();
	expect(context.tutor.requests).toBe(1);
	expect(chat.unsaved).toEqual(kept ? [kept] : []);

	context.gate.failing = false;
	await chat.saveAgain();
	expect(context.tutor.requests).toBe(1);
	expect(chat.unsaved).toEqual([]);
	expect(chat.messages.at(-1)).toEqual(kept);
	expect(await tableFiles(context.folder, 'messages')).toHaveLength(3);
});

test('a tutor answer cut off at the output limit is a tutor failure and saves nothing', async () => {
	await using context = await setup();
	await context.seed(welcome, asked);
	using chat = await ready(context.open());

	context.tutor.finishReason = 'length';
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(chat.error?.code).toBe('length');
	expect(chat.saveError).toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(roles(chat)).toEqual(['assistant', 'user']);
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
});

test('a tutor request that fails saves nothing and leaves the learner message to ask again', async () => {
	await using context = await setup();
	await context.seed(welcome, asked);
	using chat = await ready(context.open());

	context.tutor.status = 500;
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(chat.error).not.toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
	expect(chat.canAsk).toBe(true);
});

test('an answer stopped while it is arriving is never saved, even when the rest arrives afterward', async () => {
	await using context = await setup();
	await context.seed(welcome, asked);
	using chat = await ready(context.open());

	const answering = Promise.withResolvers<void>();
	context.tutor.held = answering.promise;
	await chat.retry();
	while (chat.streaming === null) await nextTurn();

	chat.stop();
	answering.resolve();
	await Promise.all(context.tutor.answers);
	await settle(chat);
	expect(chat.streaming).toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(roles(chat)).toEqual(['assistant', 'user']);
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
});

test('stop while the learner message is being saved keeps the message and prevents the late tutor start', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(context.open());

	const saving = Promise.withResolvers<void>();
	context.gate.heldCreate = saving.promise;
	chat.inputValue = 'It was a lucid talk.';
	const sending = chat.sendMessage();
	await Bun.sleep(0);
	chat.stop();
	saving.resolve();
	await sending;
	// A turn starts in the same call that lands the message, so a late start
	// would still be generating here.
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	// The message was admitted before the stop, so it is saved and unanswered.
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
	expect(chat.unsaved).toEqual([]);
	expect(chat.canAsk).toBe(true);
});

// ============================================================================
// Tutor opening over a new chat's focus
// ============================================================================

test('opening requests that overlap while the folder is read ask the tutor once, after the read', async () => {
	await using context = await setup();
	const reading = Promise.withResolvers<void>();
	context.gate.heldList = reading.promise;
	using chat = context.open();

	const first = chat.retry();
	const second = chat.retry();
	await Bun.sleep(0);
	expect(context.tutor.requests).toBe(0);
	// Asked, and stoppable, before the tutor has been reached.
	expect(chat.isGenerating).toBe(true);
	expect(chat.canAsk).toBe(false);

	reading.resolve();
	await Promise.all([first, second]);
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant']);
	expect(await context.savedRoles()).toEqual(['assistant']);
});

test('an opening is not asked again over a chat that already has one', async () => {
	await using context = await setup();
	await context.seed(welcome);
	// The view asks for an opening as it mounts, before the transcript is read.
	using chat = context.open();

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(roles(chat)).toEqual(['assistant']);
});

test('stop while the folder is being read prevents the late tutor start', async () => {
	await using context = await setup();
	const reading = Promise.withResolvers<void>();
	context.gate.heldList = reading.promise;
	using chat = context.open();

	const opening = chat.retry();
	await Bun.sleep(0);
	chat.stop();
	expect(chat.isGenerating).toBe(false);
	reading.resolve();
	context.gate.heldList = undefined;
	await opening;
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.readError).toBeNull();

	// Stopped, not broken: the learner can ask again.
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
});

test('disposing the chat while the folder is being read prevents the late tutor start', async () => {
	await using context = await setup();
	const reading = Promise.withResolvers<void>();
	context.gate.heldList = reading.promise;
	const chat = context.open();

	const opening = chat.retry();
	await Bun.sleep(0);
	chat[Symbol.dispose]();
	reading.resolve();
	await opening;
	await Bun.sleep(0);
	expect(context.tutor.requests).toBe(0);
	await chat.retry();
	expect(context.tutor.requests).toBe(0);
});

test('an opening over a folder that cannot be read asks nothing, reports a read failure, and reading again does not ask either', async () => {
	await using context = await setup();
	context.gate.failing = true;
	using chat = context.open();

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.readError?.name).toBe('NotRead');
	expect(chat.error).toBeNull();
	expect(chat.unsaved).toEqual([]);
	expect(chat.canAsk).toBe(false);

	// Asking again does not get past the failure, and a failed read keeps
	// reporting it.
	await chat.retry();
	await chat.readAgain();
	expect(context.tutor.requests).toBe(0);
	expect(chat.readError?.name).toBe('NotRead');

	context.gate.failing = false;
	await chat.readAgain();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.readError).toBeNull();
	expect(chat.canAsk).toBe(true);

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant']);
});

test('a closed folder asks the tutor nothing, for an opening, an answer, and a learner message', async () => {
	await using context = await setup();
	await context.seed(welcome, asked);
	using chat = await ready(context.open());
	expect(chat.canAsk).toBe(true);
	await context.folder.close();

	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.readError?.name).toBe('NotRead');
	// What was read before the folder closed stays on screen.
	expect(roles(chat)).toEqual(['assistant', 'user']);

	chat.inputValue = 'Another try.';
	await chat.sendMessage();
	await settle(chat);
	expect(context.tutor.requests).toBe(0);
	expect(chat.inputValue).toBe('Another try.');
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
});

test('the tutor is asked over the transcript the folder holds now, not the one first shown', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(context.open());
	expect(roles(chat)).toEqual(['assistant']);

	// Another tab saves the learner's question in this chat.
	await context.seed(asked);
	await chat.retry();
	await settle(chat);
	expect(context.tutor.requests).toBe(1);
	expect(roles(chat)).toEqual(['assistant', 'user', 'assistant']);
	expect(await context.savedRoles()).toEqual([
		'assistant',
		'user',
		'assistant',
	]);
});

test('a tutor reply is written by a mutation scoped to its chat, and close waits for it', async () => {
	await using context = await setup();
	const vocab = createVocab(
		{ ...context.folder, ...context.gatedFolder } as VocabFolder,
		createQueryClient(),
	);
	using chat = await ready(
		context.open(
			context.gatedFolder,
			vocab.chats.messageWriter(context.chatId),
		),
	);
	const writing = Promise.withResolvers<void>();
	context.gate.heldCreate = writing.promise;
	const asking = chat.retry();
	while (context.gate.creates === 0 && vocab.queryClient.isMutating() === 0)
		await nextTurn();
	await asking;
	// The finished reply is on screen while its file is being written.
	expect(roles(chat)).toEqual(['assistant']);
	expect(vocab.busy).toBe(true);
	let closed = false;
	const closing = vocab.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	writing.resolve();
	await closing;
	expect(chat.unsaved).toEqual([]);
	expect(await context.savedRoles()).toEqual(['assistant']);
});

test('a turn with no route shows why, sends nothing, and keeps the learner message', async () => {
	await using context = await setup();
	await context.seed(welcome);
	using chat = await ready(
		context.open(undefined, undefined, async () =>
			Err(
				'Groq has no endpoint saved in this browser. Add one in Connections.',
			),
		),
	);

	chat.inputValue = 'It was a lucid talk.';
	await chat.sendMessage();
	await settle(chat);
	expect(chat.visibleError?.message).toBe(
		'Groq has no endpoint saved in this browser. Add one in Connections.',
	);
	expect(context.tutor.requests).toBe(0);
	expect(await context.savedRoles()).toEqual(['assistant', 'user']);
});
