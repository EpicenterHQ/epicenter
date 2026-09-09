import { invoke } from '@tauri-apps/api/core';
import type { AiTransport } from './ai.js';

const baseURL = 'https://transcribe-cpp.epicenter.invalid/v1';

/** Native file inference speaks the SDK's bounded HTTP protocol without opening a socket. */
export function createNativeInferenceTransport(): AiTransport {
	return createNativeTransport(invoke);
}

/** Composes IPC with multipart decoding and noninterruptible compute draining. */
export function createNativeTransport(
	invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
): AiTransport {
	return {
		baseURL,
		async fetch(input, init) {
			const request = new Request(input, init);
			const { signal } = request;
			signal.throwIfAborted();
			const url = new URL(request.url);
			if (url.origin !== new URL(baseURL).origin || url.search)
				throw new Error('Unsupported native inference destination.');
			if (request.method === 'GET' && url.pathname === '/v1/models') {
				const models = await invoke('list_inference_models');
				signal.throwIfAborted();
				if (
					!Array.isArray(models) ||
					!models.every(
						(model: unknown) =>
							typeof model === 'object' &&
							model !== null &&
							'id' in model &&
							typeof model.id === 'string' &&
							'active' in model &&
							typeof model.active === 'boolean' &&
							'installed' in model &&
							model.installed === true,
					)
				)
					throw new Error('Invalid native model response.');
				return Response.json({
					object: 'list',
					data: models.map((model) => ({
						...model,
						object: 'model',
						created: 0,
						owned_by: 'transcribe-cpp',
					})),
				});
			}
			if (
				request.method !== 'POST' ||
				url.pathname !== '/v1/audio/transcriptions'
			)
				throw new Error(
					'Native inference supports only models.list and audio.transcriptions.create.',
				);
			const form = await request.formData();
			const allowed = new Set([
				'file',
				'model',
				'prompt',
				'language',
				'response_format',
			]);
			for (const key of form.keys()) {
				if (!allowed.has(key))
					throw new Error(`Unsupported native transcription parameter: ${key}`);
				if (form.getAll(key).length !== 1)
					throw new Error(`Duplicate native transcription parameter: ${key}`);
			}
			const file = form.get('file');
			const model = form.get('model');
			if (!(file instanceof File))
				throw new Error('Native transcription requires an uploaded File.');
			if (typeof model !== 'string' || !model.trim())
				throw new Error(
					'Native transcription requires an explicit catalog model ID.',
				);
			const format = form.get('response_format');
			if (format !== null && format !== 'json')
				throw new Error('Native transcription supports only JSON output.');
			const prompt = form.get('prompt');
			const language = form.get('language');
			if (
				(prompt !== null && typeof prompt !== 'string') ||
				(language !== null && typeof language !== 'string')
			)
				throw new Error('Native transcription hints must be strings.');
			const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
			signal.throwIfAborted();
			// Do not race abort against invoke: App closure must wait for Rust to release its work.
			let result: unknown;
			try {
				result = await invoke('transcribe_audio_bytes', {
					modelId: model,
					bytes,
					hints: { initialPrompt: prompt, language },
				});
			} finally {
				signal.throwIfAborted();
			}
			if (
				typeof result !== 'object' ||
				result === null ||
				!('outcome' in result)
			)
				throw new Error('Invalid native transcription response.');
			if (result.outcome === 'empty-audio') return Response.json({ text: '' });
			if (
				result.outcome !== 'transcribed' ||
				!('text' in result) ||
				typeof result.text !== 'string' ||
				!('modelId' in result) ||
				result.modelId !== model ||
				!('applied' in result) ||
				typeof result.applied !== 'object' ||
				result.applied === null ||
				!('initialPrompt' in result.applied) ||
				typeof result.applied.initialPrompt !== 'boolean' ||
				!('language' in result.applied) ||
				(result.applied.language !== null &&
					typeof result.applied.language !== 'string')
			)
				throw new Error('Invalid native transcription response.');
			return Response.json({
				text: result.text,
				model: result.modelId,
				applied: result.applied,
			});
		},
	};
}
