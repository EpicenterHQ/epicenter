/**
 * Transcription wire tests.
 * Verifies authenticated multipart requests, shared format filenames, preserved
 * bytes and producer media types, filename fallback, and typed response errors.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { resolveConnection } from './connection.js';
import { transcribe } from './transcribe.js';

describe('transcribe over the OpenAI wire', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function captureRequest(response: Response) {
		const seen: { url: string; init: RequestInit | undefined }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			seen.push({ url: String(url), init });
			return response;
		}) as unknown as typeof fetch;
		return seen;
	}

	test('posts multipart to /v1/audio/transcriptions and returns trimmed text', async () => {
		const seen = captureRequest(
			new Response(JSON.stringify({ text: '  hello world  ' }), {
				status: 200,
			}),
		);

		const result = await transcribe(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
			resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
			{ model: 'whisper-1' },
		);

		expect(expectOk(result)).toBe('hello world');
		expect(seen).toHaveLength(1);
		// The connection's baseUrl already carries `/v1`; the client appends the
		// rest of the wire path, like the sibling chat client does.
		expect(seen[0]?.url).toBe('http://localhost:8000/v1/audio/transcriptions');
		expect(seen[0]?.init?.method).toBe('POST');

		const form = seen[0]?.init?.body as FormData;
		expect(form.get('model')).toBe('whisper-1');
		const file = form.get('file') as File;
		// The extension is derived from the blob MIME so the wire detects the format.
		expect(file.name).toBe('audio.webm');
	});

	test('forwards through the resolved transport: a keyed connection sends a Bearer', async () => {
		const seen = captureRequest(
			new Response(JSON.stringify({ text: 'ok' }), { status: 200 }),
		);

		// The Bearer is `resolveConnection`'s contract, not transcribe's: transcribe
		// just POSTs through whatever transport it is handed. This proves the
		// composition callers use (resolve a connection, then transcribe).
		await transcribe(
			new Blob([new Uint8Array([1])], { type: 'audio/mp4' }),
			resolveConnection({
				baseUrl: 'https://api.groq.com/openai/v1',
				apiKey: 'sk-test',
			}),
			{ model: 'whisper-large-v3', language: 'en', prompt: 'Epicenter' },
		);

		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get('Authorization')).toBe('Bearer sk-test');
		const form = seen[0]?.init?.body as FormData;
		expect(form.get('language')).toBe('en');
		expect(form.get('prompt')).toBe('Epicenter');
	});

	test('a non-2xx becomes a RequestFailed carrying the status', async () => {
		captureRequest(new Response('nope', { status: 401 }));

		const result = await transcribe(
			new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
			resolveConnection({
				baseUrl: 'https://api.openai.com/v1',
				apiKey: 'bad',
			}),
			{ model: 'whisper-1' },
		);

		expect(expectErr(result)).toMatchObject({
			name: 'RequestFailed',
			status: 401,
			detail: 'nope',
		});
	});

	test('a 2xx body that is not { text } becomes Malformed', async () => {
		captureRequest(
			new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
		);

		const result = await transcribe(
			new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
			resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
			{ model: 'whisper-1' },
		);

		expect(expectErr(result).name).toBe('Malformed');
	});

	const filenameCases: Array<{ input: Blob; name: string; type: string }> = [
		{
			input: new Blob(['audio'], { type: 'audio/wave' }),
			name: 'audio.wav',
			type: 'audio/wave',
		},
		{
			input: new Blob(['audio'], { type: 'audio/x-wav' }),
			name: 'audio.wav',
			type: 'audio/x-wav',
		},
		{
			input: new Blob(['audio'], { type: 'audio/mpeg' }),
			name: 'audio.mp3',
			type: 'audio/mpeg',
		},
		{
			input: new Blob(['audio'], { type: 'audio/webm;codecs=opus' }),
			name: 'audio.webm',
			type: 'audio/webm;codecs=opus',
		},
		{
			input: new Blob(['audio'], { type: 'video/webm' }),
			name: 'audio.webm',
			type: 'video/webm',
		},
		{
			input: new Blob(['audio'], { type: 'audio/x-m4a' }),
			name: 'audio.m4a',
			type: 'audio/x-m4a',
		},
		{
			input: new Blob(['audio'], { type: 'audio/ogg' }),
			name: 'audio.ogg',
			type: 'audio/ogg',
		},
		{
			input: new Blob(['audio']),
			name: 'audio.bin',
			type: 'application/octet-stream',
		},
		{
			input: new Blob(['audio'], { type: 'application/octet-stream' }),
			name: 'audio.bin',
			type: 'application/octet-stream',
		},
		{
			input: new File(['audio'], 'voice.WAV'),
			name: 'audio.wav',
			type: 'audio/wav',
		},
		{
			input: new File(['audio'], 'voice.M4A', {
				type: 'application/octet-stream',
			}),
			name: 'audio.m4a',
			type: 'audio/mp4',
		},
		{
			input: new File(['audio'], 'voice.wav', { type: 'audio/webm' }),
			name: 'audio.webm',
			type: 'audio/webm',
		},
		{
			input: new File(['audio'], 'voice.wav', {
				type: 'application/x-unknown',
			}),
			name: 'audio.bin',
			type: 'application/x-unknown',
		},
	];

	for (const { input, name, type } of filenameCases) {
		test(`uploads ${input.type || '(untyped)'} ${input instanceof File ? input.name : 'Blob'} as ${name} without converting bytes`, async () => {
			const seen = captureRequest(Response.json({ text: 'x' }));
			expectOk(
				await transcribe(
					input,
					resolveConnection({ baseUrl: 'http://localhost:8000/v1' }),
					{ model: 'whisper-1' },
				),
			);
			const form = seen[0]?.init?.body as FormData;
			const wire = new Response(form);
			const multipart = await wire.clone().text();
			expect(multipart).toContain(`filename="${name}"`);
			expect(multipart).toContain(`Content-Type: ${type}\r\n`);
			const file = (await wire.formData()).get('file') as File;
			expect(await file.text()).toBe('audio');
		});
	}
});
