/**
 * Mistral multipart format tests.
 * Exercises the installed SDK serialization with producer types, filename-only
 * evidence, and unknown bytes. Upload names follow the shared policy without
 * changing bytes or contacting the provider.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { MistralTranscriptionServiceLive } from './mistral.js';

for (const { input, filename, type } of [
	{
		input: new Blob(['audio'], { type: 'audio/webm;codecs=opus' }),
		filename: 'recording.webm',
		type: 'audio/webm;codecs=opus',
	},
	{
		input: new File(['audio'], 'voice.WAV'),
		filename: 'recording.wav',
		type: 'audio/wav',
	},
	{
		input: new Blob(['audio']),
		filename: 'recording.bin',
		type: 'application/octet-stream',
	},
]) {
	test(`Mistral sends ${filename} with the shared format and original bytes`, async () => {
		const originalFetch = globalThis.fetch;
		let seen: Request | undefined;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seen = new Request(input, init);
			return Response.json({
				model: 'voxtral-mini-latest',
				text: ' transcript ',
				language: 'en',
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}) as typeof fetch;
		try {
			expect(
				expectOk(
					await MistralTranscriptionServiceLive.transcribe(input, {
						apiKey: 'test-key',
						modelName: 'voxtral-mini-latest',
						spokenLanguage: 'auto',
						prompt: '',
					}),
				),
			).toBe('transcript');
			expect(seen).toBeDefined();
			const multipart = await seen!.clone().text();
			expect(multipart).toContain(`filename="${filename}"`);
			expect(multipart).toContain(`Content-Type: ${type}\r\n`);
			const uploaded = (await seen!.formData()).get('file') as File;
			expect(await uploaded.text()).toBe('audio');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
}
