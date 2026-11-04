/**
 * `localSpeech()`: transcribe.cpp inside this app's process as an AI
 * endpoint (ADR-0757). Its `fetch` answers the OpenAI-compatible
 * `audio/transcriptions` and `models` requests in-process by calling this
 * plugin's commands, so there is no port another program could call, and
 * `openAi([... , localSpeech()])` lists its installed models beside every
 * other endpoint's.
 *
 * The plugin reads audio from a file in the app's data folder, so a
 * transcription request names the file by `path` (a folder-relative data
 * path, such as `recordings/20261031T101500123.wav`) instead of uploading
 * it. A request without a path is refused.
 *
 * The endpoint also carries what the OpenAI vocabulary cannot say: `download`
 * fetches a catalog model into the shared Hugging Face cache, after which
 * the endpoint lists it. An app that offers downloads keeps the endpoint in
 * a `const` and passes the same value to `openAi`.
 *
 * It imports only types from `@epicenter/ai`: capabilities never import each
 * other's code.
 */

import type { Endpoint, EndpointModel } from '@epicenter/ai';
import { Channel, isTauri } from '@tauri-apps/api/core';
import {
	commands as bindings,
	type DownloadProgress,
	type Root,
	type TranscriptionError,
} from './bindings.gen.js';

export type LocalSpeechCommands = Pick<
	typeof bindings,
	'listInferenceModels' | 'transcribeFile' | 'downloadModel'
>;

/** How each refusal answers over HTTP; the error's name is its code. */
const STATUS = {
	AudioReadError: 400,
	FolderUnavailable: 400,
	PathRefused: 400,
	FileMissing: 400,
	LocalRouteUnavailable: 404,
	ModelLoadError: 500,
	TranscriptionError: 500,
} satisfies Record<TranscriptionError['name'], number>;

function failure(status: number, code: string, message: string) {
	return Response.json({ error: { message, code } }, { status });
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
 * This app's in-process speech endpoint, or `null` outside the desktop app
 * (the web build passes the same array to `openAi`). `commands` stand in for
 * the plugin in tests; `root` is the folder a request's `path` is in.
 */
export function localSpeech({
	commands = isTauri() ? bindings : undefined,
	root = 'Data',
}: {
	commands?: LocalSpeechCommands;
	root?: Root;
} = {}) {
	if (!commands) return null;
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
		refresh() {
			void read();
		},
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
			const file = form?.get('path');
			if (typeof model !== 'string' || !model)
				return failure(
					400,
					'model-required',
					'Name a model to transcribe with.',
				);
			if (typeof file !== 'string' || !file)
				return failure(
					400,
					'path-required',
					"Local speech transcribes a file in the app's data folder; send its path.",
				);
			const language = form?.get('language');
			const prompt = form?.get('prompt');
			const { data, error } = await native.transcribeFile(model, root, file, {
				language: typeof language === 'string' && language ? language : null,
				initialPrompt: typeof prompt === 'string' && prompt ? prompt : null,
			});
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
	};
}
export type LocalSpeech = NonNullable<ReturnType<typeof localSpeech>>;
