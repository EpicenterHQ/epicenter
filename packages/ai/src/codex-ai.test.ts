/** Codex reply mapping isolates transcripts and certifies final-answer phases, including cancellation before acknowledgment. */
import { expect, test } from 'bun:test';
import { unwrap } from 'wellcrafted/result';
import {
	type CodexConnection,
	type CodexNotification,
	createCodexAi,
} from './codex-ai.js';
import type { ReplyEvent } from './reply.js';

const request = {
	instructions: 'Tutor',
	messages: [
		{ role: 'user' as const, content: '你好' },
		{ role: 'assistant' as const, content: 'Hello' },
	],
	signal: new AbortController().signal,
};
function setup(phase: string | null = 'final_answer', status = 'completed') {
	const lifetime = new AbortController();
	const listeners = new Set<(event: CodexNotification) => void>();
	const calls: { method: string; params: unknown }[] = [];
	let next = 0;
	let admitted = 0;
	const emit = (method: string, params: unknown) => {
		for (const listener of listeners) listener({ method, params });
	};
	const connection: CodexConnection = {
		signal: lifetime.signal,
		async request(method, params) {
			calls.push({ method, params });
			if (method === 'thread/start')
				return { thread: { id: `thread-${++next}`, ephemeral: true } };
			if (method === 'turn/start') {
				const threadId = (params as { threadId: string }).threadId;
				emit('item/completed', {
					threadId,
					item: {
						type: 'agentMessage',
						id: 'comment',
						phase: 'commentary',
						text: 'Private commentary',
					},
				});
				emit('item/started', {
					threadId,
					item: { type: 'agentMessage', id: 'answer', phase, text: '' },
				});
				emit('item/agentMessage/delta', {
					threadId,
					itemId: 'answer',
					delta: 'Answer',
				});
				emit('item/completed', {
					threadId,
					item: {
						type: 'agentMessage',
						id: 'answer',
						phase,
						text: 'Canonical answer',
					},
				});
				emit('turn/completed', { threadId, turn: { id: 'turn', status } });
				return { turn: { id: 'turn' } };
			}
			return {};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		admit() {
			admitted++;
			return () => {
				admitted--;
			};
		},
		async close() {
			lifetime.abort();
		},
	};
	return {
		connection,
		calls,
		emit,
		active: () => admitted,
		subscriptions: () => listeners.size,
	};
}
const outcome = (events: ReplyEvent[]) => {
	const last = events.at(-1);
	if (last?.type !== 'result') throw new Error('Missing outcome');
	return last.result;
};

test('reuses the connection but creates fresh threads with exact user and assistant roles', async () => {
	const { connection, calls, active, subscriptions } = setup();
	const ai = createCodexAi(connection, { model: 'chosen' });
	const first = await Array.fromAsync(ai.reply(request));
	expect(unwrap(outcome(first))).toBe('Canonical answer');
	expect(first.filter((event) => event.type === 'preview')).toEqual([
		{ type: 'preview', text: 'Canonical answer' },
	]);
	expect(
		unwrap(
			outcome(await Array.fromAsync(ai.reply({ ...request, messages: [] }))),
		),
	).toBe('Canonical answer');
	expect(calls.filter((call) => call.method === 'thread/start')).toHaveLength(
		2,
	);
	expect(
		calls.find((call) => call.method === 'thread/inject_items')?.params,
	).toEqual({
		threadId: 'thread-1',
		items: [
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: '你好' }],
			},
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'output_text', text: 'Hello' }],
			},
		],
	});
	expect(
		calls
			.filter((call) => call.method === 'turn/start')
			.map((call) => call.params),
	).toEqual([
		{ threadId: 'thread-1', input: [] },
		{ threadId: 'thread-2', input: [] },
	]);
	expect(
		calls.filter((call) => call.method === 'thread/unsubscribe'),
	).toHaveLength(2);
	expect(active()).toBe(0);
	expect(subscriptions()).toBe(0);
	expect(connection.signal.aborted).toBe(false);
});

for (const [phase, status] of [
	[null, 'completed'],
	['final_answer', 'failed'],
	['final_answer', 'interrupted'],
] as const)
	test(`does not certify phase ${phase} with status ${status}`, async () => {
		const { connection, active } = setup(phase, status);
		expect(
			outcome(
				await Array.fromAsync(
					createCodexAi(connection, { model: 'chosen' }).reply(request),
				),
			).error?.name,
		).toBe('Incomplete');
		expect(active()).toBe(0);
	});

test('cancellation before turn acknowledgment interrupts the eventual turn and cleans its subscription', async () => {
	const { connection, calls, emit, active, subscriptions } = setup();
	const start = Promise.withResolvers<void>();
	const acknowledgment = Promise.withResolvers<unknown>();
	const interruptionStarted = Promise.withResolvers<void>();
	const interrupted = Promise.withResolvers<void>();
	const previous = connection.request;
	connection.request = async (method, params) => {
		if (method === 'turn/interrupt') {
			const response = await previous(method, params);
			interruptionStarted.resolve();
			await interrupted.promise;
			return response;
		}
		if (method !== 'turn/start') return previous(method, params);
		start.resolve();
		return acknowledgment.promise;
	};
	const controller = new AbortController();
	const iterator = createCodexAi(connection, { model: 'chosen' }).reply({
		...request,
		signal: controller.signal,
	});
	const pending = iterator.next();
	await start.promise;
	controller.abort();
	expect((await pending).value).toMatchObject({
		type: 'result',
		result: { error: { name: 'Cancelled' } },
	});
	emit('turn/started', { threadId: 'thread-1', turn: { id: 'delayed' } });
	acknowledgment.resolve({ turn: { id: 'delayed' } });
	await interruptionStarted.promise;
	// A completion notification cannot release the attempt while interruption is pending.
	emit('turn/completed', {
		threadId: 'thread-1',
		turn: { id: 'delayed', status: 'interrupted' },
	});
	for (let i = 0; i < 20; i++) await Promise.resolve();
	expect(active()).toBe(1);
	expect(subscriptions()).toBe(1);
	expect(calls.some((call) => call.method === 'thread/unsubscribe')).toBe(
		false,
	);
	interrupted.resolve();
	for (let i = 0; i < 20 && active(); i++) await Promise.resolve();
	expect(calls.filter((call) => call.method === 'turn/interrupt')).toEqual([
		{
			method: 'turn/interrupt',
			params: { threadId: 'thread-1', turnId: 'delayed' },
		},
	]);
	expect(active()).toBe(0);
	expect(subscriptions()).toBe(0);
	expect(connection.signal.aborted).toBe(false);
});

test('closing the owner stops a reply waiting on notifications', async () => {
	const { connection, active } = setup();
	const started = Promise.withResolvers<void>();
	const previous = connection.request;
	connection.request = async (method, params) => {
		if (method !== 'turn/start') return previous(method, params);
		started.resolve();
		return { turn: { id: 'waiting' } };
	};
	const iterator = createCodexAi(connection, { model: 'chosen' }).reply(
		request,
	);
	const pending = iterator.next();
	await started.promise;
	await connection.close();
	expect((await pending).value).toMatchObject({
		type: 'result',
		result: { error: { name: 'Closed' } },
	});
	for (let i = 0; i < 20 && active(); i++) await Promise.resolve();
	expect(active()).toBe(0);
});
