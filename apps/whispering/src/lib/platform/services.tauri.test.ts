/**
 * Desktop Services Tests
 *
 * Whispering's desktop services (`services.tauri.ts`) over a stand-in shell:
 * Tauri's `invoke` answers from memory, so the keychain, the account's
 * commands and the request sender are each one map or one function here,
 * and the local models and the recorder are stand-ins for their packages.
 *
 * Key behaviors:
 * - Connections and keys live in the keychain, under `connections`, never in
 *   the page's storage, and the page is never told a key
 * - A custom endpoint's request leaves through the shell (`send_request`)
 *   with its key; the account's goes through the account's relay
 *   (`account_fetch`) with no token from the page
 * - Local transcription runs the recording's file in the data folder with
 *   the active model; a request prepared for one route never goes to another
 * - The shell's microphone records `recordings/<id>` in the data folder and
 *   repairs by ids; without the data folder's root nothing is made
 */
import { afterEach, expect, mock, test } from 'bun:test';
import type { Client } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Whispering } from '../contract.js';

const ORIGIN = 'http://localhost:8787';
const ROOT = '/Users/me/Epicenter/Whispering';

/** The keychain's entries, by the page's name. */
const keychain = new Map<string, string>();
/** Every command the page sent, with its arguments. */
const sent: { command: string; args?: Record<string, unknown> }[] = [];
/** What `send_request` was asked to send. */
const relayed: { url: string; method: string; headers: [string, string][] }[] =
	[];
let models = [{ id: 'whisper-base', installed: true, active: true }];
let transcribed: unknown[] = [];

type Listener = (message: unknown) => void;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {
		constructor(public onmessage?: Listener) {}
	},
	transformCallback: () => 0,
	invoke: async (
		command: string,
		args?: Record<string, unknown>,
		options?: { headers?: Record<string, string> },
	) => {
		sent.push({ command, args });
		switch (command) {
			case 'keychain_get':
				return Object.fromEntries(
					(args?.names as string[])
						.filter((name) => keychain.has(name))
						.map((name) => [name, keychain.get(name)]),
				);
			case 'keychain_set':
				keychain.set(args?.name as string, args?.value as string);
				return null;
			case 'account_state':
				return {
					origin: ORIGIN,
					signedIn: { origin: ORIGIN, principalId: 'person-1' },
					refused: false,
				};
			case 'account_fetch': {
				const onEvent = args?.onEvent as { onmessage: Listener };
				const body = [
					...new TextEncoder().encode('{"text":"Heard by Epicenter."}'),
				];
				queueMicrotask(() => {
					onEvent.onmessage({
						kind: 'head',
						status: 200,
						headers: [['content-type', 'application/json']],
					});
					onEvent.onmessage(body);
					onEvent.onmessage({ kind: 'end' });
				});
				return null;
			}
			case 'send_request': {
				relayed.push(
					JSON.parse(
						decodeURIComponent(
							options?.headers?.['x-whispering-request'] ?? '',
						),
					),
				);
				return {
					status: 200,
					statusText: 'OK',
					headers: [['content-type', 'application/json']],
					body: btoa(JSON.stringify({ text: 'Sent through the shell.' })),
				};
			}
			default:
				throw new Error(`Unexpected command ${command}`);
		}
	},
}));

mock.module('@epicenter/transcription-native', () => ({
	commands: {
		listInferenceModels: async () => models,
		transcribeFile: async (modelId: string, root: string, path: string) => {
			transcribed.push({ modelId, root, path });
			return {
				data: {
					outcome: 'transcribed',
					text: ' Heard here. ',
					modelId,
					applied: {},
				},
				error: null,
			};
		},
	},
}));

/** The data folder's client, by the root the shell answered when it opened. */
const dataFolder = {} as Client<Whispering>;
mock.module('@epicenter/folder/tauri', () => ({
	rootOf: (client: unknown) => (client === dataFolder ? ROOT : undefined),
}));

/** What the recorder was asked to start or repair. */
const started: unknown[] = [];
mock.module('@epicenter/recorder/tauri', () => ({
	listInputs: async () =>
		Ok([{ id: 'coreaudio:usb', name: 'USB', isDefault: false }]),
	openMeter: async () => {
		throw new Error('not opened');
	},
	startRecording: async (options: { root: string; path: string }) => {
		started.push(options);
		return Ok({
			path: `${options.path}.wav`,
			startedAt: 0,
			device: 'USB',
			onLevel: () => () => {},
			onEnded: () => () => {},
			stop: async () => Ok({ path: `${options.path}.wav`, durationMs: 1500 }),
		});
	},
	recoverRecordings: async (options: { root: string; under: string }) => {
		started.push(options);
		return Ok([`${options.under}/a.wav`, `${options.under}/b.wav`]);
	},
}));

const { createServices, LOCAL_ENDPOINT } = await import('./services.tauri.js');

afterEach(() => {
	keychain.clear();
	sent.length = 0;
	relayed.length = 0;
	started.length = 0;
	transcribed = [];
	models = [{ id: 'whisper-base', installed: true, active: true }];
});

const audio = async () =>
	Ok({
		bytes: new Uint8Array([1, 2, 3]),
		filename: 'a.wav',
		mimeType: 'audio/wav',
	});

const custom = {
	baseUrl: 'http://localhost:9000/v1',
	model: 'whisper-1',
	key: { action: 'replace', key: 'sk-secret' },
} as const;

