/**
 * `localSpeech()` in a desktop app (the `tauri` condition; the web's is
 * `local-speech.web.ts`, which answers null): transcribe.cpp inside this
 * app's process as an AI endpoint (ADR-0757). Its `fetch` answers the
 * OpenAI-compatible `audio/transcriptions` and `models` requests in-process
 * by calling this plugin's commands, so there is no port another program
 * could call, and `openAi([... , localSpeech()])` lists its installed models
 * beside every other endpoint's.
 *
 * A transcription uploads its audio as `file`, as any OpenAI client does (a
 * dictation's blob, or a recording read from the folder), and the plugin
 * decodes the bytes where they arrive.
 *
 * The handle also carries what the OpenAI vocabulary cannot say: the
 * catalog of models this app can run and each one's local lifecycle.
 * `download` fetches a catalog model into the shared Hugging Face cache,
 * `remove` deletes it from that cache (a cache other apps and tools share,
 * so one that used it downloads it again), `reveal` shows its folder, `load`
 * and `unload` move it in and out of memory, and the unload policy says when
 * an idle model leaves memory. Which model a job uses is the app's model
 * choice, never the handle's. An app keeps the handle in a `const` and
 * passes the same value to `openAi`, so a download or a removal reaches its
 * picker.
 *
 * It imports only types from `@epicenter/ai`: capabilities never import each
 * other's code.
 */

import type { Endpoint, EndpointModel } from '@epicenter/ai';
import { Channel } from '@tauri-apps/api/core';
import {
	commands as bindings,
	type DownloadProgress,
	type ModelInfo,
	type TranscriptionError,
	type UnloadPolicy,
} from './bindings.gen.js';

export type LocalSpeechCommands = Pick<
	typeof bindings,
	| 'listModels'
	| 'listInferenceModels'
	| 'transcribeAudio'
	| 'downloadModel'
	| 'removeModel'
	| 'revealModel'
	| 'loadModel'
	| 'unloadModel'
	| 'getUnloadPolicy'
	| 'setUnloadPolicy'
>;

/** How each refusal answers over HTTP; the error's name is its code. */
const STATUS = {
	AudioReadError: 400,
	LocalRouteUnavailable: 404,
	ModelLoadError: 500,
	TranscriptionError: 500,
} satisfies Record<TranscriptionError['name'], number>;

function failure(status: number, code: string, message: string) {
	return Response.json({ error: { message, code } }, { status });
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
	return btoa(binary);
}

/** The posted form, whether the client handed over a `FormData` or a serialized body. */
async function formOf(init: RequestInit | undefined): Promise<FormData | null> {
	if (init?.body instanceof FormData) return init.body;
	try {
		return await new Response(init?.body, {
			headers: init?.headers,
		}).formData();
	} catch {
		return null;
	}
}

/**
 * This app's in-process speech endpoint, with its models' local lifecycle.
 * `commands` stand in for the plugin in tests.
 */
export function localSpeech({
	commands = bindings,
}: {
	commands?: LocalSpeechCommands;
} = {}) {
	const native = commands;
	let models: readonly EndpointModel[] = [];
	let reading = 0;
	const listeners = new Set<() => void>();

	async function read() {
		const revision = ++reading;
		let installed: string[];
		try {
			installed = (await native.listInferenceModels())
				.filter((model) => model.installed)
				.map((model) => model.id);
		} catch {
			installed = [];
		}
		if (revision !== reading) return;
		if (
			installed.length === models.length &&
			installed.every((id, index) => models[index]?.id === id)
		)
			return;
		models = installed.map((id) => ({ id, can: ['transcribe'] }));
		for (const listener of [...listeners]) listener();
	}

	const endpoint: Endpoint = {
		id: 'local-speech',
		name: 'On this computer',
		source: 'local',
		models: () => models,
		subscribe(listener) {
			listeners.add(listener);
			if (listeners.size === 1) void read();
			return () => {
				listeners.delete(listener);
			};
		},
		refresh: read,
		async fetch(path, init) {
			init?.signal?.throwIfAborted();
			const method = (init?.method ?? 'GET').toUpperCase();
			if (path === 'models' && method === 'GET') {
				await read();
				return Response.json({
					object: 'list',
					data: models.map(({ id }) => ({ id, object: 'model' })),
				});
			}
			if (path !== 'audio/transcriptions' || method !== 'POST')
				return failure(
					404,
					'not-found',
					`Local speech does not answer ${method} ${path}.`,
				);
			const form = await formOf(init);
			const model = form?.get('model');
			const file = form?.get('file');
			if (typeof model !== 'string' || !model)
				return failure(
					400,
					'model-required',
					'Name a model to transcribe with.',
				);
			if (!(file instanceof Blob))
				return failure(
					400,
					'file-required',
					'Send the audio to transcribe as `file`.',
				);
			const language = form?.get('language');
			const prompt = form?.get('prompt');
			const { data, error } = await native.transcribeAudio(
				model,
				toBase64(new Uint8Array(await file.arrayBuffer())),
				{
					language: typeof language === 'string' && language ? language : null,
					initialPrompt: typeof prompt === 'string' && prompt ? prompt : null,
				},
			);
			init?.signal?.throwIfAborted();
			if (error !== null)
				return failure(STATUS[error.name], error.name, error.message);
			return Response.json({
				text: data.outcome === 'transcribed' ? data.text : '',
			});
		},
	};
	return {
		...endpoint,
		/** Every model this app can run, each saying whether it is downloaded. */
		catalog(): Promise<ModelInfo[]> {
			return native.listModels();
		},
		/**
		 * Download a catalog model into the shared Hugging Face cache. The
		 * transfer continues if the page stops waiting; once it finishes, the
		 * endpoint lists the model and tells subscribers.
		 */
		async download(
			modelId: string,
			{
				onProgress,
			}: { onProgress?: (progress: DownloadProgress) => void } = {},
		) {
			const channel = new Channel<DownloadProgress>();
			if (onProgress) channel.onmessage = onProgress;
			const result = await native.downloadModel(modelId, channel);
			await read();
			return result;
		},
		/**
		 * Delete a model's file from the shared Hugging Face cache, unloading
		 * it first. The cache is shared: another app or Hugging Face tool that
		 * used the file downloads it again. The endpoint then lists the model
		 * no longer and tells subscribers.
		 */
		async remove(modelId: string) {
			const result = await native.removeModel(modelId);
			await read();
			return result;
		},
		/** Show a downloaded model's folder in the shared cache. */
		reveal(modelId: string) {
			return native.revealModel(modelId);
		},
		/** Load a model into memory now, so its next transcription starts warm. */
		load(modelId: string) {
			return native.loadModel(modelId);
		},
		/** Drop a model from memory; its file stays in the cache. */
		unload(modelId: string) {
			return native.unloadModel(modelId);
		},
		/** When an idle model leaves memory. */
		unloadPolicy(): Promise<UnloadPolicy> {
			return native.getUnloadPolicy();
		},
		/** Set when an idle model leaves memory; this app keeps it. */
		setUnloadPolicy(policy: UnloadPolicy) {
			return native.setUnloadPolicy(policy);
		},
	};
}
export type LocalSpeech = ReturnType<typeof localSpeech>;
