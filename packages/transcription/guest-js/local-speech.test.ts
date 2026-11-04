/**
 * `localSpeech()` over a fake Tauri invoke: the real generated bindings run,
 * so each request is checked down to the plugin command and its arguments.
 */
import { expect, mock, test } from 'bun:test';
import type { DownloadProgress } from './bindings.gen.js';

type Call = { command: string; args?: Record<string, unknown> };
const calls: Call[] = [];
let installed = ['whisper-tiny'];
let replies: Record<string, (args?: Record<string, unknown>) => unknown> = {};
let desktop = true;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => desktop,
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
const { localSpeech } = await import('./local-speech.js');

function reset() {
	calls.length = 0;
	installed = ['whisper-tiny'];
	replies = {};
}

function form(fields: Record<string, string>) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	return { method: 'POST', body };
}

test('lists installed models when first subscribed, as transcription models', async () => {
	reset();
	const speech = localSpeech()!;
	expect(speech.models()).toEqual([]);
	let told = 0;
	speech.subscribe?.(() => told++);
	await Bun.sleep(0);
	expect(speech.models()).toEqual([
		{ id: 'whisper-tiny', can: ['transcribe'] },
	]);
	expect(told).toBe(1);
	const listed = await speech.fetch('models');
	expect(await listed.json()).toMatchObject({
		data: [{ id: 'whisper-tiny' }],
	});
});

test('transcribes the file at a path in the data folder through transcribe_file', async () => {
	reset();
	replies.transcribe_file = () => ({
		outcome: 'transcribed',
		text: 'hello',
		modelId: 'whisper-tiny',
		applied: { language: 'en', initialPrompt: false },
	});
	const response = await localSpeech()!.fetch(
		'audio/transcriptions',
		form({ model: 'whisper-tiny', path: 'recordings/a.webm', language: 'en' }),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ text: 'hello' });
	expect(calls.at(-1)).toEqual({
		command: 'plugin:epicenter-transcription|transcribe_file',
		args: {
			modelId: 'whisper-tiny',
			root: 'Data',
			path: 'recordings/a.webm',
			hints: { language: 'en', initialPrompt: null },
		},
	});
});

test('empty audio transcribes to empty text', async () => {
	reset();
	replies.transcribe_file = () => ({ outcome: 'empty-audio' });
	const response = await localSpeech()!.fetch(
		'audio/transcriptions',
		form({ model: 'whisper-tiny', path: 'a.wav' }),
	);
	expect(await response.json()).toEqual({ text: '' });
});

test('a plugin refusal answers as an OpenAI error with its name as the code', async () => {
	reset();
	replies.transcribe_file = () => {
		throw {
			name: 'LocalRouteUnavailable',
			reason: 'active-model-unavailable',
			message: 'Native transcription model is not installed: whisper-large',
		};
	};
	const response = await localSpeech()!.fetch(
		'audio/transcriptions',
		form({ model: 'whisper-large', path: 'a.wav' }),
	);
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({
		error: {
			code: 'LocalRouteUnavailable',
			message: 'Native transcription model is not installed: whisper-large',
		},
	});
});

test('an upload without a path is refused before any command runs', async () => {
	reset();
	const body = new FormData();
	body.set('model', 'whisper-tiny');
	body.set('file', new File(['x'], 'a.webm'));
	const response = await localSpeech()!.fetch('audio/transcriptions', {
		method: 'POST',
		body,
	});
	expect(response.status).toBe(400);
	expect((await response.json()).error.code).toBe('path-required');
	expect(calls).toEqual([]);
	expect(
		(await localSpeech()!.fetch('chat/completions', { method: 'POST' })).status,
	).toBe(404);
});

test('download fetches through download_model, then lists the new model', async () => {
	reset();
	installed = [];
	replies.download_model = () => {
		installed = ['whisper-small'];
		return null;
	};
	const speech = localSpeech()!;
	let told = 0;
	speech.subscribe?.(() => told++);
	await Bun.sleep(0);
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

test('outside the desktop app there is no local speech', () => {
	desktop = false;
	try {
		expect(localSpeech()).toBeNull();
	} finally {
		desktop = true;
	}
});
