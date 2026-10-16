/**
 * Agent Conversation Loop Tests
 *
 * Verifies streaming, persistence, tool steps, approval, aborts, and the
 * injected message-store lifecycle without a concrete document implementation.
 *
 * Key behaviors:
 * - Finished turns persist while aborted or failed turns do not
 * - Tool calls resolve sequentially and re-enter the next prompt
 * - Store observation and disposal are owned by the injected seam
 * - A learner message is confirmed saved before the model is asked anything
 * - A fully received answer survives a failed write under the same ids, and
 *   saving it again runs neither the model nor a tool
 */
import { describe, expect, test } from 'bun:test';
import type { AgentEngine, EngineChunk } from '@epicenter/agent-protocol';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type AgentMessageStore,
	AgentMessageStoreError,
	createConversation,
} from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
	type ModelMessage,
} from './message.js';
import type { ToolCatalog } from './tools.js';

/**
 * A store whose writes a test can hold open, refuse, or blow up. `values` is
 * what a reopened conversation would read; `attempts` is every write asked for.
 */
function makeStore(initial: AgentMessage[] = []) {
	const values = new Map(initial.map((message) => [message.id, message]));
	const observers = new Set<() => void>();
	const attempts: string[] = [];
	let disposed = false;
	const control = {
		/** Each write waits on the next gate before the store answers. */
		gates: [] as PromiseWithResolvers<void>[],
		/** Keys the store answers `WriteFailed` for. */
		refuses: (_key: string) => false,
		/** Throw instead of answering. */
		throws: false,
		/** Show the message to readers before confirming it, as a live document does. */
		announcesEarly: false,
	};
	const put = (key: string, value: AgentMessage) => {
		values.set(key, value);
		for (const observer of observers) observer();
	};
	const store: AgentMessageStore = {
		async set(key, value) {
			if (disposed) throw new Error('store written after disposal');
			attempts.push(key);
			if (control.announcesEarly) put(key, value);
			await control.gates.shift()?.promise;
			if (disposed) throw new Error('store written after disposal');
			if (control.throws) throw new Error('store exploded');
			if (control.refuses(key)) {
				return AgentMessageStoreError.WriteFailed({
					cause: new Error('disk full'),
				});
			}
			if (!control.announcesEarly) put(key, value);
			return Ok(undefined);
		},
		entries: () => values.entries().map(([key, val]) => ({ key, val })),
		observe(handler) {
			observers.add(handler);
			return () => observers.delete(handler);
		},
		[Symbol.dispose]() {
			disposed = true;
			observers.clear();
		},
	};
	return {
		store,
		values,
		observers,
		attempts,
		control,
		isDisposed: () => disposed,
	};
}

