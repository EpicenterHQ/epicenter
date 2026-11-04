/**
 * Agent Conversation Loop Tests
 *
 * The loop over a stand-in messages collection (a `NoteClient` of
 * `messagesCollection` whose writes a test can hold open, refuse, or blow
 * up) and a stand-in `ai` whose `chat` streams what each test's engine says.
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
 * - Disposal stops following the collection; writes in flight still land
 */
import { describe, expect, test } from 'bun:test';
import { ClientError, type NoteClient } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { AiError, type ChatChunk, type ChatRequest } from '../client.js';
import type { Ai } from '../open-ai.js';
import { createConversation } from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
	type MessageNote,
	type MessagesCollection,
} from './message.js';
import type { EngineChunk } from './stream.js';
import type { AgentTool } from './tools.js';

const CHAT = 'chat-a';

/** A note of `message` in this chat. */
const noteOf = (message: AgentMessage): MessageNote =>
	({
		chat: CHAT,
		...structuredClone(message),
		body: '',
		version: `v-${message.id}`,
	}) as unknown as MessageNote;

/**
 * A messages collection whose writes a test can hold open, refuse, or blow
 * up. `values` is what a reopened conversation would list; `attempts` is
 * every write asked for.
 */
function makeMessages(initial: AgentMessage[] = []) {
	const values = new Map(initial.map((message) => [message.id, message]));
	const observers = new Set<() => void>();
	const attempts: string[] = [];
	const invalid: unknown[] = [];
	const control = {
		/** Each write waits on the next gate before the collection answers. */
		gates: [] as PromiseWithResolvers<void>[],
		/** Ids the collection refuses, `Unavailable`. */
		refuses: (_id: string) => false,
		/** Throw instead of answering. */
		throws: false,
		/** List the message before confirming it, as a live folder does. */
		announcesEarly: false,
	};
	const put = (message: AgentMessage) => {
		values.set(message.id, message);
		for (const observer of observers) observer();
	};
	const messages = {
		fieldNames: ['role', 'createdAt', 'parts'],
		async list() {
			return Ok({ items: [...values.values()].map(noteOf), invalid });
		},
		async get({ id }: { chat: string; id: string }) {
			const message = values.get(id);
			return message
				? Ok(noteOf(message))
				: ClientError.NotFound({ path: `messages/${CHAT}/${id}.md` });
		},
		async create(value: MessageNote) {
			const { chat: _chat, body: _body, ...rest } = value;
			const message = rest as unknown as AgentMessage;
			attempts.push(message.id);
			if (values.has(message.id) && !control.announcesEarly)
				return ClientError.Occupied({
					path: `messages/${CHAT}/${message.id}.md`,
				});
			if (control.announcesEarly) put(message);
			await control.gates.shift()?.promise;
			if (control.throws) throw new Error('collection exploded');
			if (control.refuses(message.id))
				return ClientError.Unavailable({ cause: new Error('disk full') });
			if (!control.announcesEarly) put(message);
			return Ok(noteOf(message));
		},
		subscribe(handler: () => void) {
			observers.add(handler);
			return () => {
				observers.delete(handler);
			};
		},
	} as unknown as NoteClient<MessagesCollection>;
	return { messages, values, observers, attempts, control, invalid, put };
}

