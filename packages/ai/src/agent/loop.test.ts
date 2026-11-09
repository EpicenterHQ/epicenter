/**
 * Agent Conversation Loop Tests
 *
 * The loop over a real folder's messages collection: a folder at a place in
 * memory (`memory()`), whose writes, reads and open `memoryFiles` can hold
 * or refuse and to which it writes files as another program would, and a
 * stand-in `ai` whose `chat` streams what each test's engine says.
 *
 * Key behaviors:
 * - Finished turns persist while aborted or failed turns do not
 * - Tool calls run sequentially, in model order, and re-enter the next prompt
 * - A tool left out is denied; a mutating tool runs only on the person's yes
 * - The system prompt and `prepare` shape what each step sends
 * - `send` hands the learner message to the folder and answers at once; the
 *   message shows from then. The model is asked only once it landed: while
 *   the store cannot be written the turn waits, a stop ends the wait with no
 *   model call, and a folder that closes ends it with `FolderClosed`
 *   (ADR-0782). The conversation writes each message once; the folder tries
 *   again
 * - A finished turn hands its answer to the folder and frees the
 *   conversation at once; a later message queues behind the answer
 * - Disposal stops following the collection; writes already handed over land
 */
import { describe, expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
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
	type MessageNote,
	messagesCollection,
	readMessage,
} from './message.js';
import type { EngineChunk } from './stream.js';
import type { AgentTool } from './tools.js';

const CHAT = 'chat-a';

const contract = defineContract({
	collections: { messages: messagesCollection },
});

type MessagesFolder = ReturnType<typeof openFolder<typeof contract>>;

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

/** The path of this chat's message `id`. */
const pathOf = (id: string) => `messages/${CHAT}/${id}.md`;

/** Save `message` in this chat through `folder`, as another writer would. */
const putIn = (
	folder: MessagesFolder,
	{ id, role, createdAt, parts }: AgentMessage,
) =>
	folder.messages.set(
		{ chat: CHAT, id },
		{ role, createdAt, parts: parts as MessageNote['parts'], body: '' },
	);

