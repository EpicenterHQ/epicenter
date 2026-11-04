/**
 * The one client over a fake endpoint fetch: what it posts, how it reads
 * server-sent chat chunks, and how each failure arrives as a Result error.
 */
import { expect, test } from 'bun:test';
import { type ChatChunk, createClient } from './client.js';

function sse(frames: (object | string)[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const frame of frames)
					controller.enqueue(
						encoder.encode(
							`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`,
						),
					);
				controller.close();
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } },
	);
}

function recording(response: () => Response) {
	const calls: { path: string; init?: RequestInit }[] = [];
	const client = createClient({
		fetch: async (path, init) => {
			calls.push({ path, init });
			return response();
		},
	});
	return { client, calls };
}

async function drain<T>(items: AsyncIterable<T>) {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

test('chat posts a streaming request and yields each chunk until DONE', async () => {
	const { client, calls } = recording(() =>
		sse([
			{ choices: [{ delta: { content: 'Hel' } }] },
			{ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
			'[DONE]',
			{ choices: [{ delta: { content: 'ignored' } }] },
		]),
	);
	const items = await drain(
		client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
	);
	expect(calls[0]?.path).toBe('chat/completions');
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
		stream: true,
		stream_options: { include_usage: true },
	});
	expect(items.map(({ data }) => data?.choices[0]?.delta?.content)).toEqual([
		'Hel',
		'lo',
	]);
	expect(items.every(({ error }) => error === null)).toBe(true);
});

test('chat reads CRLF line ends and multiline data across chunk boundaries', async () => {
	const encoder = new TextEncoder();
	const parts = [
		'data: {"choices": [\r',
		'\ndata: {"delta": {"content": "hello"}, "finish_reason": "stop"}]}\r\n\r\n',
		': a comment\r\n\r\ndata: [DONE]\r\n\r\n',
	];
	const client = createClient({
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(encoder.encode(part));
						controller.close();
					},
				}),
			),
	});
	const items = await drain(client.chat({ model: 'm', messages: [] }));
	expect(items).toEqual([
		{
			data: {
				choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }],
			} as ChatChunk,
			error: null,
		},
	]);
});

test('a usage-only chunk reads with no choices', async () => {
	const { client } = recording(() => sse([{ usage: { total_tokens: 3 } }]));
	const [item] = await drain(client.chat({ model: 'm', messages: [] }));
	expect(item?.data?.choices).toEqual([]);
});

test('a refusal keeps the provider message and code', async () => {
	const { client } = recording(
		() =>
			new Response(
				JSON.stringify({
					error: { message: 'Out of credits', code: 'InsufficientCredits' },
				}),
				{ status: 402 },
			),
	);
	const items = await drain(client.chat({ model: 'm', messages: [] }));
	expect(items).toHaveLength(1);
	expect(items[0]?.error).toMatchObject({
		name: 'Refused',
		status: 402,
		message: 'Out of credits',
		code: 'InsufficientCredits',
	});
});

test('an error frame mid-stream ends the stream with its message and code', async () => {
	const { client } = recording(() =>
		sse([
			{ choices: [{ delta: { content: 'a' } }] },
			{ error: { message: 'Retired', code: 'AccountRetired' } },
			{ choices: [{ delta: { content: 'never' } }] },
		]),
	);
	const items = await drain(client.chat({ model: 'm', messages: [] }));
	expect(items).toHaveLength(2);
	expect(items[1]?.error).toMatchObject({
		name: 'Failed',
		message: 'Retired',
		code: 'AccountRetired',
	});
});

test('malformed event JSON ends the stream as Malformed', async () => {
	const { client } = recording(() => sse(['malformed']));
	const items = await drain(client.chat({ model: 'm', messages: [] }));
	expect(items.map(({ error }) => error?.name)).toEqual(['Malformed']);
});

test('an unreachable endpoint is Unreachable; an aborted one is Cancelled', async () => {
	const failing = createClient({
		fetch: async () => {
			throw new TypeError('connection refused');
		},
	});
	const [unreachable] = await drain(failing.chat({ model: 'm', messages: [] }));
	expect(unreachable?.error?.name).toBe('Unreachable');

	const controller = new AbortController();
	controller.abort();
	const [cancelled] = await drain(
		failing.chat({ model: 'm', messages: [] }, { signal: controller.signal }),
	);
	expect(cancelled?.error?.name).toBe('Cancelled');
});

test('aborting mid-stream cancels the response body', async () => {
	let cancelled = false;
	const client = createClient({
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`,
							),
						);
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	const controller = new AbortController();
	const items = [];
	for await (const item of client.chat(
		{ model: 'm', messages: [] },
		{ signal: controller.signal },
	)) {
		items.push(item);
		controller.abort();
	}
	expect(items.map(({ error }) => error?.name ?? 'chunk')).toEqual([
		'chunk',
		'Cancelled',
	]);
	expect(cancelled).toBe(true);
});

test('transcribe posts multipart form data and reads the text', async () => {
	const { client, calls } = recording(() =>
		Response.json({ text: 'hello there' }),
	);
	const result = await client.transcribe({
		model: 'whisper-1',
		file: new File(['audio'], 'clip.webm', { type: 'audio/webm' }),
		language: 'en',
	});
	expect(result).toEqual({ data: { text: 'hello there' }, error: null });
	expect(calls[0]?.path).toBe('audio/transcriptions');
	const form = calls[0]?.init?.body as FormData;
	expect(form.get('model')).toBe('whisper-1');
	expect(form.get('language')).toBe('en');
	expect((form.get('file') as File).name).toBe('clip.webm');
});

test('transcribe without text is Malformed', async () => {
	const { client } = recording(() => Response.json({ nope: true }));
	const { error } = await client.transcribe({
		model: 'm',
		file: new Blob(['audio']),
	});
	expect(error?.name).toBe('Malformed');
});

test('embed posts JSON and reads the vectors', async () => {
	const { client, calls } = recording(() =>
		Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] }),
	);
	const { data } = await client.embed({ model: 'e', input: 'word' });
	expect(data).toEqual({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
	expect(calls[0]?.path).toBe('embeddings');
});

test('listModels reads ids and refuses a list that is not OpenAI-shaped', async () => {
	const good = recording(() =>
		Response.json({ data: [{ id: 'a' }, { id: 'b' }] }),
	);
	expect((await good.client.listModels()).data).toEqual(['a', 'b']);
	const bad = recording(() => Response.json({ models: [] }));
	expect((await bad.client.listModels()).error?.name).toBe('Malformed');
	const refused = recording(() => new Response('nope', { status: 401 }));
	expect((await refused.client.listModels()).error).toMatchObject({
		name: 'Refused',
		status: 401,
		message: 'nope',
	});
});