test('a connection and its key are kept in the keychain, and the page is told no key', async () => {
	const { connections } = createServices(dataFolder);
	const saved = expectOk(await connections.set('transcription', custom));
	expect(saved.transcription).toMatchObject({
		baseUrl: 'http://localhost:9000/v1',
		keyPresent: true,
	});
	expect(JSON.stringify(saved)).not.toContain('sk-secret');
	expect(JSON.parse(keychain.get('connections')!).transcription.apiKey).toBe(
		'sk-secret',
	);
});

test('a custom transcription leaves through the shell with its key', async () => {
	const services = createServices(dataFolder);
	await services.connections.set('transcription', custom);
	const answer = expectOk(
		await services.transcribe({
			audio,
			expectedBaseUrl: 'http://localhost:9000/v1',
			model: 'whisper-1',
		}),
	);
	expect(answer.text).toBe('Sent through the shell.');
	expect(relayed[0]?.url).toBe('http://localhost:9000/v1/audio/transcriptions');
	expect(relayed[0]?.headers).toContainEqual([
		'authorization',
		'Bearer sk-secret',
	]);
});

test('the account’s transcription goes through the account’s relay, with no token from the page', async () => {
	const services = createServices(dataFolder);
	const chosen = expectOk(
		await services.connections.useAccount('transcription'),
	);
	expect(chosen.transcription).toMatchObject({
		baseUrl: `${ORIGIN}/v1`,
		source: 'account',
	});
	expect(
		expectOk(
			await services.transcribe({
				audio,
				expectedBaseUrl: `${ORIGIN}/v1`,
				model: 'whisper-1',
			}),
		).text,
	).toBe('Heard by Epicenter.');
	const fetched = sent.find(({ command }) => command === 'account_fetch');
	const request = fetched?.args?.request as {
		url: string;
		headers: [string, string][];
	};
	expect(request.url).toBe(`${ORIGIN}/v1/audio/transcriptions`);
	expect(request.headers.some(([name]) => name === 'authorization')).toBe(
		false,
	);
	expect(relayed).toEqual([]);
});

test('local transcription runs the recording’s file in the data folder, and keeps the custom one to return to', async () => {
	const services = createServices(dataFolder);
	await services.connections.set('transcription', custom);
	const local = expectOk(await services.connections.useLocal!('transcription'));
	expect(local.transcription).toMatchObject({
		baseUrl: LOCAL_ENDPOINT,
		model: 'whisper-base',
		source: 'local',
	});
	expect(
		expectOk(
			await services.transcribe({
				audio,
				expectedBaseUrl: LOCAL_ENDPOINT,
				model: 'whisper-base',
				audioPath: 'recordings/a.wav',
			}),
		).text,
	).toBe('Heard here.');
	expect(transcribed).toEqual([
		{ modelId: 'whisper-base', root: ROOT, path: 'recordings/a.wav' },
	]);
	expect(relayed).toEqual([]);
	// A request prepared for the endpoint is not sent to this computer instead.
	expect(
		expectErr(
			await services.transcribe({
				audio,
				expectedBaseUrl: 'http://localhost:9000/v1',
				model: 'whisper-1',
			}),
		).name,
	).toBe('ConnectionChanged');
	expect(expectErr(await services.connections.useLocal!('text'))).toContain(
		'Only transcription',
	);
	const back = expectOk(await services.connections.useCustom('transcription'));
	expect(back.transcription).toMatchObject({
		baseUrl: 'http://localhost:9000/v1',
		keyPresent: true,
	});
});

test('local transcription without an active model says where to get one', async () => {
	models = [];
	const services = createServices(dataFolder);
	await services.connections.useLocal!('transcription');
	expect(
		(await services.connections.read()).transcription?.readOnlyReason,
	).toContain('once a model is chosen');
	expect(
		expectErr(
			await services.transcribe({
				audio,
				expectedBaseUrl: LOCAL_ENDPOINT,
				model: '',
				audioPath: 'recordings/a.wav',
			}),
		).name,
	).toBe('NotConfigured');
});

test('what the keychain holds and does not read is never taken for nothing', async () => {
	keychain.set('connections', 'not json');
	await expect(createServices(dataFolder).connections.read()).rejects.toThrow(
		'credential store',
	);
	expectErr(
		await createServices(dataFolder).connections.set('transcription', custom),
	);
	expect(keychain.get('connections')).toBe('not json');
});

test('the shell’s microphone records recordings/<id> in the data folder and repairs by ids', async () => {
	const { capture } = createServices(dataFolder);
	if (capture.keeps !== 'folder')
		throw new Error('the desktop records into its folder');
	expect(expectOk(await capture.inputs!.list()).devices).toEqual([
		{ deviceId: 'coreaudio:usb', label: 'USB' },
	]);
	const recording = expectOk(await capture.start({ id: '20261031T093000000' }));
	expect(started).toEqual([
		{
			root: ROOT,
			path: 'recordings/20261031T093000000',
			input: undefined,
			signal: undefined,
		},
	]);
	expect(expectOk(await recording.stop())).toEqual({ durationMs: 1500 });
	expect(expectOk(await capture.recover())).toEqual(['a', 'b']);
	expect(started.at(-1)).toEqual({ root: ROOT, under: 'recordings' });
});

test('without the data folder’s root nothing is made, so nothing records into AppData', () => {
	expect(() => createServices({} as Client<Whispering>)).toThrow('data folder');
});
