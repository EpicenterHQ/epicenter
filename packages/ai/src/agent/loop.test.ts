/**
 * Agent Conversation Loop Tests
 *
 * The loop over a real folder's messages collection: a folder at a place in
 * memory (`memory()`), whose writes `memoryFiles(folder)` can hold open
 * or refuse and to which it writes files as another program would, and a
 * stand-in `ai` whose `chat` streams what each test's engine says.
 *
 * Key behaviors:
 * - Finished turns persist while aborted or failed turns do not
 * - Tool calls run sequentially, in model order, and re-enter the next prompt
 * - A tool left out is denied; a mutating tool runs only on the person's yes
 * - The system prompt and `prepare` shape what each step sends
 * - A learner message is confirmed saved before the model is asked anything
 * - A fully received answer survives a failed write under the same ids, and
 *   saving it again runs neither the model nor a tool
 * - A note already holding the message counts as saved; another is refused
 * - No turn runs until the chat's saved messages were listed (`Unlisted`);
 *   a retry once they are runs it
 * - Disposal stops following the collection; writes in flight still land
 */
import { describe, expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
import { OpenFolderError } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { AiError, type ChatChunk, type ChatRequest } from '../client.js';
import type { Ai } from '../open-ai.js';
import { type ConversationMessages, createConversation } from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
	messagesCollection,
	readMessage,
} from './message.js';
import type { EngineChunk } from './stream.js';
import type { AgentTool } from './tools.js';

const CHAT = 'chat-a';

const contract = defineContract({
	collections: { messages: messagesCollection },
});

/** A learner message of this chat. */
const learner = (id: string, text: string, createdAt = 1): AgentMessage => ({
	id,
	role: 'user',
	createdAt,
	parts: [{ type: 'text', text }],
});

/** A message note's file, as another program writes it. */
const noteText = ({ role, createdAt, parts }: AgentMessage) =>
	`---\nrole: ${role}\ncreatedAt: ${createdAt}\nparts: ${JSON.stringify(parts)}\n---\n`;

/**
 * A folder in memory and its messages collection as a conversation is
 * given it, counting each create the conversation asks for (`attempts`).
 */
function makeMessages() {
	const folder = openFolder(contract, memory());
	const attempts: string[] = [];
	const messages: ConversationMessages = {
		...folder.messages,
		create(value) {
			attempts.push(value.id);
			return folder.messages.create(value);
		},
	};
	return {
		folder,
		messages,
		attempts,
		files: memoryFiles(folder),
		/** This chat's saved messages, read now, oldest first. */
		async saved() {
			const { items } = expectOk(await folder.messages.list());
			return items
				.filter((note) => note.chat === CHAT)
				.map(readMessage)
				.sort((a, b) => a.createdAt - b.createdAt);
		},
		/** Save `message` in this chat, as another writer would. */
		async put(message: AgentMessage) {
			expectOk(
				await folder.messages.create({ chat: CHAT, ...message, body: '' }),
			);
		},
	};
}

/** The ids of `messages`, in order. */
const idsOf = (messages: readonly AgentMessage[]) =>
	messages.map((message) => message.id);

/**
 * A folder that does not open (offline) until `reconnect()`, at a place in
 * memory already holding `seed`: its first listing fails.
 */
async function offlineFolder(seed: AgentMessage[] = []) {
	const place = memory();
	const seeding = openFolder(contract, place);
	for (const message of seed)
		expectOk(
			await seeding.messages.create({ chat: CHAT, ...message, body: '' }),
		);
	seeding[Symbol.dispose]();
	const online = memoryFiles(place).refuseOpen(
		OpenFolderError.StorageUnavailable({ cause: 'offline' }).error,
	);
	const folder = openFolder(contract, place);
	return {
		folder,
		/** Open again, now reachable. */
		async reconnect() {
			online();
			const state = folder.state();
			if (state.status !== 'failed') throw new Error('expected a failed open');
			await state.retry();
		},
		async [Symbol.asyncDispose]() {
			folder[Symbol.dispose]();
		},
	};
}

/** What a step is asked: its messages and the tools offered. */
type Request = Pick<ChatRequest, 'messages'> & { tools: ChatRequest['tools'] };
type Engine = (
	request: Request,
	signal: AbortSignal,
) => AsyncIterable<EngineChunk>;

/**
 * An `ai` whose chat streams what `engine` says for each request, in the
 * OpenAI shape: text as content deltas, each tool call as one indexed delta,
 * a failure as the provider's error, and the finish the answer had.
 */
