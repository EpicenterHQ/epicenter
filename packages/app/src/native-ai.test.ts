/**
 * Native SDK transport tests verify multipart bytes and exact model selection,
 * refusal of unsupported operations, and abort draining across admitted IPC work.
 */
import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import { createNativeTransport } from './native-ai.js';

test('SDK uploads actual file bytes and explicit model with hints', async () => {
	const calls: unknown[] = [];
	const transport = createNativeTransport(async (command, args) => {
		calls.push({ command, args });
		return {
			outcome: 'transcribed',
			text: 'spoken words',
			modelId: 'exact/model',
			applied: { language: 'en', initialPrompt: true },
		};
	});
	const client = new OpenAI({
		...transport,
		apiKey: 'unused',
		maxRetries: 0,
		dangerouslyAllowBrowser: true,
	});
	expect<unknown>(
		await client.audio.transcriptions.create({
			file: new File([new Uint8Array([1, 2, 3])], 'audio.wav'),
			model: 'exact/model',
			prompt: 'words',
			language: 'en',
		}),
	).toEqual({
		text: 'spoken words',
		model: 'exact/model',
		applied: { language: 'en', initialPrompt: true },
	});
	expect(calls).toEqual([
		{
			command: 'transcribe_audio_bytes',
			args: {
				modelId: 'exact/model',
				bytes: [1, 2, 3],
				hints: { initialPrompt: 'words', language: 'en' },
			},
		},
	]);
});

test('empty audio has empty text without claiming a model or applied hints', async () => {
	const transport = createNativeTransport(async () => ({
		outcome: 'empty-audio',
	}));
	const client = new OpenAI({
		...transport,
		apiKey: 'unused',
		maxRetries: 0,
		dangerouslyAllowBrowser: true,
	});
	expect<unknown>(
		await client.audio.transcriptions.create({
			file: new File([], 'empty.wav'),
			model: 'exact/model',
		}),
	).toEqual({ text: '' });
});

test('advisory hints report what the native model applied', async () => {
	const transport = createNativeTransport(async () => ({
		outcome: 'transcribed',
		text: 'spoken words',
		modelId: 'exact/model',
		applied: { language: null, initialPrompt: false },
	}));
	const client = new OpenAI({
		...transport,
		apiKey: 'unused',
		maxRetries: 0,
		dangerouslyAllowBrowser: true,
	});
	expect<unknown>(
		await client.audio.transcriptions.create({
			file: new File(['audio'], 'a.wav'),
			model: 'exact/model',
			prompt: 'words',
			language: 'en',
		}),
	).toEqual({
		text: 'spoken words',
		model: 'exact/model',
		applied: { language: null, initialPrompt: false },
	});
});

test('a native response naming another model is refused', async () => {
	const transport = createNativeTransport(async () => ({
		outcome: 'transcribed',
		text: 'spoken words',
		modelId: 'other/model',
		applied: { language: null, initialPrompt: false },
	}));
	const form = new FormData();
	form.set('file', new File(['audio'], 'a.wav'));
	form.set('model', 'exact/model');
	await expect(
		transport.fetch(`${transport.baseURL}/audio/transcriptions`, {
			method: 'POST',
			body: form,
		}),
	).rejects.toThrow('Invalid native transcription response');
});

test('native model listing preserves identity and active metadata', async () => {
	const transport = createNativeTransport(async () => [
		{ id: 'exact/model', active: true, installed: true },
	]);
	const client = new OpenAI({
		...transport,
		apiKey: 'unused',
		maxRetries: 0,
		dangerouslyAllowBrowser: true,
	});
	expect((await client.models.list()).data[0]).toMatchObject({
		id: 'exact/model',
		active: true,
	});
});

test('abort after admission waits for native work and suppresses output', async () => {
	const admitted = Promise.withResolvers<void>();
	const native = Promise.withResolvers<unknown>();
	const transport = createNativeTransport(async () => {
		admitted.resolve();
		return native.promise;
	});
	const controller = new AbortController();
	const form = new FormData();
	form.set('file', new File(['audio'], 'a.wav'));
	form.set('model', 'exact/model');
	let settled = false;
	const response = transport
		.fetch(`${transport.baseURL}/audio/transcriptions`, {
			method: 'POST',
			body: form,
			signal: controller.signal,
		})
		.finally(() => {
			settled = true;
		});
	await admitted.promise;
	controller.abort();
	await Promise.resolve();
	expect(settled).toBe(false);
	native.resolve('must not escape');
	await expect(response).rejects.toMatchObject({ name: 'AbortError' });
});

test('abort before admission and unsupported parameters never invoke native work', async () => {
	let calls = 0;
	const transport = createNativeTransport(async () => {
		calls++;
		return '';
	});
	await expect(
		transport.fetch(`${transport.baseURL}/models`, {
			signal: AbortSignal.abort(),
		}),
	).rejects.toMatchObject({ name: 'AbortError' });
	await expect(
		transport.fetch(`${transport.baseURL}/chat/completions`, {
			method: 'POST',
		}),
	).rejects.toThrow('supports only');
	const form = new FormData();
	form.set('file', new File(['audio'], 'a.wav'));
	form.set('model', 'exact/model');
	form.set('temperature', '0');
	await expect(
		transport.fetch(`${transport.baseURL}/audio/transcriptions`, {
			method: 'POST',
			body: form,
		}),
	).rejects.toThrow('temperature');
	expect(calls).toBe(0);
});