/** Hold the store's next write open until the returned gate resolves. */
function holdNextWrite(control: ReturnType<typeof makeStore>['control']) {
	const gate = Promise.withResolvers<void>();
	control.gates.push(gate);
	return gate;
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

/** A counted engine that answers every prompt with one line of text. */
function answering(text = 'answer') {
	const prompts: ModelMessage[][] = [];
	const engine: AgentEngine = (request: { messages: ModelMessage[] }) => {
		prompts.push(request.messages);
		return streamOf([{ type: 'text-delta', delta: text }]);
	};
	return { engine, prompts };
}

/** A tool step followed by a final answer: two assistant messages per turn. */
function toolThenAnswer() {
	const counts = { engine: 0, tool: 0 };
	const engine: AgentEngine = () =>
		++counts.engine === 1
			? streamOf([
					{ type: 'tool-call', toolCallId: 't1', toolName: 'time', input: {} },
				])
			: streamOf([{ type: 'text-delta', delta: 'noon' }]);
	const tools: ToolCatalog = {
		definitions: () => [{ name: 'time', kind: 'query' }],
		resolve: async () => {
			counts.tool++;
			return { content: '12:00', isError: false };
		},
	};
	return { engine, tools, counts };
}

describe('createConversation', () => {
	test('assigns ordered timestamps that preserve rapid turns after reopening', async () => {
		const { store } = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'answer' }]);
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		const reopened = createConversation({ store, engine, generateId: ids() });
		expect(
			reopened.snapshot().messages.map((message) => agentMessageText(message)),
		).toEqual(['first', 'answer', 'second', 'answer']);
		reopened[Symbol.dispose]();
	});

	test('persists a finished streamed turn and reports send guards', async () => {
		const { store, values } = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				{ type: 'text-delta', delta: 'Hello' },
				{ type: 'text-delta', delta: ' world' },
			]);
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		expect(assistant).toBeDefined();
		if (assistant === undefined) throw new Error('missing assistant message');
		expect(agentMessageText(assistant)).toBe('Hello world');
		expect(values.size).toBe(2);
	});

	test('streaming snapshots use fresh identities and settle into messages', async () => {
		const { store } = makeStore();
		const engine: AgentEngine = () =>
			streamOf([
				{ type: 'text-delta', delta: 'one' },
				{ type: 'text-delta', delta: ' two' },
			]);
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		const { store } = makeStore();
		const prompts: ModelMessage[][] = [];
		let step = 0;
		const engine: AgentEngine = (request: { messages: ModelMessage[] }) => {
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
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'time', kind: 'query' }],
			resolve: async () => ({ content: '12:00', isError: false }),
		};
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
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

	test('later turns never prompt with the empty assistant being filled', async () => {
		const { store } = makeStore();
		const { engine, prompts } = answering('ok');
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		const { store } = makeStore();
		let step = 0;
		const engine: AgentEngine = () =>
			++step === 1
				? streamOf([
						{ type: 'tool-call', toolCallId: '1', toolName: 'a', input: {} },
						{ type: 'tool-call', toolCallId: '2', toolName: 'b', input: {} },
					])
				: streamOf([{ type: 'text-delta', delta: 'done' }]);
		const order: string[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const tools: ToolCatalog = {
			definitions: () => [
				{ name: 'a', kind: 'query' },
				{ name: 'b', kind: 'query' },
			],
			resolve: async (call) => {
				order.push(call.toolName);
				if (call.toolName === 'a') {
					started.resolve();
					await release.promise;
				}
				return { content: call.toolName, isError: false };
			},
		};
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
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

	test('declined mutations record denial without invoking the catalog', async () => {
		const { store } = makeStore();
		let step = 0;
		let resolved = false;
		const engine: AgentEngine = () =>
			++step === 1
				? streamOf([
						{
							type: 'tool-call',
							toolCallId: '1',
							toolName: 'delete',
							input: {},
						},
					])
				: streamOf([{ type: 'text-delta', delta: 'kept' }]);
		const conversation = createConversation({
			store,
			engine,
			tools: {
				definitions: () => [{ name: 'delete', kind: 'mutation' }],
				resolve: async () => {
					resolved = true;
					return { content: 'deleted', isError: false };
				},
			},
			approval: { decide: () => 'ask', request: async () => false },
			generateId: ids(),
		});
		await conversation.send('delete');
		await settle(conversation);
		expect(resolved).toBe(false);
		expect(conversation.snapshot().messages[1]?.parts.at(-1)).toMatchObject({
			type: 'tool-result',
			isError: true,
		});
	});

	test('aborting drops the partial assistant and retry starts another turn', async () => {
		const { store, values } = makeStore();
		const streamed = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const engine: AgentEngine = async function* () {
			yield { type: 'text-delta', delta: 'partial' };
			streamed.resolve();
			await release.promise;
		};
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		try {
			await conversation.send('go');
			await streamed.promise;
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
		const { store, values } = makeStore();
		let calls = 0;
		const engine: AgentEngine = () => {
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
		const tools: ToolCatalog = {
			definitions: () => [{ name: 'loop', kind: 'query' }],
			resolve: async () => ({ content: 'again', isError: false }),
		};
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
		});
		await conversation.send('go');
		await settle(conversation);
		expect(calls).toBe(50);
		expect(conversation.snapshot().error?.code).toBe('MaxStepsExceeded');
		expect(values.size).toBe(1);
	});

	test('a failed stream saves nothing and leaves no unsaved answer', async () => {
		const { store, values } = makeStore();
		const conversation = createConversation({
			store,
			engine: () =>
				streamOf([
					{ type: 'text-delta', delta: 'half an ans' },
					{ type: 'run-error', message: 'provider unavailable' },
				]),
			generateId: ids(),
		});
		await conversation.send('go');
		await settle(conversation);
		const snapshot = conversation.snapshot();
		expect(snapshot.error?.message).toBe('provider unavailable');
		expect(snapshot.saveError).toBeNull();
		expect(snapshot.unsaved).toEqual([]);
		expect([...values.keys()]).toEqual(['m1']);
	});

	test('a tool catalog that rejects ends the turn and leaves the conversation usable', async () => {
		const { store, values } = makeStore();
		let step = 0;
		const engine: AgentEngine = () =>
			++step === 1
				? streamOf([
						{ type: 'tool-call', toolCallId: '1', toolName: 'a', input: {} },
					])
				: streamOf([{ type: 'text-delta', delta: 'recovered' }]);
		const conversation = createConversation({
			store,
			engine,
			tools: {
				definitions: () => [{ name: 'a', kind: 'query' }],
				resolve: async () => {
					throw new Error('catalog went away');
				},
			},
			generateId: ids(),
		});
		await conversation.send('go');
		await settle(conversation);
		expect(conversation.snapshot().error?.message).toBe('catalog went away');
		expect([...values.keys()]).toEqual(['m1']);
		conversation.retry();
		await settle(conversation);
		expect(conversation.snapshot().error).toBeNull();
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['user', 'assistant']);
	});

	test('store changes refresh the snapshot and disposal tears down the seam', async () => {
		const { store, observers, isDisposed } = makeStore();
		const conversation = createConversation({
			store,
			engine: () => streamOf([]),
			generateId: ids(),
		});
		await store.set('external', {
			id: 'external',
			role: 'user',
			createdAt: 1,
			parts: [{ type: 'text', text: 'external' }],
		});
		expect(conversation.snapshot().messages[0]?.id).toBe('external');
		expect(observers.size).toBe(1);
		conversation[Symbol.dispose]();
		expect(observers.size).toBe(0);
		expect(isDisposed()).toBe(true);
	});

	test('every assistant message rendered live persists after a clean finish', async () => {
		const { store, values } = makeStore();
		const conversation = createConversation({
			store,
			engine: () => streamOf([{ type: 'text-delta', delta: 'visible' }]),
			generateId: ids(),
		});
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
	test('the model is asked nothing until the store confirms the learner message', async () => {
		const { store, values, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		const { store, values, attempts, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		control.refuses = () => true;
		const failure = expectErr(await conversation.send('hello'));
		expect(failure.name).toBe('WriteFailed');
		expect(failure).toMatchObject({ cause: new Error('disk full') });
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
		const { store, values, attempts, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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
		const { store, values, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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

	test('disposal during a pending learner write keeps the store usable until the write lands and starts no model turn', async () => {
		const { store, values, control, isDisposed } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		const gate = holdNextWrite(control);
		const sent = conversation.send('hello');
		conversation[Symbol.dispose]();
		expect(isDisposed()).toBe(false);

		gate.resolve();
		expectOk(await sent);
		await tick();
		expect([...values.keys()]).toEqual(['m1']);
		expect(isDisposed()).toBe(true);
		expect(prompts).toHaveLength(0);
		expect(expectErr(await conversation.send('later'))).toMatchObject({
			reason: 'disposed',
		});
		conversation.retry();
		await tick();
		expect(prompts).toHaveLength(0);
	});

	test('a store that throws is reported with its cause, keeps the message, and leaves no unhandled rejection', async () => {
		const { store, values, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		control.throws = true;
		const failure = expectErr(await conversation.send('hello'));
		expect(failure).toMatchObject({
			name: 'Threw',
			cause: new Error('store exploded'),
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
});

describe('received answer publication', () => {
	test('a fully received answer survives a refused write under the same ids and saves again without the model or a tool', async () => {
		const { store, values, attempts, control } = makeStore();
		const { engine, tools, counts } = toolThenAnswer();
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
		});
		control.refuses = (key) => key !== 'm1';
		await conversation.send('time?');
		await settle(conversation);
		expect(counts).toEqual({ engine: 2, tool: 1 });
		const failed = conversation.snapshot();
		expect(failed.error).toBeNull();
		expect(failed.saveError).toMatchObject({
			name: 'WriteFailed',
			cause: new Error('disk full'),
		});
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
		// One attempt only: the loop never re-asks a store on its own.
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
		const { store, values, attempts, control } = makeStore();
		const { engine, tools, counts } = toolThenAnswer();
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
		});
		control.refuses = (key) => key === 'm3';
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

	test('a store that shows a message before confirming it never renders that message twice', async () => {
		const { store, control } = makeStore();
		const { engine } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
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

	test('stop does not discard a fully received answer that is waiting for the store', async () => {
		const { store, values, control } = makeStore();
		const { engine, prompts } = answering();
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		await conversation.send('hello');
		// The learner write is done; hold the answer's write open.
		const gate = holdNextWrite(control);
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

	test('disposal while an answer is being written lets every admitted write land before the store is disposed', async () => {
		const { store, values, control, isDisposed } = makeStore();
		const { engine, tools } = toolThenAnswer();
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
		});
		await conversation.send('time?');
		const gate = holdNextWrite(control);
		await tick();
		expect(conversation.snapshot().isSaving).toBe(true);
		conversation[Symbol.dispose]();
		expect(isDisposed()).toBe(false);
		gate.resolve();
		await tick();
		expect([...values.keys()]).toEqual(['m1', 'm2', 'm3']);
		expect(isDisposed()).toBe(true);
	});
});
