/**
 * `localSpeech()` over a fake Tauri invoke: the real generated bindings run,
 * loaded with the first command, so each request is checked down to the
 * plugin command and its arguments. Outside a Tauri window there is none.
 */
import { expect, mock, test } from 'bun:test';
import type { DownloadProgress } from './bindings.gen.js';

type Call = { command: string; args?: Record<string, unknown> };
const calls: Call[] = [];
let installed = ['whisper-tiny'];
let replies: Record<string, (args?: Record<string, unknown>) => unknown> = {};

let inTauri = true;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inTauri,
	invoke: async (command: string, args?: Record<string, unknown>) => {
		calls.push({ command, args });
		const name = command.replace('plugin:epicenter-transcription|', '');
		if (name === 'list_inference_models')
			return installed.map((id) => ({ id, installed: true, active: false }));
		const reply = replies[name];
		if (!reply) throw new Error(`No fake reply for ${name}`);
		return reply(args);
	},
	Channel: class {
		onmessage = (_progress: DownloadProgress) => {};
	},
}));
const { localSpeech: maybeSpeech } = await import('./local-speech.js');

/** The handle a Tauri window opens. */
function localSpeech() {
	const speech = maybeSpeech();
	if (speech === null) throw new Error('no local speech in a Tauri window');
	return speech;
}

function reset() {
	calls.length = 0;
	installed = ['whisper-tiny'];
	replies = {};
}

/** A transcription request: its fields, and the audio as `file` unless `audio` is false. */
function form(fields: Record<string, string>, { audio = true } = {}) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	if (audio) body.set('file', new File([new Uint8Array([1])], 'a.webm'));
	return { method: 'POST', body };
}

test('lists installed models when first subscribed, as transcription models', async () => {
	reset();
	const speech = localSpeech();
	expect(speech.models()).toEqual([]);
	let told = 0;
	speech.subscribe?.(() => told++);
	// The first listing waits for the plugin's bindings to load.
	await speech.refresh?.();
	expect(speech.models()).toEqual([
		{ id: 'whisper-tiny', can: ['transcribe'] },
	]);
	expect(told).toBe(1);
	const listed = await speech.fetch('models');
	expect(await listed.json()).toMatchObject({
		data: [{ id: 'whisper-tiny' }],
	});
});

test('empty audio transcribes to empty text', async () => {
	reset();
	replies.transcribe_audio = () => ({ outcome: 'empty-audio' });
	const response = await localSpeech().fetch(
		'audio/transcriptions',
		form({ model: 'whisper-tiny' }),
	);
	expect(await response.json()).toEqual({ text: '' });
});

test('a plugin refusal answers as an OpenAI error with its name as the code', async () => {
	reset();
	replies.transcribe_audio = () => {
		throw {
			name: 'LocalRouteUnavailable',
			reason: 'active-model-unavailable',
			message: 'Native transcription model is not installed: whisper-large',
		};
	};
	const response = await localSpeech().fetch(
		'audio/transcriptions',
		form({ model: 'whisper-large' }),
	);
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		error: {
			code: 'LocalRouteUnavailable',
			message: 'Native transcription model is not installed: whisper-large',
		},
	});
});

test('an uploaded file is transcribed through transcribe_audio, as its bytes', async () => {
	reset();
	replies.transcribe_audio = () => ({
		outcome: 'transcribed',
		text: 'dictated',
		modelId: 'whisper-tiny',
		applied: { language: null, initialPrompt: true },
	});
	const body = new FormData();
	body.set('model', 'whisper-tiny');
	body.set('prompt', 'Vocab');
	body.set('file', new File([new Uint8Array([0, 1, 254, 255])], 'a.webm'));
	const response = await localSpeech().fetch('audio/transcriptions', {
		method: 'POST',
		body,
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text: 'dictated' });
	expect(calls.at(-1)).toEqual({
		command: 'plugin:epicenter-transcription|transcribe_audio',
		args: {
			modelId: 'whisper-tiny',
			audio: btoa(String.fromCharCode(0, 1, 254, 255)),
			hints: { language: null, initialPrompt: 'Vocab' },
		},
	});
});

