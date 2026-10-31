/**
 * Tutor opening tests.
 * Real conversations over Vocab's notes on a real device folder add a
 * transient opening prompt without saving a learner turn, do not repeat on
 * remount, and discard a stopped partial opening before retry.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { type AgentEngineRequest, createConversation } from '@epicenter/agent';
import { withTutorOpening } from './opening.js';

const { openVocabFolder, settle } = await import('../vocab.test-support.js');
const { createChatMessageStore } = await import('./messages.svelte.js');

type Folder = Awaited<ReturnType<typeof openVocabFolder>>;

/** A conversation over the chat's saved transcript, as a mounted view has it. */
async function open(
	folder: Folder,
	engine: Parameters<typeof withTutorOpening>[0],
) {
	const store = createChatMessageStore(folder.lists.messages, 'chat-a');
	return createConversation({
		store,
		engine: withTutorOpening(engine),
		generateId: () => crypto.randomUUID(),
	});
}

test('empty tutor opening supplies model content without storing a learner message or restarting on remount', async () => {
	await using folder = await openVocabFolder();
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
	expect(await folder.files('messages')).toHaveLength(1);
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
	await using folder = await openVocabFolder();
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
	expect(await folder.files('messages')).toEqual([]);
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
