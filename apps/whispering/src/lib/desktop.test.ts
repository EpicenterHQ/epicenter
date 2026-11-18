/**
 * Capabilities in a Tauri Window
 *
 * What each capability gives `src/lib/app.ts` when the page runs in a
 * Tauri window (`isTauri()`), composed as `app.ts` composes them, over a
 * stand-in shell: Tauri's `invoke` answers from memory, Tauri's HTTP
 * plugin is one function here, and the shell's recorder is a stand-in for
 * its module.
 *
 * Key behaviors:
 * - A connection's key is a Keychain item the shell keeps (`secret_get`,
 *   `secret_set`)
 * - Requests go through Tauri's HTTP plugin, which follows no redirect
 * - Ollama and LM Studio are looked for through it with no key
 * - Transcription on this computer takes the uploaded audio
 * - The shell's microphone records `recordings/<id>` in the data folder and
 *   repairs by ids, with each repaired recording's length
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { AudioFiles } from '@epicenter/recorder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

/** Every command the page sent, with its arguments. */
const sent: { command: string; args?: Record<string, unknown> }[] = [];
/** The requests sent through Tauri's HTTP plugin, with its options. */
const fetched: {
	url: string;
	init?: RequestInit & { maxRedirections?: number };
}[] = [];
/** The Keychain, as the shell keeps it. */
const keychain = new Map<string, string>();

mock.module('@tauri-apps/plugin-http', () => ({
	fetch: async (
		url: string,
		init?: RequestInit & { maxRedirections?: number },
	) => {
		fetched.push({ url, init });
		if (url.endsWith('/models'))
			return Response.json({ data: [{ id: 'llama3' }] });
		return new Response('Not found', { status: 404 });
	},
}));

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {
		constructor(public onmessage?: (message: unknown) => void) {}
	},
	transformCallback: () => 0,
	invoke: async (command: string, args?: Record<string, unknown>) => {
		sent.push({ command, args });
		switch (command) {
			case 'secret_get':
				return keychain.get(args?.name as string) ?? null;
			case 'secret_set': {
				const { name, value } = args as { name: string; value: string | null };
				if (value === null) keychain.delete(name);
				else keychain.set(name, value);
				return null;
			}
			case 'plugin:epicenter-transcription|list_inference_models':
				return [{ id: 'whisper-base', installed: true, active: false }];
			case 'plugin:epicenter-transcription|transcribe_audio':
				return {
					outcome: 'transcribed',
					text: ' Heard here. ',
					modelId: 'whisper-base',
					applied: { language: null, initialPrompt: false },
				};
			default:
				throw new Error(`Unexpected command ${command}`);
		}
	},
}));

mock.module('@tauri-apps/api/event', () => ({
	listen: async () => () => {},
}));

/** The data folder's audio files; the microphone only hands them to the recorder. */
const audioFiles = {} as AudioFiles;

/** What the recorder was asked to start or repair. */
const started: unknown[] = [];
// The shell's recorder, which `@epicenter/recorder` loads in a Tauri window.
mock.module(
	new URL('../../packages/recorder/src/tauri.ts', import.meta.url).pathname,
	() => ({
		recorder: {
			listInputs: async () =>
				Ok({ inputs: [{ deviceId: 'coreaudio:usb', label: 'USB' }] }),
			openMeter: async () => {
				throw new Error('not opened');
			},
			start: async (options: { files: unknown; id: string }) => {
				started.push(options);
				return Ok({
					onEnded: () => () => {},
					stop: async () => Ok({ id: options.id, durationMs: 1500 }),
				});
			},
			recover: async (options: { files: unknown }) => {
				started.push(options);
				return Ok({
					recovered: [
						{ id: 'a', durationMs: 1500 },
						{ id: 'b', durationMs: 2500 },
					],
					unplaced: [
						{
							id: 'c',
							take: '/Users/me/Library/Application Support/so.epicenter.whispering/local/recording/c.webm',
						},
					],
				});
			},
		},
	}),
);

const { localServers, openAi } = await import('@epicenter/ai');
const { recorder: microphone } = await import('@epicenter/recorder');
const { localSpeech } = await import('@epicenter/transcription');
const { createMicrophoneDevice } = await import('./microphone.js');
const { requestFetch, secrets } = await import('./this-computer.js');

/** The models `app.ts` merges in a Tauri window, but the saved connections, which `@epicenter/ai` tests. */
function openModels() {
	return openAi([localServers({ fetch: requestFetch }), localSpeech()]);
}

afterEach(() => {
	sent.length = 0;
	fetched.length = 0;
	started.length = 0;
});

const upload = () =>
	new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' });

test('a connection’s key is a Keychain item the shell keeps', async () => {
	expect(secrets.where).toBe('keychain');
	expect(await secrets.get('connection.openai')).toBeNull();
	await secrets.set('connection.openai', 'sk-test');
	expect(await secrets.get('connection.openai')).toBe('sk-test');
	expect(keychain.get('connection.openai')).toBe('sk-test');
	await secrets.set('connection.openai', null);
	expect(keychain.has('connection.openai')).toBe(false);
});

test('Ollama and LM Studio are looked for through Tauri’s HTTP plugin, which follows no redirect, with no key', async () => {
	const endpoints = openModels().endpoints();
	expect(endpoints.map(({ id }) => id)).toEqual([
		'ollama',
		'lm-studio',
		'local-speech',
	]);
	const ollama = endpoints[0]!;
	await new Promise<void>((resolve) => {
		const stop = ollama.subscribe?.(() => {
			stop?.();
			resolve();
		});
	});
	expect(ollama.models()).toEqual([{ id: 'llama3', can: ['chat'] }]);
	const asked = fetched.find(
		({ url }) => url === 'http://localhost:11434/v1/models',
	);
	expect(asked?.init?.maxRedirections).toBe(0);
	expect(new Headers(asked?.init?.headers).has('authorization')).toBe(false);
});

test('transcription on this computer takes the uploaded audio', async () => {
	const ai = openModels();
	expect(
		expectOk(
			await ai.transcribe({
				endpoint: 'local-speech',
				model: 'whisper-base',
				file: upload(),
			}),
		),
	).toEqual({ text: ' Heard here. ' });
	expect(sent.at(-1)).toEqual({
		command: 'plugin:epicenter-transcription|transcribe_audio',
		args: {
			modelId: 'whisper-base',
			audio: btoa(String.fromCharCode(1, 2, 3)),
			hints: { language: null, initialPrompt: null },
		},
	});
});

test('the shell’s microphone records a take by id, and recovery answers each take it placed or kept', async () => {
	const capture = createMicrophoneDevice({
		files: audioFiles,
		recorder: microphone,
	});
	expect(expectOk(await capture.inputs.listInputs()).inputs).toEqual([
		{ deviceId: 'coreaudio:usb', label: 'USB' },
	]);
	const recording = expectOk(await capture.start({ id: '20261031T093000000' }));
	expect(started).toEqual([
		{
			files: audioFiles,
			id: '20261031T093000000',
			input: undefined,
			signal: undefined,
		},
	]);
	expect(expectOk(await recording.stop())).toEqual({ durationMs: 1500 });
	// A take kept outside the folder, because audio with its id is there, is
	// answered with where it is.
	expect(expectOk(await capture.recover!())).toEqual({
		recovered: [
			{ id: 'a', durationMs: 1500 },
			{ id: 'b', durationMs: 2500 },
		],
		unplaced: [
			{
				id: 'c',
				take: '/Users/me/Library/Application Support/so.epicenter.whispering/local/recording/c.webm',
			},
		],
	});
	expect(started.at(-1)).toEqual({ files: audioFiles });
});