test('a request with no audio, or one naming a path, is refused before any command runs', async () => {
	reset();
	const response = await localSpeech().fetch(
		'audio/transcriptions',
		form(
			{ model: 'whisper-tiny', path: 'recordings/a.webm' },
			{ audio: false },
		),
	);
	expect(response.status).toBe(400);
	expect((await response.json()).error.code).toBe('file-required');
	expect(calls).toEqual([]);
	expect(
		(await localSpeech().fetch('chat/completions', { method: 'POST' })).status,
	).toBe(404);
});

test('download fetches through download_model, then lists the new model', async () => {
	reset();
	installed = [];
	replies.download_model = () => {
		installed = ['whisper-small'];
		return null;
	};
	const speech = localSpeech();
	let told = 0;
	speech.subscribe?.(() => told++);
	// The first listing waits for the plugin's bindings to load.
	await speech.refresh?.();
	expect(speech.models()).toEqual([]);
	const result = await speech.download('whisper-small');
	expect(result).toEqual({ data: null, error: null });
	expect(calls.some(({ command }) => command.endsWith('|download_model'))).toBe(
		true,
	);
	expect(speech.models()).toEqual([
		{ id: 'whisper-small', can: ['transcribe'] },
	]);
	expect(told).toBe(1);
});

test('remove deletes through remove_model, then lists the model no longer', async () => {
	reset();
	replies.remove_model = () => {
		installed = [];
		return null;
	};
	const speech = localSpeech();
	let told = 0;
	speech.subscribe?.(() => told++);
	// The first listing waits for the plugin's bindings to load.
	await speech.refresh?.();
	expect(speech.models()).toEqual([
		{ id: 'whisper-tiny', can: ['transcribe'] },
	]);
	expect(await speech.remove('whisper-tiny')).toEqual({
		data: null,
		error: null,
	});
	expect(calls).toContainEqual({
		command: 'plugin:epicenter-transcription|remove_model',
		args: { modelId: 'whisper-tiny' },
	});
	expect(speech.models()).toEqual([]);
	expect(told).toBe(2);
});

test('load and unload name the model to the plugin', async () => {
	reset();
	replies.load_model = () => null;
	replies.unload_model = () => null;
	const speech = localSpeech();
	await speech.load('whisper-tiny');
	await speech.unload('whisper-tiny');
	expect(calls.map(({ command, args }) => [command, args])).toEqual([
		['plugin:epicenter-transcription|load_model', { modelId: 'whisper-tiny' }],
		[
			'plugin:epicenter-transcription|unload_model',
			{ modelId: 'whisper-tiny' },
		],
	]);
});

test('the catalog, a folder, and the unload policy go to their commands', async () => {
	reset();
	const catalog = [{ id: 'whisper-tiny', downloaded: true }];
	replies.list_models = () => catalog;
	replies.reveal_model = () => null;
	replies.get_unload_policy = () => 'never';
	replies.set_unload_policy = () => null;
	const speech = localSpeech();
	expect(await speech.catalog()).toEqual(catalog as never);
	await speech.reveal('whisper-tiny');
	expect(await speech.unloadPolicy()).toBe('never');
	await speech.setUnloadPolicy('immediately');
	expect(calls.map(({ command, args }) => [command, args])).toEqual([
		['plugin:epicenter-transcription|list_models', undefined],
		[
			'plugin:epicenter-transcription|reveal_model',
			{ modelId: 'whisper-tiny' },
		],
		['plugin:epicenter-transcription|get_unload_policy', undefined],
		[
			'plugin:epicenter-transcription|set_unload_policy',
			{ policy: 'immediately' },
		],
	]);
});

test('a browser has no local speech, and never asks the plugin', () => {
	reset();
	inTauri = false;
	try {
		expect(maybeSpeech()).toBeNull();
	} finally {
		inTauri = true;
	}
	expect(calls).toEqual([]);
});
