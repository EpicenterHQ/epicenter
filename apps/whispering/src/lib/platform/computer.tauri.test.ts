/**
 * Desktop Capability Tests
 *
 * What the desktop window's leaves give `src/lib/app.ts`
 * (`account.tauri.ts`, `computer.tauri.ts`), composed as `app.ts` composes
 * them, over a stand-in shell: Tauri's `invoke` answers from memory, so the
 * account's commands, the shell's fetch and the transcription plugin are
 * each one function here, and the recorder is a stand-in for its package.
 *
 * A saved connection's place (AppData's `connections.md`, each key in the
 * credential store, every request through the shell) is `@epicenter/ai`'s
 * desktop `customEndpoints()`, tested with that package.
 *
 * Key behaviors:
 * - Epicenter's models go through the account's relay (`account_fetch`)
 *   with no token from the page
 * - Ollama and LM Studio are looked for through the shell with no key
 * - Transcription on this computer takes the uploaded audio
 * - The shell's microphone records `recordings/<id>` in the data folder and
 *   repairs by ids, with each repaired recording's length
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { AuthClient } from '@epicenter/account';
import type { AudioFiles } from '@epicenter/recorder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

const ORIGIN = 'http://localhost:8787';

/** Every command the page sent, with its arguments. */
const sent: { command: string; args?: Record<string, unknown> }[] = [];
/** The requests the shell was asked to send, as the page described them. */
const relayed: {
	command: string;
	connection?: string | null;
	url: string;
	headers: [string, string][];
}[] = [];

type Listener = (message: unknown) => void;