function aiOf(engine: Engine): Pick<Ai, 'chat'> {
	return {
		async *chat(request, { signal } = {}) {
			let calls = 0;
			for await (const chunk of engine(
				{ messages: request.messages, tools: request.tools },
				signal ?? new AbortController().signal,
			)) {
				if (chunk.type === 'run-error') {
					yield AiError.Failed({ message: chunk.message, code: chunk.code });
					return;
				}
				const delta: NonNullable<ChatChunk['choices'][number]['delta']> =
					chunk.type === 'text-delta'
						? { content: chunk.delta }
						: {
								tool_calls: [
									{
										index: calls++,
										id: chunk.toolCallId,
										type: 'function',
										function: {
											name: chunk.toolName,
											arguments: JSON.stringify(chunk.input),
										},
									},
								],
							};
				yield Ok({ choices: [{ index: 0, delta }] });
			}
			yield Ok({
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: calls > 0 ? 'tool_calls' : 'stop',
					},
				],
			});
		},
	} as Pick<Ai, 'chat'>;
}

function streamOf(chunks: EngineChunk[]): AsyncIterable<EngineChunk> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

function ids() {
	let value = 0;
	return () => `m${++value}`;
}

/** Let every already-scheduled microtask and timer callback run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait until `check` holds. */
async function until(check: () => boolean) {
	for (let turn = 0; turn < 400 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

async function settle(handle: {
	snapshot(): { isGenerating: boolean; isSaving: boolean };
}) {
	const isActive = () =>
		handle.snapshot().isGenerating || handle.snapshot().isSaving;
	for (let count = 0; count < 200 && isActive(); count++) await tick();
}

/** A conversation over `messages` and `engine`, with its options beside. */
function open(
	messages: ConversationMessages,
	engine: Engine,
	options: Partial<Parameters<typeof createConversation>[0]> = {},
) {
	return createConversation({
		messages,
		chat: CHAT,
		ai: aiOf(engine),
		model: () => ({ endpoint: 'test', model: 'model' }),
		generateId: ids(),
		...options,
	});
}

/** A counted engine that answers every prompt with one line of text. */
function answering(text = 'answer') {
	const prompts: Request['messages'][] = [];
	const engine: Engine = (request) => {
		prompts.push(request.messages);
		return streamOf([{ type: 'text-delta', delta: text }]);
	};
	return { engine, prompts };
}

/** A tool step followed by a final answer: two assistant messages per turn. */
function toolThenAnswer() {
	const counts = { engine: 0, tool: 0 };
	const engine: Engine = () =>
		++counts.engine === 1
			? streamOf([
					{ type: 'tool-call', toolCallId: 't1', toolName: 'time', input: {} },
				])
			: streamOf([{ type: 'text-delta', delta: 'noon' }]);
	const tools: AgentTool[] = [
		{
			name: 'time',
			run: async () => {
				counts.tool++;
				return { content: '12:00', isError: false };
			},
		},
	];
	return { engine, tools, counts };
}

/** A tool that answers `content`. */
const answeringTool = (name: string, content = name): AgentTool => ({
	name,
	run: async () => ({ content, isError: false }),
});

describe('createConversation', () => {
	test('assigns ordered timestamps that preserve rapid turns after reopening', async () => {
		const { messages } = makeMessages();
		const engine: Engine = () =>
			streamOf([{ type: 'text-delta', delta: 'answer' }]);
		const conversation = open(messages, engine);
		await conversation.send('first');
		await settle(conversation);
		await conversation.send('second');
		await settle(conversation);
		const saved = conversation.snapshot().messages;
		expect(saved.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'user',
			'assistant',
		]);
		expect(saved.map((message) => message.createdAt)).toEqual(
			[...saved.map((message) => message.createdAt)].sort((a, b) => a - b),
		);
		expect(new Set(saved.map((message) => message.createdAt)).size).toBe(4);
		conversation[Symbol.dispose]();
		const reopened = open(messages, engine);
		await reopened.ready;
		expect(
			reopened.snapshot().messages.map((message) => agentMessageText(message)),
		).toEqual(['first', 'answer', 'second', 'answer']);
		reopened[Symbol.dispose]();
	});

	test('a learner message comes after every saved one, even one stamped in the future', async () => {
		const { messages, put } = makeMessages();
		const later = Date.now() + 60_000;
		await put(learner('ahead', 'from a fast clock', later));
		const conversation = open(messages, () => streamOf([]));
		await conversation.ready;
		expectOk(await conversation.send('mine'));
		const [first, second] = conversation.snapshot().messages;
		expect(first?.id).toBe('ahead');
		expect(second?.createdAt).toBeGreaterThan(later);
		conversation[Symbol.dispose]();
	});

	test('persists a finished streamed turn and reports send guards', async () => {
		const { messages, saved } = makeMessages();
		const conversation = open(messages, () =>
			streamOf([
				{ type: 'text-delta', delta: 'Hello' },
				{ type: 'text-delta', delta: ' world' },
			]),
		);
		expect(expectErr(await conversation.send(' '))).toMatchObject({
			name: 'NotAdmitted',
			reason: 'empty',
		});
		const first = conversation.send('hi');
		expect(expectErr(await conversation.send('again'))).toMatchObject({
			name: 'NotAdmitted',
			reason: 'busy',
		});
		expectOk(await first);
		await settle(conversation);
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['user', 'assistant']);
		const assistant = conversation.snapshot().messages[1];
		if (assistant === undefined) throw new Error('missing assistant message');
		expect(agentMessageText(assistant)).toBe('Hello world');
		expect(await saved()).toHaveLength(2);
	});

	test('streaming snapshots use fresh identities and settle into messages', async () => {
		const { messages } = makeMessages();
		const conversation = open(messages, () =>
			streamOf([
				{ type: 'text-delta', delta: 'one' },
				{ type: 'text-delta', delta: ' two' },
			]),
		);
		const snapshots = new Set<AgentMessage>();
		conversation.subscribe(() => {
			const { streaming } = conversation.snapshot();
			if (streaming) snapshots.add(streaming);
		});
		await conversation.send('go');
		await settle(conversation);
		expect(snapshots.size).toBeGreaterThan(1);
		expect(conversation.snapshot().streaming).toBeNull();
	});

	test('tool steps re-prompt without an empty in-flight assistant', async () => {
		const { messages } = makeMessages();
		const prompts: Request['messages'][] = [];
		let step = 0;
		const engine: Engine = (request) => {
			prompts.push(request.messages);
			return ++step === 1
				? streamOf([
						{
							type: 'tool-call',
							toolCallId: 't1',
							toolName: 'time',
							input: {},
						},
					])
				: streamOf([{ type: 'text-delta', delta: 'noon' }]);
		};
		const conversation = open(messages, engine, {
			tools: [answeringTool('time', '12:00')],
		});
		await conversation.send('time?');
		await settle(conversation);
		expect(prompts[0]?.map((message) => message.role)).toEqual(['user']);
		expect(prompts[1]?.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
		]);
		expect(conversation.snapshot().messages).toHaveLength(3);
	});

	test('a tool step goes back to the model as OpenAI messages and tools', async () => {
		const { messages } = makeMessages();
		const requests: Request[] = [];
		let step = 0;
		const engine: Engine = (request) => {
			requests.push(request);
			return ++step === 1
				? streamOf([
						{
							type: 'tool-call',
							toolCallId: 't1',
							toolName: 'weather',
							input: { city: 'Paris' },
						},
					])
				: streamOf([{ type: 'text-delta', delta: '17C in Paris' }]);
		};
		const conversation = open(messages, engine, {
			tools: [
				{
					name: 'weather',
					description: 'Look up weather',
					input: { type: 'object', properties: { city: { type: 'string' } } },
					run: async () => ({ content: '17C', isError: false }),
				},
			],
		});
		await conversation.send('weather?');
		await settle(conversation);
		expect(requests[0]?.tools).toEqual([
			{
				type: 'function',
				function: {
					name: 'weather',
					description: 'Look up weather',
					parameters: {
						type: 'object',
						properties: { city: { type: 'string' } },
						required: [],
					},
				},
			},
		]);
		expect(requests[1]?.messages).toEqual([
			{ role: 'user', content: 'weather?' },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 't1',
						type: 'function',
						function: { name: 'weather', arguments: '{"city":"Paris"}' },
					},
				],
			},
			{ role: 'tool', tool_call_id: 't1', content: '17C' },
		]);
	});

	test('the system prompt, from the saved transcript, goes first, and prepare shapes the rest', async () => {
		const { messages } = makeMessages();
		const { engine, prompts } = answering('Welcome!');
		const seen: number[] = [];
		const conversation = open(messages, engine, {
			system: (transcript) => {
				seen.push(transcript.length);
				return transcript.length === 0 ? 'Open the chat.' : 'Answer.';
			},
			prepare: (prompt) =>
				prompt.length > 0 ? prompt : [{ role: 'user', content: 'Begin.' }],
		});
		conversation.retry();
		await settle(conversation);
		expect(prompts[0]).toEqual([
			{ role: 'system', content: 'Open the chat.' },
			{ role: 'user', content: 'Begin.' },
		]);
		await conversation.send('thanks');
		await settle(conversation);
		expect(prompts[1]?.[0]).toEqual({ role: 'system', content: 'Answer.' });
		expect(seen).toEqual([0, 2]);
		// The opening's transient user turn is never saved.
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['assistant', 'user', 'assistant']);
	});

	test('with no model chosen, a turn fails and asks nothing', async () => {
		const { messages } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine, { model: () => null });
		await conversation.send('hello');
		await settle(conversation);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot().error?.code).toBe('NoModel');
	});

	test('a tool schema that is not an object fails the turn', async () => {
		const { messages } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine, {
			tools: [
				{
					name: 'bad',
					input: 'nope' as never,
					run: async () => ({ content: '', isError: false }),
				},
			],
		});
		await conversation.send('go');
		await settle(conversation);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot().error?.message).toBe(
			'Tool input schema must be a JSON Schema object.',
		);
	});

	test('later turns never prompt with the empty assistant being filled', async () => {
		const { messages } = makeMessages();
		const { engine, prompts } = answering('ok');
		const conversation = open(messages, engine);
		await conversation.send('one');
		await settle(conversation);
		await conversation.send('two');
		await settle(conversation);
		expect(prompts[0]?.at(-1)).toMatchObject({ role: 'user', content: 'one' });
		expect(
			prompts[1]?.map((message) => `${message.role}:${message.content}`),
		).toEqual(['user:one', 'assistant:ok', 'user:two']);
	});

	test('multiple tools run sequentially in model order', async () => {
		const { messages } = makeMessages();
		let step = 0;
		const engine: Engine = () =>
			++step === 1
				? streamOf([
						{ type: 'tool-call', toolCallId: '1', toolName: 'a', input: {} },
						{ type: 'tool-call', toolCallId: '2', toolName: 'b', input: {} },
					])
				: streamOf([{ type: 'text-delta', delta: 'done' }]);
		const order: string[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tool = (name: string): AgentTool => ({
			name,
			async run() {
				order.push(name);
				if (name === 'a') {
					started.resolve();
					await release.promise;
				}
				return { content: name, isError: false };
			},
		});
		const conversation = open(messages, engine, {
			tools: [tool('a'), tool('b')],
		});
		try {
			await conversation.send('go');
			await started.promise;
			expect(order).toEqual(['a']);
			release.resolve();
			await settle(conversation);
			expect(order).toEqual(['a', 'b']);
		} finally {
			release.resolve();
			conversation[Symbol.dispose]();
		}
	});

	test('a declined change records the denial without running the tool, and a tool left out runs nothing', async () => {
		const { messages } = makeMessages();
		let step = 0;
		let ran = false;
		const engine: Engine = () =>
			++step === 1
				? streamOf([
						{
							type: 'tool-call',
							toolCallId: '1',
							toolName: 'delete',
							input: {},
						},
						{ type: 'tool-call', toolCallId: '2', toolName: 'drop', input: {} },
					])
				: streamOf([{ type: 'text-delta', delta: 'kept' }]);
		const conversation = open(messages, engine, {
			tools: [
				{
					name: 'delete',
					mutates: true,
					run: async () => {
						ran = true;
						return { content: 'deleted', isError: false };
					},
				},
			],
			approve: async () => false,
		});
		await conversation.send('delete');
		await settle(conversation);
		expect(ran).toBe(false);
		const results = conversation
			.snapshot()
			.messages[1]?.parts.filter((part) => part.type === 'tool-result');
		expect(results).toMatchObject([
			{ toolName: 'delete', content: 'Denied by the user.', isError: true },
			{
				toolName: 'drop',
				content: 'No tool named drop is available.',
				isError: true,
			},
		]);
	});

	test('aborting drops the partial assistant and retry starts another turn', async () => {
		const { messages, saved } = makeMessages();
		const streamed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const engine: Engine = async function* () {
			if (++calls > 1) {
				yield { type: 'text-delta', delta: 'whole' };
				return;
			}
			yield { type: 'text-delta', delta: 'partial' };
			streamed.resolve();
			await release.promise;
		};
		const conversation = open(messages, engine);
		try {
			await conversation.send('go');
			await streamed.promise;
			await tick();
			expect(agentMessageText(conversation.snapshot().streaming!)).toBe(
				'partial',
			);
			conversation.stop();
			release.resolve();
			await settle(conversation);
			expect(
				conversation.snapshot().messages.map((message) => message.role),
			).toEqual(['user']);
			expect(conversation.snapshot().unsaved).toEqual([]);
			expect(await saved()).toHaveLength(1);
			conversation.retry();
			await settle(conversation);
			expect(conversation.snapshot().messages).toHaveLength(2);
		} finally {
			release.resolve();
			conversation[Symbol.dispose]();
		}
	});

	test('runaway tool loops stop after 50 steps without persisting the turn', async () => {
		const { messages, saved } = makeMessages();
		let calls = 0;
		const engine: Engine = () => {
			calls++;
			return streamOf([
				{
					type: 'tool-call',
					toolCallId: `${calls}`,
					toolName: 'loop',
					input: {},
				},
			]);
		};
		const conversation = open(messages, engine, {
			tools: [answeringTool('loop', 'again')],
		});
		await conversation.send('go');
		await settle(conversation);
		expect(calls).toBe(50);
		expect(conversation.snapshot().error?.code).toBe('MaxStepsExceeded');
		expect(await saved()).toHaveLength(1);
	});

	test('a failed stream saves nothing and leaves no unsaved answer', async () => {
		const { messages, saved } = makeMessages();
		const conversation = open(messages, () =>
			streamOf([
				{ type: 'text-delta', delta: 'half an ans' },
				{ type: 'run-error', message: 'provider unavailable' },
			]),
		);
		await conversation.send('go');
		await settle(conversation);
		const snapshot = conversation.snapshot();
		expect(snapshot.error?.message).toBe('provider unavailable');
		expect(snapshot.saveError).toBeNull();
		expect(snapshot.unsaved).toEqual([]);
		expect(idsOf(await saved())).toEqual(['m1']);
	});

	test('a tool that rejects ends the turn and leaves the conversation usable', async () => {
		const { messages, saved } = makeMessages();
		let step = 0;
		const engine: Engine = () =>
			++step === 1
				? streamOf([
						{ type: 'tool-call', toolCallId: '1', toolName: 'a', input: {} },
					])
				: streamOf([{ type: 'text-delta', delta: 'recovered' }]);
		const conversation = open(messages, engine, {
			tools: [
				{
					name: 'a',
					run: async () => {
						throw new Error('the tool went away');
					},
				},
			],
		});
		await conversation.send('go');
		await settle(conversation);
		expect(conversation.snapshot().error?.message).toBe('the tool went away');
		expect(idsOf(await saved())).toEqual(['m1']);
		conversation.retry();
		await settle(conversation);
		expect(conversation.snapshot().error).toBeNull();
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['user', 'assistant']);
	});

	test('a message another program saves is heard, and disposal stops following the collection', async () => {
		const { messages, files } = makeMessages();
		const conversation = open(messages, () => streamOf([]));
		await conversation.ready;
		let heard = 0;
		conversation.subscribe(() => heard++);
		await files.write(
			`messages/${CHAT}/external.md`,
			noteText(learner('external', 'external')),
		);
		await until(() => conversation.snapshot().messages[0]?.id === 'external');
		expect(heard).toBeGreaterThan(0);

		conversation[Symbol.dispose]();
		const before = heard;
		await files.write(
			`messages/${CHAT}/later.md`,
			noteText(learner('later', 'later', 2)),
		);
		await Bun.sleep(20);
		expect(heard).toBe(before);
	});

	test("a note of this chat that does not read is listed as unreadable, and another chat's are not", async () => {
		const { messages, files } = makeMessages();
		await files.write(`messages/${CHAT}/broken.md`, '---\nrole: user\n---\n');
		await files.write('messages/other/elsewhere.md', '---\nrole: user\n---\n');
		const conversation = open(messages, () => streamOf([]));
		await conversation.ready;
		const { unreadable } = conversation.snapshot();
		expect(unreadable.map(({ path }) => path)).toEqual([
			`messages/${CHAT}/broken.md`,
		]);
		expect(unreadable[0]?.reason.length).toBeGreaterThan(0);
		expect(conversation.snapshot().messages).toEqual([]);
		conversation[Symbol.dispose]();
	});

	test('every assistant message rendered live persists after a clean finish', async () => {
		const { messages, saved } = makeMessages();
		const conversation = open(messages, () =>
			streamOf([{ type: 'text-delta', delta: 'visible' }]),
		);
		const rendered = new Set<string>();
		conversation.subscribe(() => {
			const snapshot = conversation.snapshot();
			if (snapshot.isGenerating && snapshot.streaming) {
				rendered.add(snapshot.streaming.id);
			}
		});
		await conversation.send('go');
		await settle(conversation);
		const persisted = (await saved())
			.filter((message) => message.role === 'assistant')
			.map((message) => message.id);
		expect([...rendered]).toEqual(persisted);
	});

	test('a saved message never renders twice while its write answers', async () => {
		const { messages } = makeMessages();
		const { engine } = answering();
		const conversation = open(messages, engine);
		const seen: string[][] = [];
		conversation.subscribe(() => {
			seen.push(idsOf(conversation.snapshot().messages));
		});
		await conversation.send('hello');
		await settle(conversation);
		expect(seen.length).toBeGreaterThan(0);
		for (const rendered of seen)
			expect(rendered).toEqual([...new Set(rendered)]);
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1', 'm2']);
	});

	test('empty text parts are not persistable', () => {
		expect(
			isPersistableMessage({
				id: '1',
				role: 'assistant',
				createdAt: 0,
				parts: [{ type: 'text', text: '' }],
			}),
		).toBe(false);
	});
});

