/**
 * The one client over a fake endpoint fetch: what it posts, what it reads
 * back, and how each failure arrives as a Result error.
 */
import { expect, test } from 'bun:test';
import { createClient } from './client.js';

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
	const { error } = await client.transcribe({
		model: 'm',
		file: new Blob(['audio']),
	});
	expect(error).toMatchObject({
		name: 'Refused',
		status: 402,
		message: 'Out of credits',
		code: 'InsufficientCredits',
	});
});

test('an unreachable endpoint is Unreachable; an aborted one is Cancelled', async () => {
	const failing = createClient({
		fetch: async () => {
			throw new TypeError('connection refused');
		},
	});
	const unreachable = await failing.transcribe({
		model: 'm',
		file: new Blob(['audio']),
	});
	expect(unreachable.error?.name).toBe('Unreachable');

	const controller = new AbortController();
	controller.abort();
	const cancelled = await failing.transcribe(
		{ model: 'm', file: new Blob(['audio']) },
		{ signal: controller.signal },
	);
	expect(cancelled.error?.name).toBe('Cancelled');
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
