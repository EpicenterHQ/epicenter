/**
 * The desktop app's `#platform/*` leaves over a stand-in shell: Tauri's
 * `invoke` answers from memory, so the credential store, the account
 * commands, the request sender and the local models are each one map or
 * one function here. What they promise:
 *
 * - connections and keys live in the credential store, never the page's
 *   storage, and the page is never told a key;
 * - transcription goes to a custom endpoint or the account through the
 *   shell's sender, or to a local model with the recording's folder path;
 *   a request prepared for one route never goes to another;
 * - an Account sends with a fresh token through the shell, only to its own
 *   server, and is retired by sign-out or another sign-in;
 * - the shell's microphone records `recordings/<id>` and repairs by ids.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';

const secrets = new Map<string, string>();
let accountState: Record<string, unknown> = {
	status: 'signed-out',
	baseUrl: 'http://localhost:8787',
};
let token = 'token-1';
const sent: { url: string; method: string; headers: [string, string][] }[] = [];
let transcribed: unknown[] = [];
let models = [{ id: 'whisper-base', installed: true, active: true }];

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	Channel: class {},
	transformCallback: () => 0,
	invoke: async (
		command: string,
		args?: Record<string, unknown>,
		options?: { headers?: Record<string, string> },
	) => {
		switch (command) {
			case 'secret_get':
				return secrets.get(args?.name as string) ?? null;
			case 'secret_set':
				secrets.set(args?.name as string, args?.value as string);
				return null;
			case 'account_state':
				return accountState;
			case 'account_sign_in':
				accountState = {
					status: 'signed-in',
					baseUrl: 'http://localhost:8787',
					principalId: 'p1',
					generation: `g${Math.random()}`,
					name: 'Ada',
					email: 'ada@example.com',
				};
				return accountState;
			case 'account_sign_out':
				accountState = {
					status: 'signed-out',
					baseUrl: 'http://localhost:8787',
				};
				return accountState;
			case 'account_token':
				if (token === 'refused') throw 'reauth-required: invalid_grant';
				return token;
			case 'send_request': {
				const described = JSON.parse(
					decodeURIComponent(options?.headers?.['x-whispering-request'] ?? ''),
				);
				sent.push(described);
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
		transcribeFile: async (modelId: string, path: string) => {
			transcribed.push({ modelId, path });
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

const { createServices, LOCAL_ENDPOINT } = await import('./services.tauri.js');
const { getAuth } = await import('./auth.tauri.js');
const { createShellMicrophone } = await import('./microphone.tauri.js');

afterEach(() => {
	secrets.clear();
	sent.length = 0;
	transcribed = [];
	token = 'token-1';
	models = [{ id: 'whisper-base', installed: true, active: true }];
});

const audio = async () =>
	Ok({
		bytes: new Uint8Array([1, 2, 3]),
		filename: 'a.wav',
		mimeType: 'audio/wav',
	});

test('a connection and its key are kept in the credential store, and the page is told no key', async () => {
	const { connections } = createServices();
	const saved = expectOk(
		await connections.set('transcription', {
			baseUrl: 'http://localhost:9000/v1',
			model: 'whisper-1',
			key: { action: 'replace', key: 'sk-secret' },
		}),
	);
	expect(saved.transcription).toMatchObject({
		baseUrl: 'http://localhost:9000/v1',
		keyPresent: true,
	});
	expect(JSON.stringify(saved)).not.toContain('sk-secret');
	expect(JSON.parse(secrets.get('connections')!).transcription.apiKey).toBe(
		'sk-secret',
	);
});

test('a custom transcription leaves through the shell with its key', async () => {
	const services = createServices();
	await services.connections.set('transcription', {
		baseUrl: 'http://localhost:9000/v1',
		model: 'whisper-1',
		key: { action: 'replace', key: 'sk-secret' },
	});
	const answer = expectOk(
		await services.transcribe({
			audio,
			expectedBaseUrl: 'http://localhost:9000/v1',
			model: 'whisper-1',
		}),
	);
	expect(answer.text).toBe('Sent through the shell.');
	expect(sent[0]?.url).toBe('http://localhost:9000/v1/audio/transcriptions');
	expect(sent[0]?.headers).toContainEqual([
		'authorization',
		'Bearer sk-secret',
	]);
});

test('local transcription runs the recording’s file with the active model, and keeps the custom one to return to', async () => {
	const services = createServices();
	await services.connections.set('transcription', {
		baseUrl: 'http://localhost:9000/v1',
		model: 'whisper-1',
		key: { action: 'replace', key: 'sk-secret' },
	});
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
		{ modelId: 'whisper-base', path: 'recordings/a.wav' },
	]);
	expect(sent).toEqual([]);
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
	const custom = expectOk(
		await services.connections.useCustom('transcription'),
	);
	expect(custom.transcription).toMatchObject({
		baseUrl: 'http://localhost:9000/v1',
		keyPresent: true,
	});
});

test('local transcription without an active model says where to get one', async () => {
	models = [];
	const services = createServices();
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

test('what the credential store holds and does not read is never taken for nothing', async () => {
	secrets.set('connections', 'not json');
	await expect(createServices().connections.read()).rejects.toThrow(
		'credential store',
	);
});

test('an account sends with a fresh token through the shell, to its own server only, until retired', async () => {
	const auth = getAuth();
	expectOk(await auth.startSignIn());
	const state = auth.state;
	if (state.status !== 'signed-in') throw new Error('not signed in');
	const { account } = state;
	expect(auth.baseURL).toBe('http://localhost:8787');
	await account.fetch('http://localhost:8787/v1/audio/transcriptions', {
		method: 'POST',
	});
	expect(sent.at(-1)?.headers).toContainEqual([
		'authorization',
		'Bearer token-1',
	]);
	await expect(account.fetch('https://elsewhere.example/v1')).rejects.toThrow(
		'the server they signed in to',
	);
	token = 'refused';
	await expect(
		account.fetch('http://localhost:8787/v1/x'),
	).rejects.toMatchObject({
		name: 'AccountUnavailable',
	});
	// Another sign-in retires this account; sign-out retires the next.
	expectOk(await auth.startSignIn());
	expect(account.signal.aborted).toBe(true);
	const next = auth.state.account!;
	expectOk(await auth.signOut());
	expect(next.signal.aborted).toBe(true);
	expect(auth.state.status).toBe('signed-out');
});

test('the shell microphone records recordings/<id> and repairs by ids', async () => {
	const started: unknown[] = [];
	const microphone = createShellMicrophone({
		listInputs: async () =>
			Ok([{ id: 'coreaudio:usb', name: 'USB', isDefault: false }]),
		openMeter: async () => {
			throw new Error('not opened');
		},
		startRecording: async (options) => {
			started.push(options.path);
			return Ok({
				path: `${options.path}.wav`,
				startedAt: 0,
				device: 'USB',
				onLevel: () => () => {},
				onEnded: () => () => {},
				stop: async () => Ok({ path: `${options.path}.wav`, durationMs: 1500 }),
			});
		},
		recoverRecordings: async ({ under }) =>
			Ok([`${under}/a.wav`, `${under}/b.wav`]),
	});
	expect(microphone.keeps).toBe('folder');
	expect(expectOk(await microphone.inputs!.list()).devices).toEqual([
		{ deviceId: 'coreaudio:usb', label: 'USB' },
	]);
	const capture = expectOk(
		await microphone.start({ id: '20261031T093000000' }),
	);
	expect(started).toEqual(['recordings/20261031T093000000']);
	expect(expectOk(await capture.stop())).toEqual({ durationMs: 1500 });
	expect(expectOk(await microphone.recover())).toEqual(['a', 'b']);
});