describe('listing', () => {
	test('no turn runs until the saved messages were listed, and retry runs it once they are', async () => {
		await using place = await offlineFolder([learner('saved', 'saved before')]);
		const { engine, prompts } = answering();
		const conversation = open(place.folder.messages, engine);
		await conversation.ready;
		expect(conversation.snapshot()).toMatchObject({
			listed: false,
			messages: [],
		});

		await conversation.retry();
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot()).toMatchObject({
			error: { code: 'Unlisted' },
			saveError: null,
			isGenerating: false,
		});

		await place.reconnect();
		await until(() => conversation.snapshot().listed);
		await conversation.retry();
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'saved before' }]]);
		expect(conversation.snapshot().error).toBeNull();
		expect(idsOf(conversation.snapshot().messages)).toEqual(['saved', 'm1']);
		conversation[Symbol.dispose]();
	});

	test('offline, a sent message answers at once and waits in unsaved', async () => {
		await using place = await offlineFolder();
		const { engine, prompts } = answering();
		const conversation = open(place.folder.messages, engine);
		const failure = expectErr(await conversation.send('hello'));
		expect(failure).toMatchObject({
			name: 'WriteFailed',
			cause: { name: 'StorageUnavailable' },
		});
		expect(idsOf(conversation.snapshot().unsaved)).toEqual(['m1']);
		expect(prompts).toHaveLength(0);

		await place.reconnect();
		await until(() => conversation.snapshot().listed);
		expectOk(await conversation.save());
		await conversation.retry();
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		conversation[Symbol.dispose]();
	});

	test('ready settles on disposal when the folder never opens', async () => {
		const place = memory();
		memoryFiles(place).holdOpen();
		const folder = openFolder(contract, place);
		const conversation = open(folder.messages, () => streamOf([]));
		conversation[Symbol.dispose]();
		await conversation.ready;
		expect(conversation.snapshot().listed).toBe(false);
	});
});