/** Answer a relayed request on its channel: a head, the body, the end. */
function answer(args: Record<string, unknown> | undefined, body: unknown) {
	const onEvent = args?.onEvent as { onmessage: Listener };
	queueMicrotask(() => {
		onEvent.onmessage({
			kind: 'head',
			status: 200,
			headers: [['content-type', 'application/json']],
		});
		onEvent.onmessage([...new TextEncoder().encode(JSON.stringify(body))]);
		onEvent.onmessage({ kind: 'end' });
	});
	return null;
}

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {
		constructor(public onmessage?: Listener) {}
	},
	transformCallback: () => 0,
	invoke: async (command: string, args?: Record<string, unknown>) => {
		sent.push({ command, args });
		switch (command) {
			case 'account_state':
				return {
					origin: ORIGIN,
					signedIn: { origin: ORIGIN, principalId: 'person-1' },
					refused: false,
				};
			case 'account_fetch':
			case 'connection_fetch': {
				const request = args?.request as {
					connection?: string | null;
					url: string;
					headers: [string, string][];
				};
				relayed.push({ command, ...request });
				if (request.url.endsWith('/models'))
					return answer(args, { data: [{ id: 'llama3' }] });
				return answer(args, { text: `Heard through ${command}.` });
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
mock.module('@epicenter/recorder/tauri', () => ({
	recorder: {
		listInputs: async () =>
			Ok({ inputs: [{ deviceId: 'coreaudio:usb', label: 'USB' }] }),
		openMeter: async () => {
			throw new Error('not opened');
		},
		start: async (options: { folder: unknown; path: string }) => {
			started.push(options);
			return Ok({
				onEnded: () => () => {},
				stop: async () =>
					Ok({ path: `${options.path}.webm`, durationMs: 1500 }),
			});
		},
		recover: async (options: {
			folder: unknown;
			under: string;
			unnamed: readonly string[];
		}) => {
			started.push(options);
			// The shell's recorder: what it placed, then each unnamed one, whole.
			const placed = [
				{ path: `${options.under}/a.webm`, durationMs: 1500 },
				{ path: `${options.under}/b.webm`, durationMs: 2500 },
			];
			return Ok({
				recovered: [
					...placed,
					...options.unnamed
						.filter((path) => !placed.some((entry) => entry.path === path))
						.map((path) => ({ path, durationMs: null })),
				],
				unplaced: [
					{
						path: `${options.under}/c.webm`,
						pending: `.epicenter/recordings/${options.under}/c.webm`,
					},
				],
			});
		},
	},
}));

// The desktop build resolves `@epicenter/transcription` under the `tauri`
// condition; this run resolves the browser's, so it is pointed at the same leaf.
const desktopSpeech = await import(
	'../../../../../packages/transcription/guest-js/local-speech.js'
);
mock.module('@epicenter/transcription', () => desktopSpeech);

const { hosted, openAi } = await import('@epicenter/ai');
const { localSpeech } = await import('@epicenter/transcription');
const { connectAccount } = await import('./account.tauri.js');
const { localModelServers, microphone } = await import('./computer.tauri.js');
const { createMicrophoneDevice } = await import('../microphone.js');

/** The models `app.ts` merges on the desktop, but the saved connections, which `@epicenter/ai` tests. */
function openModels(account: AuthClient = connectAccount()) {
	return openAi([hosted(account), localModelServers(), localSpeech()]);
}

/** Once the shell said who is signed in. */
function signedIn(account: AuthClient): Promise<void> {
	return new Promise((resolve) => {
		const answer = () => {
			if (account.state().status !== 'signed-in') return false;
			stop();
			resolve();
			return true;
		};
		const stop = account.subscribe(() => void answer());
		answer();
	});
}

afterEach(() => {
	sent.length = 0;
	relayed.length = 0;
	started.length = 0;
});

const upload = () =>
	new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' });

test('Epicenter’s models go through the account’s relay with no token from the page', async () => {
	const account = connectAccount();
	await signedIn(account);
	const ai = openModels(account);
	expect(ai.endpoints().find(({ id }) => id === 'hosted')?.baseUrl).toBe(
		`${ORIGIN}/v1`,
	);
	expect(
		expectOk(
			await ai.transcribe({
				endpoint: 'hosted',
				model: 'whisper-1',
				file: upload(),
			}),
		),
	).toEqual({ text: 'Heard through account_fetch.' });
	expect(relayed.map(({ command, url }) => ({ command, url }))).toEqual([
		{ command: 'account_fetch', url: `${ORIGIN}/v1/audio/transcriptions` },
	]);
});

test('Ollama and LM Studio are looked for through the shell with no key', async () => {
	const endpoints = openModels().endpoints();
	expect(endpoints.map(({ id }) => id)).toEqual([
		'hosted',
		'ollama',
		'lm-studio',
		'local-speech',
	]);
	const ollama = endpoints[1]!;
	await new Promise<void>((resolve) => {
		const stop = ollama.subscribe?.(() => {
			stop?.();
			resolve();
		});
	});
	expect(ollama.models()).toEqual([{ id: 'llama3', can: ['chat'] }]);
	expect(relayed).toContainEqual(
		expect.objectContaining({
			command: 'connection_fetch',
			connection: null,
			url: 'http://localhost:11434/v1/models',
		}),
	);
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

test('the shell’s microphone records recordings/<id> into the data folder, and recovery answers every finished recording by id', async () => {
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
			path: 'recordings/20261031T093000000',
			input: undefined,
			signal: undefined,
		},
	]);
	expect(expectOk(await recording.stop())).toEqual({ durationMs: 1500 });
	// A cut-off recording waits outside its path, so the shell always looks,
	// and audio at its path that no note names is finished.
	// One kept outside its path, because another file is there, is answered
	// as it is, with where its audio is.
	const unplaced = [
		{
			path: 'recordings/c.webm',
			pending: '.epicenter/recordings/recordings/c.webm',
		},
	];
	expect(expectOk(await capture.recover([]))).toEqual({
		whole: [
			{ id: 'a', durationMs: 1500 },
			{ id: 'b', durationMs: 2500 },
		],
		unplaced,
	});
	expect(started.at(-1)).toEqual({
		files: audioFiles,
		under: 'recordings',
		unnamed: [],
	});
	expect(
		expectOk(
			await capture.recover(['recordings/a.webm', 'recordings/left.webm']),
		),
	).toEqual({
		whole: [
			{ id: 'a', durationMs: 1500 },
			{ id: 'b', durationMs: 2500 },
			{ id: 'left', durationMs: null },
		],
		unplaced,
	});
});
