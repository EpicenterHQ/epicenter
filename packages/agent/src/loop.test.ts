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
 */
import { describe, expect, test } from 'bun:test';
import type { AgentEngine, EngineChunk } from './engine.js';
import { type AgentMessageStore, createConversation } from './loop.js';
import {
	type AgentMessage,
	agentMessageText,
	isPersistableMessage,
	type ModelMessage,
} from './message.js';
import type { ToolCatalog } from './tools.js';

function makeStore(initial: AgentMessage[] = []) {
	const values = new Map(initial.map((message) => [message.id, message]));
	const observers = new Set<() => void>();
	let disposed = false;
	const store: AgentMessageStore = {
		set(key, value) {
			values.set(key, value);
			for (const observer of observers) observer();
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
	return { store, values, observers, isDisposed: () => disposed };
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

async function settle(handle: { snapshot(): { isGenerating: boolean } }) {
	for (let count = 0; count < 200 && handle.snapshot().isGenerating; count++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
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
		conversation.send('first');
		await settle(conversation);
		conversation.send('second');
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
		expect(conversation.send(' ')).toBe(false);
		expect(conversation.send('hi')).toBe(true);
		expect(conversation.send('again')).toBe(false);
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
		conversation.send('go');
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
		conversation.send('time?');
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
		const prompts: ModelMessage[][] = [];
		const engine: AgentEngine = (request: { messages: ModelMessage[] }) => {
			prompts.push(request.messages);
			return streamOf([{ type: 'text-delta', delta: 'ok' }]);
		};
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		conversation.send('one');
		await settle(conversation);
		conversation.send('two');
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
		const tools: ToolCatalog = {
			definitions: () => [
				{ name: 'a', kind: 'query' },
				{ name: 'b', kind: 'query' },
			],
			resolve: async (call) => {
				order.push(call.toolName);
				return { content: call.toolName, isError: false };
			},
		};
		const conversation = createConversation({
			store,
			engine,
			tools,
			generateId: ids(),
		});
		conversation.send('go');
		await settle(conversation);
		expect(order).toEqual(['a', 'b']);
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
		conversation.send('delete');
		await settle(conversation);
		expect(resolved).toBe(false);
		expect(conversation.snapshot().messages[1]?.parts.at(-1)).toMatchObject({
			type: 'tool-result',
			isError: true,
		});
	});

	test('aborting drops the partial assistant and retry starts another turn', async () => {
		const { store } = makeStore();
		const engine: AgentEngine = () =>
			streamOf([{ type: 'text-delta', delta: 'partial' }]);
		const conversation = createConversation({
			store,
			engine,
			generateId: ids(),
		});
		conversation.send('go');
		conversation.stop();
		await settle(conversation);
		expect(
			conversation.snapshot().messages.map((message) => message.role),
		).toEqual(['user']);
		conversation.retry();
		await settle(conversation);
		expect(conversation.snapshot().messages).toHaveLength(2);
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
		conversation.send('go');
		await settle(conversation);
		expect(calls).toBe(50);
		expect(conversation.snapshot().error?.code).toBe('MaxStepsExceeded');
		expect(values.size).toBe(1);
	});

	test('store changes refresh the snapshot and disposal tears down the seam', () => {
		const { store, observers, isDisposed } = makeStore();
		const conversation = createConversation({
			store,
			engine: () => streamOf([]),
			generateId: ids(),
		});
		store.set('external', {
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
		conversation.send('go');
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
