/**
 * Desktop Services Tests
 *
 * Whispering's desktop services (`services.tauri.ts`) over a stand-in shell:
 * Tauri's `invoke` answers from memory, so the credential store, the
 * account's commands, the shell's fetch and the transcription plugin are
 * each one map or one function here. AppData is a real directory
 * (`openDevice` from `@epicenter/folder/node`), and the recorder is a
 * stand-in for its package.
 *
 * Key behaviors:
 * - A saved connection is listed in AppData's `connections.md` with no key,
 *   its key is in the credential store, and the page is never told it
 * - A connection's request leaves through the shell by its id, which adds
 *   the key; the page sends none
 * - Epicenter's models go through the account's relay (`account_fetch`)
 *   with no token from the page
 * - Ollama and LM Studio are looked for through the shell with no key
 * - Transcription on this computer takes the uploaded audio
 * - The shell's microphone records `recordings/<id>` in the data folder and
 *   repairs by ids, with each repaired recording's length
 */
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAi } from '@epicenter/ai';
import type { Client } from '@epicenter/definition/contract';
import { openDevice } from '@epicenter/folder/node';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { Whispering } from '../contract.js';
import { whisperingSettings } from '../settings.tauri.js';

const ORIGIN = 'http://localhost:8787';

/** The credential store's entries, by the page's name. */
const keychain = new Map<string, string>();
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
			case 'keychain_get':
				return Object.fromEntries(
					(args as { names: string[] }).names
						.filter((name) => keychain.has(name))
						.map((name) => [name, keychain.get(name)]),
				);
			case 'keychain_set': {
				const value = args?.value as string | null;
				if (value === null) keychain.delete(args?.name as string);
				else keychain.set(args?.name as string, value);
				return null;
			}
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

/** AppData, a real directory. */
const appData = await mkdtemp(join(tmpdir(), 'whispering-appdata-'));
afterAll(() => rm(appData, { recursive: true, force: true }));
mock.module('@epicenter/folder/tauri', () => ({
	openAppData: async () =>
		Ok(unwrap(await openDevice(whisperingSettings, { path: appData }))),
}));

/** The data folder's client; the services only hand it to the recorder. */
const dataFolder = {} as Client<Whispering>;

/** What the recorder was asked to start or repair. */
const started: unknown[] = [];
mock.module('@epicenter/recorder/tauri', () => ({
	recorder: {
		placesWhole: true,
		listInputs: async () =>
			Ok({ inputs: [{ deviceId: 'coreaudio:usb', label: 'USB' }] }),
		openMeter: async () => {
			throw new Error('not opened');
		},
		start: async (options: { device: unknown; path: string }) => {
			started.push(options);
			return Ok({
				onEnded: () => () => {},
				stop: async () =>
					Ok({ path: `${options.path}.webm`, durationMs: 1500 }),
			});
		},
		recover: async (options: { device: unknown; under: string }) => {
			started.push(options);
			return Ok({
				recovered: [
					{ path: `${options.under}/a.webm`, durationMs: 1500 },
					{ path: `${options.under}/b.webm`, durationMs: 2500 },
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

const { createServices } = await import('./services.tauri.js');
const { authReady } = await import('./auth.tauri.js');

afterEach(() => {
	keychain.clear();
	sent.length = 0;
	relayed.length = 0;
	started.length = 0;
});

const upload = () =>
	new File([new Uint8Array([1, 2, 3])], 'a.webm', { type: 'audio/webm' });

test('a saved connection is listed in AppData with no key, its key is in the credential store, and the page is never told it', async () => {
	const connections =
		await createServices(dataFolder).endpoints.openConnections();
	const id = await connections.add({
		name: 'Speaches',
		baseUrl: 'http://localhost:9000/v1',
		apiKey: 'sk-secret',
		models: ['whisper-1'],
	});
	const note = await readFile(join(appData, 'connections.md'), 'utf8');
	expect(note).toContain('http://localhost:9000/v1');
	expect(note).not.toContain('sk-secret');
	expect(JSON.parse(keychain.get(id) ?? 'null')).toEqual({
		endpoint: 'http://localhost:9000/v1',
		key: 'sk-secret',
	});
	expect(connections.getAll()).toEqual([
		{
			id,
			name: 'Speaches',
			baseUrl: 'http://localhost:9000/v1',
			models: ['whisper-1'],
			hasApiKey: true,
		},
	]);
	await connections.remove(id);
	await connections.close();
});

test('a connection’s request leaves through the shell by its id, which adds the key; the page sends none', async () => {
	const connections =
		await createServices(dataFolder).endpoints.openConnections();
	const id = await connections.add({
		baseUrl: 'http://localhost:9000/v1',
		apiKey: 'sk-secret',
		models: ['whisper-1'],
	});
	const [record] = connections.getAll();
	const ai = openAi([connections.endpoint(record!)]);
	sent.length = 0;
	expect(
		expectOk(
			await ai.transcribe({ endpoint: id, model: 'whisper-1', file: upload() }),
		),
	).toEqual({ text: 'Heard through connection_fetch.' });
	expect(relayed).toEqual([
		expect.objectContaining({
			command: 'connection_fetch',
			connection: id,
			url: 'http://localhost:9000/v1/audio/transcriptions',
		}),
	]);
	expect(
		relayed[0]!.headers.some(
			([name]) => name.toLowerCase() === 'authorization',
		),
	).toBe(false);
	expect(JSON.stringify(sent)).not.toContain('sk-secret');
	await connections.remove(id);
	await connections.close();
});

test('Epicenter’s models go through the account’s relay with no token from the page', async () => {
	await authReady();
	const hosted = createServices(dataFolder).endpoints.hosted();
	expect(hosted.baseUrl).toBe(`${ORIGIN}/v1`);
	const ai = openAi([hosted]);
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
	const { local } = createServices(dataFolder).endpoints;
	expect(local.map(({ id }) => id)).toEqual([
		'ollama',
		'lm-studio',
		'local-speech',
	]);
	const ollama = local[0]!;
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
	const ai = openAi([createServices(dataFolder).endpoints.local]);
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

test('the shell’s microphone records recordings/<id> into the data folder’s device, and recovery answers every finished recording by id', async () => {
	const { capture } = createServices(dataFolder);
	expect(expectOk(await capture.inputs.listInputs()).inputs).toEqual([
		{ deviceId: 'coreaudio:usb', label: 'USB' },
	]);
	const recording = expectOk(await capture.start({ id: '20261031T093000000' }));
	expect(started).toEqual([
		{
			device: dataFolder,
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
	expect(started.at(-1)).toEqual({ device: dataFolder, under: 'recordings' });
	expect(expectOk(await capture.recover(['a', 'left']))).toEqual({
		whole: [
			{ id: 'a', durationMs: 1500 },
			{ id: 'b', durationMs: 2500 },
			{ id: 'left', durationMs: null },
		],
		unplaced,
	});
});
