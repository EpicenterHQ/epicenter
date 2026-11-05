/**
 * Tutor opening tests.
 * Real conversations over Vocab's notes in a folder in memory add a
 * transient opening prompt without saving a learner turn, do not repeat on
 * remount, and discard a stopped partial opening before retry.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { AiError, type ChatRequest, custom, openAi } from '@epicenter/ai';
import { createConversation } from '@epicenter/ai/agent';
import { tutorOpening } from './opening.js';

const { openVocabFolder, settle } = await import('../vocab.test-support.js');

type Folder = Awaited<ReturnType<typeof openVocabFolder>>;

/** One streamed answer of `text`, finished. */
const answer = (text: string) =>
	new Response(
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { 'content-type': 'text/event-stream' } },
	);

/** A conversation over the chat's saved transcript, as a mounted view has it. */
function open(
	folder: Folder,
	respond: (
		request: ChatRequest,
		signal: AbortSignal | undefined,
	) => Response | Promise<Response>,
) {
	const ai = openAi([
		custom({
			id: 'tutor',
			baseUrl: 'https://tutor.test/v1',
			fetch: async (_url, init) =>
				respond(JSON.parse(String(init?.body)), init?.signal ?? undefined),
		}),
	]);
	return createConversation({
		messages: folder.messages,
		chat: 'chat-a',
		ai,
		model: () => ({ endpoint: 'tutor', model: 'model' }),
		prepare: tutorOpening,
	});
}

test('empty tutor opening supplies model content without storing a learner message or restarting on remount', async () => {
	using folder = await openVocabFolder();
	const requests: ChatRequest[] = [];
	const respond = (request: ChatRequest) => {
		requests.push(request);
		return answer('Welcome!');
	};
	const chat = open(folder, respond);
	chat.retry();
	await settle(chat);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.messages).toEqual([
		{ role: 'user', content: 'Begin our conversation.' },
	]);
	expect(chat.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	expect(folder.files.paths('messages')).toHaveLength(1);
	chat[Symbol.dispose]();
	const reopened = open(folder, respond);
	await reopened.ready;
	expect(requests).toHaveLength(1);
	expect(reopened.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	reopened[Symbol.dispose]();
});

test('stopped opening saves no partial answer and retries from empty history', async () => {
	using folder = await openVocabFolder();
	let calls = 0;
	const respond = (_request: ChatRequest, signal: AbortSignal | undefined) => {
		calls++;
		if (calls > 1) return answer('Welcome!');
		// A partial answer that never finishes until the person stops it.
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial' } }] })}\n\n`,
						),
					);
					signal?.addEventListener('abort', () =>
						controller.error(AiError.Cancelled().error),
					);
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' } },
		);
	};
	const first = open(folder, respond);
	first.retry();
	while (first.snapshot().streaming === null) await Bun.sleep(1);
	first.stop();
	await settle(first);
	expect(folder.files.paths('messages')).toEqual([]);
	first[Symbol.dispose]();
	const reopened = open(folder, respond);
	reopened.retry();
	await settle(reopened);
	expect(calls).toBe(2);
	expect(reopened.snapshot().messages.map((message) => message.role)).toEqual([
		'assistant',
	]);
	reopened[Symbol.dispose]();
});
