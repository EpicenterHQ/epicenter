import { expect, test } from 'bun:test';
import { type AgentEngineRequest, createConversation } from '@epicenter/agent';
import { openMemory } from '@epicenter/app/memory';
import { chatHistoryDefinition } from '../data.js';
import { createChatMessageStore } from './messages.js';
import { withTutorOpening } from './opening.js';

test('empty tutor opening supplies model content without storing a learner message or restarting on remount', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	const requests: AgentEngineRequest[] = [];
	const engine = withTutorOpening(async function* (request) {
		requests.push(request);
		yield { type: 'text-delta', delta: 'Welcome!' };
	});
	const options = () => ({
		store: createChatMessageStore(db.tables.messages, 'account-a', 'chat-a'),
		engine,
		generateId: () => crypto.randomUUID(),
	});
	const chat = createConversation(options());
	chat.retry();
	await Bun.sleep(10);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.messages).toEqual([
		{ role: 'user', content: 'Begin our conversation.' },
	]);
	expect(
		db.tables.messages.rows.map(
			(row) => (row.message as { role: string }).role,
		),
	).toEqual(['assistant']);
	chat[Symbol.dispose]();
	const reopened = createConversation(options());
	await Bun.sleep(10);
	expect(requests).toHaveLength(1);
	reopened[Symbol.dispose]();
});

test('stopped opening saves no partial answer and retries from empty history', async () => {
	await using db = await openMemory(chatHistoryDefinition);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const engine = withTutorOpening(async function* (_request, signal) {
		calls++;
		if (calls === 1) {
			yield { type: 'text-delta', delta: 'Partial' };
			await blocked;
			if (signal.aborted) return;
		} else {
			yield { type: 'text-delta', delta: 'Welcome!' };
		}
	});
	const options = () => ({
		store: createChatMessageStore(db.tables.messages, 'account-a', 'chat-a'),
		engine,
		generateId: () => crypto.randomUUID(),
	});
	const first = createConversation(options());
	first.retry();
	await Bun.sleep(0);
	first.stop();
	release();
	await Bun.sleep(0);
	expect(db.tables.messages.rows).toEqual([]);
	first[Symbol.dispose]();
	const reopened = createConversation(options());
	reopened.retry();
	await Bun.sleep(0);
	expect(calls).toBe(2);
	expect(reopened.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	reopened[Symbol.dispose]();
});