describe('learner message publication', () => {
	test('the model is asked nothing until the collection confirms the learner message', async () => {
		const { messages, files, saved } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		const sent = conversation.send('hello');
		await tick();
		expect(prompts).toHaveLength(0);
		expect(await saved()).toEqual([]);
		expect(conversation.snapshot()).toMatchObject({
			isSaving: true,
			isGenerating: false,
		});
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1']);

		release();
		expectOk(await sent);
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		expect(conversation.snapshot().unsaved).toEqual([]);
	});

	test('a refused learner write asks no model, keeps the message under its id, and saves again without a model call', async () => {
		const { messages, files, saved, attempts } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const undo = files.refuse('disk full');
		const failure = expectErr(await conversation.send('hello'));
		expect(failure.name).toBe('WriteFailed');
		expect(failure).toMatchObject({ cause: { name: 'Unavailable' } });
		await tick();
		expect(prompts).toHaveLength(0);
		expect(await saved()).toEqual([]);
		const failed = conversation.snapshot();
		expect<unknown>(failed.saveError).toBe(failure);
		expect(failed.isSaving).toBe(false);
		expect(idsOf(failed.unsaved)).toEqual(['m1']);
		expect(idsOf(failed.messages)).toEqual(['m1']);

		// Nothing new starts while the learner message is unsaved.
		expect(expectErr(await conversation.send('another'))).toMatchObject({
			reason: 'unsaved',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
		expect(attempts).toEqual(['m1']);

		undo();
		expectOk(await conversation.save());
		await tick();
		expect(attempts).toEqual(['m1', 'm1']);
		expect(idsOf(await saved())).toEqual(['m1']);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot()).toMatchObject({
			unsaved: [],
			saveError: null,
		});

		// Asking the model is its own explicit step.
		conversation.retry();
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
	});

	test('overlapping sends, retries, and saves admit exactly one', async () => {
		const { messages, files, saved, attempts } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		const first = conversation.send('first');
		const second = conversation.send('second');
		conversation.retry();
		const save = conversation.save();
		expect(expectErr(await second)).toMatchObject({ reason: 'busy' });
		expect(expectErr(await save)).toMatchObject({ reason: 'busy' });
		await tick();
		expect(prompts).toHaveLength(0);

		release();
		expectOk(await first);
		await settle(conversation);
		expect(prompts).toHaveLength(1);
		expect(attempts).toEqual(['m1', 'm2']);
		expect((await saved()).map((message) => agentMessageText(message))).toEqual(
			['first', 'answer'],
		);
	});

	test('stop during a pending learner write lets the write finish and starts no model turn', async () => {
		const { messages, files, saved } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		const sent = conversation.send('hello');
		conversation.stop();
		release();
		expectOk(await sent);
		await tick();
		expect(prompts).toHaveLength(0);
		expect(idsOf(await saved())).toEqual(['m1']);
		expect(conversation.snapshot()).toMatchObject({
			isGenerating: false,
			isSaving: false,
			unsaved: [],
		});

		conversation.retry();
		await settle(conversation);
		expect(prompts).toHaveLength(1);
	});

	test('disposal during a pending learner write lets the write land and starts no model turn', async () => {
		const { messages, files, saved } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		const sent = conversation.send('hello');
		await tick();
		conversation[Symbol.dispose]();

		release();
		expectOk(await sent);
		await tick();
		expect(idsOf(await saved())).toEqual(['m1']);
		expect(prompts).toHaveLength(0);
		expect(expectErr(await conversation.send('later'))).toMatchObject({
			reason: 'disposed',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
	});

	test('a collection that throws is reported with its cause, keeps the message, and leaves no unhandled rejection', async () => {
		const { folder, saved } = makeMessages();
		let throws = true;
		const { engine, prompts } = answering();
		const conversation = open(
			{
				...folder.messages,
				async create(value) {
					if (throws) throw new Error('collection exploded');
					return folder.messages.create(value);
				},
			},
			engine,
		);
		const failure = expectErr(await conversation.send('hello'));
		expect(failure).toMatchObject({
			name: 'Threw',
			cause: new Error('collection exploded'),
		});
		await tick();
		expect(prompts).toHaveLength(0);
		expect(idsOf(conversation.snapshot().unsaved)).toEqual(['m1']);

		throws = false;
		expectOk(await conversation.save());
		expect(idsOf(await saved())).toEqual(['m1']);
	});

	test('another message already at its id is refused', async () => {
		const { messages, put } = makeMessages();
		const { engine } = answering();
		let next = 0;
		const conversation = open(messages, engine, {
			generateId: () => (next++ === 0 ? 'taken' : `m${next}`),
		});
		await conversation.ready;
		await put(learner('taken', 'someone else'));
		const failure = expectErr(await conversation.send('mine'));
		expect(failure.name).toBe('WriteFailed');
		expect(failure.message).toContain(
			`Another message is already saved at 'messages/${CHAT}/taken.md'`,
		);
	});

	test('saving again after a write landed but its answer was lost counts the note already there as saved', async () => {
		const { messages, files, attempts, put, saved } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const undo = files.refuse('the answer was lost');
		expectErr(await conversation.send('hello'));
		undo();
		// The write the conversation heard fail had landed after all.
		const [lost] = conversation.snapshot().unsaved;
		if (lost === undefined) throw new Error('expected an unsaved message');
		await put(lost);

		expectOk(await conversation.save());
		expect(attempts).toEqual(['m1', 'm1']);
		expect(idsOf(await saved())).toEqual(['m1']);
		expect(conversation.snapshot()).toMatchObject({
			unsaved: [],
			saveError: null,
		});
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1']);
		expect(prompts).toHaveLength(0);
	});
});

describe('received answer publication', () => {
	test('a fully received answer survives a refused write under the same ids and saves again without the model or a tool', async () => {
		const { messages, files, saved, attempts } = makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		// The learner message saves; every write after the model starts is refused.
		let undo: (() => void) | undefined;
		const conversation = open(
			messages,
			(request, signal) => {
				undo ??= files.refuse('disk full');
				return engine(request, signal);
			},
			{ tools },
		);
		await conversation.send('time?');
		await settle(conversation);
		expect(counts).toEqual({ engine: 2, tool: 1 });
		const failed = conversation.snapshot();
		expect(failed.error).toBeNull();
		expect(failed.saveError).toMatchObject({ name: 'WriteFailed' });
		expect(idsOf(failed.unsaved)).toEqual(['m2', 'm3']);
		expect(idsOf(failed.messages)).toEqual(['m1', 'm2', 'm3']);
		expect(idsOf(await saved())).toEqual(['m1']);
		const received = failed.unsaved;

		// Neither a new message nor a model retry may start over an unsaved answer.
		expect(expectErr(await conversation.send('again'))).toMatchObject({
			reason: 'unsaved',
		});
		conversation.retry();
		await tick();
		expect(counts).toEqual({ engine: 2, tool: 1 });
		// One attempt only: the loop never asks the collection again on its own.
		expect(attempts).toEqual(['m1', 'm2']);

		undo?.();
		expectOk(await conversation.save());
		expect(counts).toEqual({ engine: 2, tool: 1 });
		expect(attempts).toEqual(['m1', 'm2', 'm2', 'm3']);
		expect(await saved()).toEqual([
			expect.objectContaining({ id: 'm1' }),
			...received,
		]);
		expect(conversation.snapshot()).toMatchObject({
			unsaved: [],
			saveError: null,
		});
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1', 'm2', 'm3']);
	});

	test('a partly saved answer keeps only its unconfirmed message and never writes the confirmed one twice', async () => {
		const { folder, messages, files, saved, attempts } = makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		const conversation = open(messages, engine, { tools });
		// Once the tool step's message is shown saved, the disk fills up.
		let undo: (() => void) | undefined;
		const stop = folder.messages.subscribe(() => {
			if (folder.messages.get({ chat: CHAT, id: 'm2' }) !== undefined)
				undo ??= files.refuse('disk full');
		});
		await conversation.send('time?');
		await settle(conversation);
		stop();
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		expect(idsOf(conversation.snapshot().unsaved)).toEqual(['m3']);
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1', 'm2', 'm3']);

		undo?.();
		const release = files.hold();
		const saving = conversation.save();
		// The failure stays reported while the retry is in flight.
		expect(conversation.snapshot()).toMatchObject({
			isSaving: true,
			saveError: { name: 'WriteFailed' },
		});
		release();
		expectOk(await saving);
		expect(conversation.snapshot().saveError).toBeNull();
		expect(attempts).toEqual(['m1', 'm2', 'm3', 'm3']);
		expect(idsOf(await saved())).toEqual(['m1', 'm2', 'm3']);
		expect(counts).toEqual({ engine: 2, tool: 1 });
	});

	test('stop does not discard a fully received answer that is waiting for the collection', async () => {
		const { messages, files, saved } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		await conversation.send('hello');
		// The learner write is done; hold the answer's write open.
		const release = files.hold();
		await until(() => conversation.snapshot().isSaving);
		expect(conversation.snapshot().isGenerating).toBe(false);
		conversation.stop();
		release();
		await settle(conversation);
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		expect(conversation.snapshot().unsaved).toEqual([]);
		expect(prompts).toHaveLength(1);
	});

	test('disposal while an answer is being written lets every admitted write land', async () => {
		const { messages, files, saved } = makeMessages();
		const { engine, tools } = toolThenAnswer();
		const conversation = open(messages, engine, { tools });
		await conversation.send('time?');
		const release = files.hold();
		await until(() => conversation.snapshot().isSaving);
		conversation[Symbol.dispose]();
		release();
		await settle(conversation);
		expect(idsOf(await saved())).toEqual(['m1', 'm2', 'm3']);
	});
});
