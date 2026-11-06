/**
 * The demo runs the real send owner over replies and a journal in memory,
 * so it shows the same steps live Beeper takes.
 *
 * Key behaviors:
 * - Saving a reply, draft or ready, adds nothing to the conversation
 * - Send selected sends a ready reply once, and the check that follows
 *   Beeper's report removes it
 * - A send with no answer waits for a person and holds back its chat
 */
import { expect, test } from 'bun:test';
import type {
	Message,
	MessagesAnswer,
	MessagesRequest,
	Reply,
} from '@epicenter/cli/messages-protocol';
import { createDemoBackend, DEMO_PROFILE } from './backend.js';

async function ask<K extends MessagesAnswer['kind']>(
	request: (r: MessagesRequest) => Promise<MessagesAnswer>,
	operation: MessagesRequest,
	kind: K,
) {
	const answer = await request(operation);
	if (answer.kind !== kind) throw new Error(JSON.stringify(answer));
	return answer as Extract<MessagesAnswer, { kind: K }>;
}

async function setup() {
	const demo = createDemoBackend();
	const request = demo.request;
	const save = async (id: string, body: string, status: 'draft' | 'ready') =>
		(
			await ask(
				request,
				{ action: 'save', id, chatId: 'demo-maya', chatTitle: 'Maya Chen', profile: DEMO_PROFILE, status, body },
				'saved',
			)
		).reply;
	const history = async (): Promise<Message[]> =>
		(await ask(request, { action: 'messages', chatId: 'demo-maya' }, 'messages'))
			.page.items;
	const replies = async () =>
		(await ask(request, { action: 'replies' }, 'replies')).replies;
	const send = async (...items: Reply[]) =>
		(
			await ask(
				request,
				{ action: 'send', items: items.map(({ id, version }) => ({ id, over: version })) },
				'sent',
			)
		).results.map((result) => result.outcome);
	return { demo, request, save, history, replies, send };
}

test('saving replies sends nothing, and Send selected sends a ready one once', async () => {
	const { request, save, history, replies, send } = await setup();
	const before = (await history()).length;
	await save('r1', 'A draft', 'draft');
	const ready = await save('r2', 'Ten works', 'ready');
	expect((await history()).length).toBe(before);

	expect(await send(ready)).toEqual(['accepted']);
	expect(await send(ready)).toEqual(['skipped']);
	expect((await history()).filter((message) => message.text === 'Ten works')).toHaveLength(1);
	expect(await ask(request, { action: 'check' }, 'checked')).toEqual({ kind: 'checked' });
	expect((await replies()).map((reply) => reply.id)).toEqual(['r1']);
});

test('a demo send with no answer waits for a person and holds back its chat', async () => {
	const { demo, request, save, history, replies, send } = await setup();
	const first = await save('r1', 'First', 'ready');
	const second = await save('r2', 'Second', 'ready');
	demo.failNext();
	expect(await send(first, second)).toEqual(['uncertain', 'skipped']);
	expect(await send(second)).toEqual(['skipped']);
	expect((await history()).some((message) => message.text === 'Second')).toBe(false);

	const attemptId = (await replies()).find((reply) => reply.id === 'r1')?.send?.attemptId;
	if (attemptId === undefined) throw new Error('No attempt');
	await ask(request, { action: 'resolve', attemptId, outcome: 'not-sent' }, 'resolved');
	expect(await send(second)).toEqual(['accepted']);
});