/** Hold the collection's next write open until the returned gate resolves. */
function holdNextWrite(control: ReturnType<typeof makeMessages>['control']) {
	const gate = Promise.withResolvers<void>();
	control.gates.push(gate);
	return gate;
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

async function settle(handle: {
	snapshot(): { isGenerating: boolean; isSaving: boolean };
}) {
	const isActive = () =>
		handle.snapshot().isGenerating || handle.snapshot().isSaving;
	for (let count = 0; count < 200 && isActive(); count++) await tick();
}

/** A conversation over `messages` and `engine`, with its options beside. */
function open(
	messages: NoteClient<MessagesCollection>,
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

	test('persists a finished streamed turn and reports send guards', async () => {
		const { messages, values } = makeMessages();
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
		expect(values.size).toBe(2);
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
		const { messages, values } = makeMessages();
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
			expect(values.size).toBe(1);
			conversation.retry();
			await settle(conversation);
			expect(conversation.snapshot().messages).toHaveLength(2);
		} finally {
			release.resolve();
			conversation[Symbol.dispose]();
		}
	});

	test('runaway tool loops stop after 50 steps without persisting the turn', async () => {
		const { messages, values } = makeMessages();
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
		expect(values.size).toBe(1);
	});

	test('a failed stream saves nothing and leaves no unsaved answer', async () => {
		const { messages, values } = makeMessages();
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
		expect([...values.keys()]).toEqual(['m1']);
	});

	test('a tool that rejects ends the turn and leaves the conversation usable', async () => {
		const { messages, values } = makeMessages();
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
		expect([...values.keys()]).toEqual(['m1']);
		conversation.retry();
		await settle(conversation);
		expect(conversation.snapshot().error).toBeNull();
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['user', 'assistant']);
	});

	test('a change to the collection refreshes the snapshot, and disposal stops following it', async () => {
		const { messages, observers, put } = makeMessages();
		const conversation = open(messages, () => streamOf([]));
		await conversation.ready;
		put({
			id: 'external',
			role: 'user',
			createdAt: 1,
			parts: [{ type: 'text', text: 'external' }],
		});
		await tick();
		expect(conversation.snapshot().messages[0]?.id).toBe('external');
		expect(observers.size).toBe(1);
		conversation[Symbol.dispose]();
		expect(observers.size).toBe(0);
	});

	test("a note of this chat that does not read is listed as unreadable, and another chat's are not", async () => {
		const { messages, invalid } = makeMessages();
		invalid.push(
			{
				chat: CHAT,
				id: 'broken',
				path: `messages/${CHAT}/broken.md`,
				issues: [{ message: 'role is missing.' }],
			},
			{
				chat: 'other',
				id: 'elsewhere',
				path: 'messages/other/elsewhere.md',
				issues: [{ message: 'parts is missing.' }],
			},
		);
		const conversation = open(messages, () => streamOf([]));
		await conversation.ready;
		expect(conversation.snapshot().unreadable).toEqual([
			{ path: `messages/${CHAT}/broken.md`, reason: 'role is missing.' },
		]);
	});

	test('every assistant message rendered live persists after a clean finish', async () => {
		const { messages, values } = makeMessages();
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
		const persisted = new Set(
			[...values.values()]
				.filter((message) => message.role === 'assistant')
				.map((message) => message.id),
		);
		expect([...rendered]).toEqual([...persisted]);
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

describe('learner message publication', () => {
	test('the model is asked nothing until the collection confirms the learner message', async () => {
		const { messages, values, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const gate = holdNextWrite(control);
		const sent = conversation.send('hello');
		await tick();
		expect(prompts).toHaveLength(0);
		expect(values.size).toBe(0);
		expect(conversation.snapshot()).toMatchObject({
			isSaving: true,
			isGenerating: false,
		});
		expect(
			conversation.snapshot().messages.map((message) => message.id),
		).toEqual(['m1']);

		gate.resolve();
		expectOk(await sent);
		await settle(conversation);
		expect(prompts).toEqual([[{ role: 'user', content: 'hello' }]]);
		expect([...values.keys()]).toEqual(['m1', 'm2']);
		expect(conversation.snapshot().unsaved).toEqual([]);
	});

	test('a refused learner write asks no model, keeps the message under its id, and saves again without a model call', async () => {
		const { messages, values, attempts, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		control.refuses = () => true;
		const failure = expectErr(await conversation.send('hello'));
		expect(failure.name).toBe('WriteFailed');
		expect(failure).toMatchObject({ cause: { name: 'Unavailable' } });
		await tick();
		expect(prompts).toHaveLength(0);
		expect(values.size).toBe(0);
		const failed = conversation.snapshot();
		expect<unknown>(failed.saveError).toBe(failure);
		expect(failed.isSaving).toBe(false);
		expect(failed.unsaved.map((message) => message.id)).toEqual(['m1']);
		expect(failed.messages.map((message) => message.id)).toEqual(['m1']);

		// Nothing new starts while the learner message is unsaved.
		expect(expectErr(await conversation.send('another'))).toMatchObject({
			reason: 'unsaved',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
		expect(attempts).toEqual(['m1']);

		control.refuses = () => false;
		expectOk(await conversation.save());
		await tick();
		expect(attempts).toEqual(['m1', 'm1']);
		expect([...values.keys()]).toEqual(['m1']);
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
		const { messages, values, attempts, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const gate = holdNextWrite(control);
		const first = conversation.send('first');
		const second = conversation.send('second');
		conversation.retry();
		const save = conversation.save();
		expect(expectErr(await second)).toMatchObject({ reason: 'busy' });
		expect(expectErr(await save)).toMatchObject({ reason: 'busy' });
		await tick();
		expect(prompts).toHaveLength(0);

		gate.resolve();
		expectOk(await first);
		await settle(conversation);
		expect(prompts).toHaveLength(1);
		expect(attempts).toEqual(['m1', 'm2']);
		expect(
			[...values.values()].map((message) => agentMessageText(message)),
		).toEqual(['first', 'answer']);
	});

	test('stop during a pending learner write lets the write finish and starts no model turn', async () => {
		const { messages, values, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const gate = holdNextWrite(control);
		const sent = conversation.send('hello');
		conversation.stop();
		gate.resolve();
		expectOk(await sent);
		await tick();
		expect(prompts).toHaveLength(0);
		expect([...values.keys()]).toEqual(['m1']);
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
		const { messages, values, control, observers } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		const gate = holdNextWrite(control);
		const sent = conversation.send('hello');
		await tick();
		conversation[Symbol.dispose]();
		expect(observers.size).toBe(0);

		gate.resolve();
		expectOk(await sent);
		await tick();
		expect([...values.keys()]).toEqual(['m1']);
		expect(prompts).toHaveLength(0);
		expect(expectErr(await conversation.send('later'))).toMatchObject({
			reason: 'disposed',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
	});

	test('a collection that throws is reported with its cause, keeps the message, and leaves no unhandled rejection', async () => {
		const { messages, values, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		control.throws = true;
		const failure = expectErr(await conversation.send('hello'));
		expect(failure).toMatchObject({
			name: 'Threw',
			cause: new Error('collection exploded'),
		});
		await tick();
		expect(prompts).toHaveLength(0);
		expect(
			conversation.snapshot().unsaved.map((message) => message.id),
		).toEqual(['m1']);

		control.throws = false;
		expectOk(await conversation.save());
		expect([...values.keys()]).toEqual(['m1']);
	});

	test('a note already holding the message counts as saved; another message at its id is refused', async () => {
		const { messages, put } = makeMessages();
		const { engine } = answering();
		let next = 0;
		const conversation = open(messages, engine, {
			generateId: () => (next++ === 0 ? 'taken' : `m${next}`),
		});
		await conversation.ready;
		put({
			id: 'taken',
			role: 'user',
			createdAt: 1,
			parts: [{ type: 'text', text: 'someone else' }],
		});
		const failure = expectErr(await conversation.send('mine'));
		expect(failure.name).toBe('WriteFailed');
		expect(failure.message).toContain(
			`Another message is already saved at 'messages/${CHAT}/taken.md'`,
		);
	});
});

describe('received answer publication', () => {
	test('a fully received answer survives a refused write under the same ids and saves again without the model or a tool', async () => {
		const { messages, values, attempts, control } = makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		const conversation = open(messages, engine, { tools });
		control.refuses = (id) => id !== 'm1';
		await conversation.send('time?');
		await settle(conversation);
		expect(counts).toEqual({ engine: 2, tool: 1 });
		const failed = conversation.snapshot();
		expect(failed.error).toBeNull();
		expect(failed.saveError).toMatchObject({ name: 'WriteFailed' });
		expect(failed.unsaved.map((message) => message.id)).toEqual(['m2', 'm3']);
		expect(failed.messages.map((message) => message.id)).toEqual([
			'm1',
			'm2',
			'm3',
		]);
		expect([...values.keys()]).toEqual(['m1']);
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

		control.refuses = () => false;
		expectOk(await conversation.save());
		expect(counts).toEqual({ engine: 2, tool: 1 });
		expect(attempts).toEqual(['m1', 'm2', 'm2', 'm3']);
		expect([...values.values()]).toEqual([
			expect.objectContaining({ id: 'm1' }),
			...received,
		]);
		expect(conversation.snapshot()).toMatchObject({
			unsaved: [],
			saveError: null,
		});
		expect(
			conversation.snapshot().messages.map((message) => message.id),
		).toEqual(['m1', 'm2', 'm3']);
	});

	test('a partly saved answer keeps only its unconfirmed message and never writes the confirmed one twice', async () => {
		const { messages, values, attempts, control } = makeMessages();
		const { engine, tools, counts } = toolThenAnswer();
		const conversation = open(messages, engine, { tools });
		control.refuses = (id) => id === 'm3';
		await conversation.send('time?');
		await settle(conversation);
		expect([...values.keys()]).toEqual(['m1', 'm2']);
		expect(
			conversation.snapshot().unsaved.map((message) => message.id),
		).toEqual(['m3']);
		expect(
			conversation.snapshot().messages.map((message) => message.id),
		).toEqual(['m1', 'm2', 'm3']);

		control.refuses = () => false;
		const gate = holdNextWrite(control);
		const saving = conversation.save();
		// The failure stays reported while the retry is in flight.
		expect(conversation.snapshot()).toMatchObject({
			isSaving: true,
			saveError: { name: 'WriteFailed' },
		});
		gate.resolve();
		expectOk(await saving);
		expect(conversation.snapshot().saveError).toBeNull();
		expect(attempts).toEqual(['m1', 'm2', 'm3', 'm3']);
		expect([...values.keys()]).toEqual(['m1', 'm2', 'm3']);
		expect(counts).toEqual({ engine: 2, tool: 1 });
	});

	test('a collection that lists a message before confirming it never renders that message twice', async () => {
		const { messages, control } = makeMessages();
		const { engine } = answering();
		const conversation = open(messages, engine);
		control.announcesEarly = true;
		const seen: string[][] = [];
		conversation.subscribe(() => {
			seen.push(conversation.snapshot().messages.map((message) => message.id));
		});
		const learnerGate = holdNextWrite(control);
		const answerGate = holdNextWrite(control);
		const sent = conversation.send('hello');
		await tick();
		expect(
			conversation.snapshot().unsaved.map((message) => message.id),
		).toEqual(['m1']);
		learnerGate.resolve();
		expectOk(await sent);
		await tick();
		expect(
			conversation.snapshot().unsaved.map((message) => message.id),
		).toEqual(['m2']);
		expect(
			conversation.snapshot().messages.map((message) => message.id),
		).toEqual(['m1', 'm2']);
		answerGate.resolve();
		await settle(conversation);

		expect(seen.length).toBeGreaterThan(0);
		for (const rendered of seen) {
			expect(rendered).toEqual([...new Set(rendered)]);
		}
		expect(
			conversation.snapshot().messages.map((message) => message.id),
		).toEqual(['m1', 'm2']);
	});

	test('stop does not discard a fully received answer that is waiting for the collection', async () => {
		const { messages, values, control } = makeMessages();
		const { engine, prompts } = answering();
		const conversation = open(messages, engine);
		await conversation.send('hello');
		// The learner write is done; hold the answer's write open.
		const gate = holdNextWrite(control);
		await tick();
		await tick();
		expect(conversation.snapshot()).toMatchObject({
			isGenerating: false,
			isSaving: true,
		});
		conversation.stop();
		gate.resolve();
		await settle(conversation);
		expect([...values.keys()]).toEqual(['m1', 'm2']);
		expect(conversation.snapshot().unsaved).toEqual([]);
		expect(prompts).toHaveLength(1);
	});

	test('disposal while an answer is being written lets every admitted write land', async () => {
		const { messages, values, control } = makeMessages();
		const { engine, tools } = toolThenAnswer();
		const conversation = open(messages, engine, { tools });
		await conversation.send('time?');
		const gate = holdNextWrite(control);
		for (
			let count = 0;
			count < 20 && !conversation.snapshot().isSaving;
			count++
		)
			await tick();
		expect(conversation.snapshot().isSaving).toBe(true);
		conversation[Symbol.dispose]();
		gate.resolve();
		await settle(conversation);
		expect([...values.keys()]).toEqual(['m1', 'm2', 'm3']);
	});
});