/** This chat's saved messages in `folder`, read now, oldest first. */
async function savedIn(folder: MessagesFolder) {
	const { items } = expectOk(await folder.messages.list());
	return items
		.filter((note) => note.chat === CHAT)
		.map(readMessage)
		.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * A folder in memory, connected, and its messages collection as a
 * conversation is given it, counting each write the conversation asks for
 * (`attempts`).
 */
async function makeMessages() {
	const folder = openFolder(contract, memory());
	await folder.messages.list();
	const attempts: string[] = [];
	const messages: ConversationMessages = {
		...folder.messages,
		set(args, changes) {
			attempts.push(args.id);
			return folder.messages.set(args, changes);
		},
	};
	return {
		folder,
		messages,
		attempts,
		files: memoryFiles(folder),
		/** This chat's saved messages, read now, oldest first. */
		saved: () => savedIn(folder),
		/** Save `message` in this chat, as another writer would. */
		put: (message: AgentMessage) => putIn(folder, message),
		/** Wait until no turn runs and every write handed to the folder landed. */
		settle: (conversation: Generating) => settle(conversation, folder),
	};
}

/** The ids of `messages`, in order. */
const idsOf = (messages: readonly AgentMessage[]) =>
	messages.map((message) => message.id);

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

/**
 * Wait until `check` holds: long enough for the folder to try again a write
 * or listing the store refused, which it does half a second after the first
 * failure.
 */
async function until(check: () => boolean) {
	for (let turn = 0; turn < 600 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

type Generating = { snapshot(): { isGenerating: boolean } };

/** Wait until no turn runs and every write handed to `folder` landed. */
async function settle(conversation: Generating, folder: MessagesFolder) {
	await until(() => !conversation.snapshot().isGenerating && !folder.saving());
	// The conversation hears its writes land a few microtasks after the folder.
	await tick();
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
		const { messages, settle } = await makeMessages();
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
		expect(
			reopened.snapshot().messages.map((message) => agentMessageText(message)),
		).toEqual(['first', 'answer', 'second', 'answer']);
		reopened[Symbol.dispose]();
	});

	test('a learner message comes after every saved one, even one stamped in the future', async () => {
		const { messages, put } = await makeMessages();
		const later = Date.now() + 60_000;
		await put(learner('ahead', 'from a fast clock', later));
		const conversation = open(messages, () => streamOf([]));
		expectOk(await conversation.send('mine'));
		const [first, second] = conversation.snapshot().messages;
		expect(first?.id).toBe('ahead');
		expect(second?.createdAt).toBeGreaterThan(later);
		conversation[Symbol.dispose]();
	});

	test('persists a finished streamed turn and reports send guards', async () => {
		const { messages, saved, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine, { model: () => null });
		await conversation.send('hello');
		await settle(conversation);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot().error?.code).toBe('NoModel');
	});

	test('a tool schema that is not an object fails the turn', async () => {
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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
		const { messages, saved, settle } = await makeMessages();
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
		const { messages, saved, settle } = await makeMessages();
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

	test('a failed stream saves nothing of its answer', async () => {
		const { messages, saved, settle } = await makeMessages();
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
		expect(idsOf(await saved())).toEqual(['m1']);
	});

	test('a tool that rejects ends the turn and leaves the conversation usable', async () => {
		const { messages, saved, settle } = await makeMessages();
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
		const { messages, files } = await makeMessages();
		const conversation = open(messages, () => streamOf([]));
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
		const { messages, files } = await makeMessages();
		await files.write(`messages/${CHAT}/broken.md`, '---\nrole: user\n---\n');
		await files.write('messages/other/elsewhere.md', '---\nrole: user\n---\n');
		const conversation = open(messages, () => streamOf([]));
		const { unreadable } = conversation.snapshot();
		expect(unreadable.map(({ path }) => path)).toEqual([
			`messages/${CHAT}/broken.md`,
		]);
		expect(unreadable[0]?.reason.length).toBeGreaterThan(0);
		expect(conversation.snapshot().messages).toEqual([]);
		conversation[Symbol.dispose]();
	});

	test('every assistant message rendered live persists after a clean finish', async () => {
		const { messages, saved, settle } = await makeMessages();
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
		const { messages, settle } = await makeMessages();
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

describe('a waiting message', () => {
	test('the model is asked only once the message landed', async () => {
		const { messages, files, saved, settle } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		expectOk(await conversation.send('hello'));
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1']);
		await Bun.sleep(20);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot()).toMatchObject({
			isGenerating: true,
			isThinking: true,
		});

		release();
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		conversation[Symbol.dispose]();
	});

	test('a folder that closes while the message waits ends the turn with FolderClosed, asking nothing', async () => {
		const { folder, messages, files } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		files.refuse('disk full');
		expectOk(await conversation.send('hello'));
		await until(() => folder.unavailable() !== null);
		folder[Symbol.dispose]();
		await until(() => !conversation.snapshot().isGenerating);
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot().error).toMatchObject({
			code: 'FolderClosed',
		});
		conversation[Symbol.dispose]();
	});

	test('a stop while the message waits ends the turn with no model call; the message still lands, and a retry runs', async () => {
		const { messages, files, saved, settle } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		expectOk(await conversation.send('hello'));
		await conversation.stop();
		expect(prompts).toHaveLength(0);
		expect(conversation.snapshot()).toMatchObject({
			isGenerating: false,
			error: null,
		});

		release();
		await until(() => files.read(pathOf('m1')) !== null);
		await conversation.retry();
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		await settle(conversation);
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		conversation[Symbol.dispose]();
	});
});

describe('learner message', () => {
	test('sent while writes cannot land, it shows at once; once they can it lands, the model answers, and the next message queues behind the answer', async () => {
		const { folder, messages, files, saved, attempts, settle } =
			await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const landed: string[] = [];
		const stopHearing = folder.messages.subscribe(() => {
			for (const { id } of folder.messages.items())
				if (!landed.includes(id)) landed.push(id);
		});
		const writable = files.refuse('disk full');
		expectOk(await conversation.send('hello'));
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1']);
		await until(() => folder.unavailable() !== null);
		expect(prompts).toHaveLength(0);
		expect(files.paths('messages')).toEqual([]);
		expect(folder.saving()).toBe(true);

		writable();
		await until(() => !conversation.snapshot().isGenerating);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		expect(conversation.snapshot().error).toBeNull();

		// The next message queues behind the answer, and is asked once both landed.
		expectOk(await conversation.send('another'));
		await settle(conversation);
		stopHearing();
		expect(prompts[1]?.map(({ content }) => content)).toEqual([
			'hello',
			'answer',
			'another',
		]);
		expect(landed).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(attempts).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(
			(await saved()).map(
				(message) => `${message.role}:${agentMessageText(message)}`,
			),
		).toEqual([
			'user:hello',
			'assistant:answer',
			'user:another',
			'assistant:answer',
		]);
		expect(prompts).toHaveLength(2);
	});

	test('overlapping sends and retries admit exactly one', async () => {
		const { messages, files, saved, attempts, settle } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		const first = conversation.send('first');
		const second = conversation.send('second');
		conversation.retry();
		expect(expectErr(await second)).toMatchObject({ reason: 'busy' });
		expectOk(await first);

		release();
		await settle(conversation);
		expect(prompts).toHaveLength(1);
		expect(attempts).toEqual(['m1', 'm2']);
		expect((await saved()).map((message) => agentMessageText(message))).toEqual(
			['first', 'answer'],
		);
	});

	test('disposal while the message waits lets it land and starts no model turn', async () => {
		const { folder, messages, files, saved } = await makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const release = files.hold();
		expectOk(await conversation.send('hello'));
		conversation[Symbol.dispose]();

		release();
		await until(() => !folder.saving());
		expect(idsOf(await saved())).toEqual(['m1']);
		expect(prompts).toHaveLength(0);
		expect(expectErr(await conversation.send('later'))).toMatchObject({
			reason: 'disposed',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
	});
});

describe('received answer', () => {
	test('a fully received answer waits for its writes under the same ids, and lands without the model or a tool running again', async () => {
		const { folder, messages, files, saved, attempts, settle } = await makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		// The learner message lands; every write after the model starts is refused.
		let writable: (() => void) | undefined;
		const conversation = open(
			messages,
			async function* (request, signal) {
				if (writable === undefined) {
					await until(() => files.read(pathOf('m1')) !== null);
					writable = files.refuse('disk full');
				}
				yield* engine(request, signal);
			},
			{ tools },
		);
		expectOk(await conversation.send('time?'));
		await until(() => !conversation.snapshot().isGenerating);
		expect(counts).toEqual({ engine: 2, tool: 1 });
		const waiting = conversation.snapshot();
		expect(waiting.error).toBeNull();
		expect(idsOf(waiting.messages)).toEqual(['m1', 'm2', 'm3']);
		expect(folder.saving()).toBe(true);
		expect(idsOf(await saved())).toEqual(['m1']);
		const received = waiting.messages.slice(1);

		writable?.();
		await settle(conversation);
		// One write per message: the folder tries again, not the conversation.
		expect(attempts).toEqual(['m1', 'm2', 'm3']);
		expect(counts).toEqual({ engine: 2, tool: 1 });
		expect(await saved()).toEqual([
			expect.objectContaining({ id: 'm1' }),
			...received,
		]);
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1', 'm2', 'm3']);
	});

	test('stop does not discard a fully received answer that is waiting for the folder, and does not wait for it to land', async () => {
		const { folder, messages, files, saved } = await makeMessages();
		const { engine: answer, prompts } = answering();
		// Every write after the question landed waits.
		let release = () => {};
		const conversation = open(messages, (request, signal) => {
			release = files.hold();
			return answer(request, signal);
		});
		expectOk(await conversation.send('hello'));
		await until(
			() => prompts.length === 1 && !conversation.snapshot().isGenerating,
		);
		expect(folder.saving()).toBe(true);
		await conversation.stop();
		expect(folder.saving()).toBe(true);
		expect(idsOf(conversation.snapshot().messages)).toEqual(['m1', 'm2']);

		release();
		await until(() => !folder.saving());
		expect(idsOf(await saved())).toEqual(['m1', 'm2']);
		expect(prompts).toHaveLength(1);
	});

	test('disposal while an answer is being written lets every handed-over write land', async () => {
		const { folder, messages, files, saved } = await makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		// Every write after the question landed waits.
		let release: (() => void) | undefined;
		const conversation = open(
			messages,
			(request, signal) => {
				release ??= files.hold();
				return engine(request, signal);
			},
			{ tools },
		);
		expectOk(await conversation.send('time?'));
		await until(
			() => counts.engine === 2 && !conversation.snapshot().isGenerating,
		);
		conversation[Symbol.dispose]();
		release?.();
		await until(() => !folder.saving());
		expect(idsOf(await saved())).toEqual(['m1', 'm2', 'm3']);
	});
});
