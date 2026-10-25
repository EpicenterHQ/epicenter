/**
 * Tutor opening tests.
 * Real conversations over Vocab's real browser folder add a transient opening
 * prompt without saving a learner turn, do not repeat on remount, and discard
 * a stopped partial opening before retry.
 */
import { expect, test } from 'bun:test';
import { type AgentEngineRequest, createConversation } from '@epicenter/agent';
import { expectOk } from 'wellcrafted/testing';
import type { VocabFolder } from '../data.js';
import { createBrowser, settle, tableFiles } from '../folder.test-support.js';
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';

const { createChatMessageStore } = await import('./messages.svelte.js');

import { withTutorOpening } from './opening.js';

/** A conversation over the chat's saved transcript, as a mounted view has it. */
async function open(
	folder: VocabFolder,
	engine: Parameters<typeof withTutorOpening>[0],
) {
	const store = createChatMessageStore(folder, 'chat-a');
	return createConversation({
		store,
		engine: withTutorOpening(engine),
		generateId: () => crypto.randomUUID(),
	});
}

test('empty tutor opening supplies model content without storing a learner message or restarting on remount', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	const requests: AgentEngineRequest[] = [];
	const engine: Parameters<typeof withTutorOpening>[0] = async function* (
		request,
	) {
		requests.push(request);
		yield { type: 'text-delta', delta: 'Welcome!' };
	};
	const chat = await open(folder, engine);
	chat.retry();
	await settle(chat);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.messages).toEqual([
		{ role: 'user', content: 'Begin our conversation.' },
	]);
	expect(chat.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	expect(await tableFiles(folder, 'messages')).toHaveLength(1);
	chat[Symbol.dispose]();
	const reopened = await open(folder, engine);
	await settle(reopened);
	expect(requests).toHaveLength(1);
	expect(reopened.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	reopened[Symbol.dispose]();
});

test('stopped opening saves no partial answer and retries from empty history', async () => {
	await using browser = createBrowser();
	const folder = await browser.open();
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const engine: Parameters<typeof withTutorOpening>[0] = async function* (
		_request,
		signal,
	) {
		calls++;
		if (calls === 1) {
			yield { type: 'text-delta', delta: 'Partial' };
			await blocked;
			if (signal.aborted) return;
		} else {
			yield { type: 'text-delta', delta: 'Welcome!' };
		}
	};
	const first = await open(folder, engine);
	first.retry();
	await Bun.sleep(0);
	first.stop();
	release();
	await settle(first);
	expect(await tableFiles(folder, 'messages')).toEqual([]);
	first[Symbol.dispose]();
	const reopened = await open(folder, engine);
	reopened.retry();
	await settle(reopened);
	expect(calls).toBe(2);
	expect(reopened.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	reopened[Symbol.dispose]();
});
