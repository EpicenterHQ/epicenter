/**
 * Opening a workspace, and the desktop workspace: Whispering in Epicenter.
 *
 * The shell's replies are scripted here, so these pin what the page itself
 * decides: that the browser workspace refuses inside a desktop app, that the
 * desktop one names a registered directory and never a path, that a refusal
 * is returned and nothing else is opened in its place, and that the folder's
 * changes go to the shell. The shell grants a real directory, and the page's
 * own folder engine opens it (`granted-shell.test-support.ts` in the folder
 * package); nothing here runs the Rust shell or a WebView.
 *
 * The desktop opener over a registered directory is the folder package's
 * `openTauriFolder`, reached here by its module until a public entry
 * exports it; the workspace takes it as `openDirectory`.
 *
 * The connections are rows of a real `so.epicenter` folder on disk, opened
 * with Whispering's one table of it. The AI commands are scripted with the
 * code the `epicenter` CLI runs (`@epicenter/ai/send`) over an in-memory
 * keychain and a stubbed endpoint, so a test about a key or a request runs
 * against what the CLI really checks and sends. Local transcription answers
 * with scripted shell commands.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONNECTIONS_FOLDER_ID } from '@epicenter/ai/connection-table';
import {
	base64ToBytes,
	createMemorySecrets,
	keyState,
	responseEvents,
	saveKey,
	sendRequest,
} from '@epicenter/ai/send';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
	shellArguments,
} from '../../../../../packages/folder/src/granted-shell.test-support.js';
import { openBunFolder } from '../../../../../packages/folder/src/native/bun.js';
import { toneWav } from '../capture.js';
import { readBytes } from '../files.js';
import {
	type ConnectionCommands,
	connectionsTables,
} from './desktop-connections.js';
import type { LocalTranscriptionCommands } from './local-transcription.js';

type Call = { cmd: string; args: Record<string, unknown> };

/** Every command the page sent the shell. */
let calls: Call[] = [];
/** The shell, once a test has one grant a directory. */
let shell: GrantedShell | undefined;

mock.module('@tauri-apps/api/core', () => ({
	// What Epicenter's generated bindings import beside `invoke`; nothing here
	// opens a channel.
	transformCallback: () => 0,
	Channel: class {},
	isTauri: () => true,
	async invoke(
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		calls.push({ cmd: name, args: shellArguments(body, options) });
		if (shell === undefined) throw new Error(`no shell for ${name}`);
		return shell.invoke(cmd, body, options);
	},
}));

// The shell's watcher: nothing here changes the directory behind the page.
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));

const { openWorkspace: openBrowserWorkspace } = await import('./browser.js');
const { openDesktopWorkspace, openWorkspace } = await import('./desktop.js');
const { openTauriFolder } = await import(
	'../../../../../packages/folder/src/native/tauri.js'
);

const ORIGIN = 'epicenter-app://localhost';
const SCOPE = 'so.epicenter.whispering';
const ENDPOINT = 'http://127.0.0.1:18080/v1';

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	calls = [];
	shell = undefined;
	const scope = globalThis as { location?: unknown; localStorage?: unknown };
	delete scope.location;
	delete scope.localStorage;
});

/** A shell that grants this window a new empty directory. */
async function granted() {
	const directory = await grantedDirectory();
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	shell = createGrantedShell(directory);
	// The recorder plugin beside the folder: no recording was ever cut off
	// here, so there is nothing to repair.
	const folderCommands = shell.invoke;
	shell.invoke = async (cmd, body, options) =>
		cmd === 'plugin:epicenter-recorder|recover'
			? []
			: folderCommands(cmd, body, options);
	return shell;
}

/** The globals a page served by Epicenter has: its origin, and the origin's storage. */
function setup(stored = new Map<string, string>()) {
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL(`${ORIGIN}/apps/so.epicenter.whispering/`),
	});
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
			removeItem: (key: string) => void stored.delete(key),
		},
	});
	return stored;
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);

const unexpected = () => {
	throw new Error('unexpected command');
};
/** Shell commands nobody should reach: local transcription is not under test. */
const noCommands: LocalTranscriptionCommands = {
	getLocalTranscriptionReadiness: unexpected,
	listInferenceModels: unexpected,
	transcribeAudioBytes: unexpected,
	openHome: unexpected,
};

/** The desktop workspace over the scripted shell, on `SCOPE` unless told otherwise. */
const openDesktop = (
	options: Partial<Parameters<typeof openDesktopWorkspace>[0]> = {},
) =>
	openDesktopWorkspace({
		openDirectory: openTauriFolder,
		directory: SCOPE,
		commands: noCommands,
		...options,
	});

/** A provider's request, as the stubbed endpoint received it. */
type ProviderCall = {
	url: string;
	authorization: string | null;
	cookie: string | null;
	body: Request;
};

/**
 * Epicenter as Whispering's connections reach it: a real `so.epicenter`
 * folder on disk, and the AI commands answered by the code `epicenter send`
 * and `epicenter auth key` run, over an in-memory keychain and an endpoint
 * that answers every request. `keychain` is what the CLI would hold; the
 * page is never handed it.
 */
async function epicenter() {
	// Epicenter's own folder, where its connections are rows.
	const root = join(
		await mkdtemp(join(tmpdir(), 'whispering-so-epicenter-')),
		CONNECTIONS_FOLDER_ID,
	);
	await mkdir(root);
	const keychain = createMemorySecrets();
	const provider: ProviderCall[] = [];
	/** Every line the page was sent. */
	const lines: string[] = [];
	let losing = false;
	const endpoint = (async (
		input: URL | string | Request,
		init?: RequestInit,
	) => {
		const request = new Request(input, init);
		provider.push({
			url: request.url,
			authorization: request.headers.get('authorization'),
			cookie: request.headers.get('cookie'),
			body: request,
		});
		if (request.url.endsWith('/audio/transcriptions'))
			return Response.json({ text: 'a steady tone' });
		return Response.json({
			choices: [{ message: { role: 'assistant', content: 'A steady tone.' } }],
		});
	}) as typeof fetch;
	const ai: ConnectionCommands = {
		async authStatus() {
			return {
				status: 'ok',
				data: { origin: 'https://api.example.test', grants: [] },
				error: null,
			};
		},
		async aiKeyState(connection) {
			const { data, error } = await keyState(keychain, connection);
			return error === null
				? { status: 'ok', data, error: null }
				: {
						status: 'error',
						data: null,
						error: { name: 'Refused', message: error.message },
					};
		},
		async aiKeySet(connection, url, key) {
			const { data, error } = await saveKey(keychain, connection, {
				endpoint: url,
				key,
			});
			return error === null
				? { status: 'ok', data, error: null }
				: {
						status: 'error',
						data: null,
						error: { name: 'Refused', message: error.message },
					};
		},
		async aiSend(target, request, channel) {
			const deliver = (line: string) => {
				lines.push(line);
				channel.onmessage(line);
			};
			const { data: response, error } = await sendRequest({
				target,
				request: {
					...request,
					body: request.body === null ? undefined : base64ToBytes(request.body),
				},
				secrets: keychain,
				fetch: endpoint,
			});
			// The CLI sent it and got an answer; the answer is lost on its way back.
			if (losing) throw new Error('Load failed');
			if (error !== null)
				deliver(
					JSON.stringify({
						type: 'error',
						name: error.name,
						message: error.message,
					}),
				);
			else
				for await (const event of responseEvents(response))
					deliver(JSON.stringify(event));
			const exit = { code: error === null ? 0 : 2, stderr: '' };
			deliver(JSON.stringify({ type: 'exit', ...exit }));
			return { status: 'ok', data: { ...exit, reply: null }, error: null };
		},
	} as ConnectionCommands;
	cleanups.push(() => rm(dirname(root), { recursive: true, force: true }));
	return {
		root,
		keychain,
		provider,
		lines,
		ai,
		open: () => openBunFolder({ directory: root, tables: connectionsTables }),
		lose(next: boolean) {
			losing = next;
		},
	};
}

type Epicenter = Awaited<ReturnType<typeof epicenter>>;

/** The desktop workspace over `host`'s connections. */
const openWith = (host: Epicenter) =>
	openDesktop({
		connectionCommands: host.ai,
		openConnectionsFolder: host.open,
	});

// ============================================================================
// The browser workspace inside a desktop app
// ============================================================================

test('the browser workspace refuses inside a desktop app, and opens nothing in its place', async () => {
	setup();
	const inside = expectErr(await openBrowserWorkspace());
	expect(inside.name).toBe('BrowserFolder');
	if (inside.name === 'BrowserFolder')
		expect(inside.refusal.name).toBe('InsideTauri');
	expect(inside.message).toContain('Browser storage is not used');
	expect(calls).toEqual([]);
});

// ============================================================================
// Opening
// ============================================================================

test('the page names the registered directory by its ID and nothing else, and opening writes nothing', async () => {
	setup();
	const { root } = await granted();

	const workspace = expectOk(await openDesktop());

	// The window asks for its directory by ID; no root, author, or branch.
	expect(calls[0]).toEqual({ cmd: 'grant_directory', args: { scope: SCOPE } });
	expect(sent('grant_directory')).toHaveLength(1);
	// Everything after the grant names the folder, never another.
	for (const call of calls.slice(1)) expect(call.args.scope).toBe(SCOPE);
	expect(workspace.folderId).toBe(SCOPE);
	expect(workspace.location).toBe('The folder opened in Epicenter');
	expect(workspace.capture.source).toBe('microphone');
	// No declaration, ignore file, or repository is made.
	expect(await readdir(root)).toEqual([]);
	await workspace.close();
});

test('the page opens the folder handed to its window, whatever app name it was handed under', async () => {
	for (const handed of [
		// The bundled page on its default folder, and on a listed one.
		{ app: 'so.epicenter.whispering', folder: 'data:Whispering' },
		{ app: 'so.epicenter.whispering', folder: 'data:other' },
		// A name other than Whispering's own: the page checks none.
		{ app: 'com.example.voice', folder: 'data:other' },
	]) {
		setup();
		calls = [];
		const granting = await granted();
		granting.control.window = handed;

		const workspace = expectOk(await openWorkspace());
		expect(calls[0]).toEqual({ cmd: 'window_folder', args: {} });
		expect(sent('window_folder')).toHaveLength(1);
		expect(sent('grant_directory')[0]?.args.scope).toBe(handed.folder);
		expect(workspace.folderId).toBe(handed.folder);
		await workspace.close();
	}
});

test('a window handed no folder is refused, and nothing is opened in its place', async () => {
	setup();
	const granting = await granted();
	granting.control.window = null;

	const refused = expectErr(await openWorkspace());
	expect(refused.name).toBe('DesktopFolder');
	if (refused.name === 'DesktopFolder')
		expect(refused.refusal.name).toBe('NotAssigned');
	expect(calls.map((call) => call.cmd)).toEqual(['window_folder']);
});

test('a refusal from the shell is returned, and nothing is opened in its place', async () => {
	setup();
	for (const refusal of [
		{ name: 'UnknownScope', scope: SCOPE },
		{ name: 'WindowNotPermitted', scope: SCOPE, window: 'other' },
		// What Tauri answers a window with no capability for the plugin.
		'epicenter-folder.grant_directory not allowed',
	]) {
		calls = [];
		(await granted()).control.grant = () => {
			throw refusal;
		};

		const refused = expectErr(await openDesktop());

		expect(refused.name).toBe('DesktopFolder');
		if (refused.name === 'DesktopFolder')
			expect<string>(refused.refusal.name).toBe(
				typeof refusal === 'string' ? 'Unavailable' : refusal.name,
			);
		expect(calls.map((call) => call.cmd)).toEqual(['grant_directory']);
	}
});

// ============================================================================
// The folder is the shell's
// ============================================================================

test('opening repairs the recordings a quit cut off, and a repair that fails is the capture notice', async () => {
	setup();
	const granting = await granted();
	const invoke = granting.invoke;
	const asked: Record<string, unknown>[] = [];
	let refuse = false;
	granting.invoke = async (cmd, body, options) => {
		if (cmd !== 'plugin:epicenter-recorder|recover')
			return invoke(cmd, body, options);
		asked.push(shellArguments(body, options));
		if (refuse) throw { name: 'Failed', message: 'the disk is gone' };
		return [];
	};

	const repaired = expectOk(await openDesktop());
	expect(asked).toEqual([{ scope: repaired.folderId, under: 'audio' }]);
	expect(repaired.captureNotice).toBeUndefined();
	await repaired.close();

	refuse = true;
	const unrepaired = expectOk(await openDesktop());
	expect(unrepaired.captureNotice).toContain('could not be checked');
	expect(unrepaired.captureNotice).toContain('the disk is gone');
	await unrepaired.close();
});

test('saves go through the shell: audio lands as its exact bytes, and a row as text', async () => {
	setup();
	const { root } = await granted();
	const workspace = expectOk(await openDesktop());
	const audio = new Uint8Array([1, 2, 3, 0, 255]);

	expectOk(await workspace.folder.files.write('audio/a.wav', null, audio));
	expectOk(
		await workspace.folder.tables.transformations.set('clean', null, {
			fields: { title: 'Clean up', model: null },
			body: 'Tidy.\n',
		}),
	);
	expect(expectOk(await workspace.folder.files.read('missing.md'))).toBe(
		undefined,
	);

	// The recording's bytes reach the shell as a raw body, in the one call
	// that puts them at their path, and land exactly.
	const put = sent('put_folder_file').find(
		(call) => call.args.path === 'audio/a.wav',
	);
	expect(put?.args.bytes).toEqual(audio);
	expect(new Uint8Array(await readFile(join(root, 'audio', 'a.wav')))).toEqual(
		audio,
	);
	expect(expectOk(await readBytes(workspace.folder, 'audio/a.wav'))).toEqual(
		audio,
	);
	expect(
		await readFile(join(root, 'transformations', 'clean.md'), 'utf8'),
	).toContain('title: Clean up');
	await workspace.close();
});

test('a row save whose reply the shell never sent is confirmed by what landed, and is not reported saved when that cannot be read', async () => {
	setup();
	const granting = await granted();
	const PATH = 'transformations/clean.md';
	await granting.write(PATH, '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n');
	const workspace = expectOk(await openDesktop());
	const table = workspace.folder.tables.transformations;
	const stored = expectOk(await table.get('clean'))!;

	// The shell writes, and its reply never reaches the page. The page reads
	// the file back, finds exactly what it wrote, and the save is confirmed.
	granting.control.loseReplies = 1;
	const confirmed = expectOk(
		await table.set('clean', stored, { body: 'Tidy it.\n' }),
	);
	expect(confirmed.sent.body).toBe('Tidy it.\n');
	expect(granting.kinds).toEqual(['write']);

	// Again, and now the file cannot be read back either: nothing says
	// whether the save landed, so it is a failure the person is told of.
	granting.control.loseReplies = 1;
	granting.control.beforeChange = async () => {
		granting.control.beforeChange = undefined;
		granting.control.failReads.add(PATH);
	};
	const lost = await table.set('clean', confirmed.sent, {
		body: 'Tidy it again.\n',
	});
	expect(lost.error?.name).toBe('StorageFailed');
	expect(granting.kinds).toEqual(['write', 'write']);

	granting.control.failReads.delete(PATH);
	const landed = expectOk(await table.get('clean'));
	expect(landed?.body).toBe('Tidy it again.\n');
	await workspace.close();
});

// ============================================================================
// Connections are rows of so.epicenter, and keys stay in the keychain
// ============================================================================

test('a connection is a row of so.epicenter with its endpoint and key in the keychain; the page is told whether a key is set and never the key', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const first = expectOk(await openWith(host));
	expect(await first.connections.read()).toEqual({
		transcription: undefined,
		text: undefined,
	});

	const saved = expectOk(
		await first.connections.set('text', {
			baseUrl: `${ENDPOINT}/`,
			model: 'chat-model',
			key: { action: 'replace', key: 'device-secret-key' },
		}),
	);
	expect(saved.text).toEqual({
		baseUrl: ENDPOINT,
		model: 'chat-model',
		keyPresent: true,
		readOnlyReason: undefined,
	});
	// One row, named for what it is, holding no endpoint and no key.
	const row = await readFile(
		join(host.root, 'connections/whispering-text.md'),
		'utf8',
	);
	expect(row).toContain('kind: openai-compatible');
	expect(row).toContain('title: Whispering text');
	expect(row).toContain('model: chat-model');
	expect(row).not.toContain(ENDPOINT);
	expect(row).not.toContain('device-secret-key');
	expect(await host.keychain.get('whispering-text')).toBe(
		JSON.stringify({ endpoint: ENDPOINT, key: 'device-secret-key' }),
	);

	// The key is never carried to another base URL.
	const moved = await first.connections.set('text', {
		baseUrl: 'http://127.0.0.1:18081/v1',
		model: 'chat-model',
		key: { action: 'keep' },
	});
	expect(moved.error).toContain('the saved key is not sent there');
	expect(
		JSON.parse((await host.keychain.get('whispering-text'))!).endpoint,
	).toBe(ENDPOINT);
	await first.close();

	// Another window reads the same row; removing the key keeps the endpoint.
	const second = expectOk(await openWith(host));
	expect((await second.connections.read()).text?.keyPresent).toBe(true);
	const removed = expectOk(
		await second.connections.set('text', {
			baseUrl: ENDPOINT,
			model: 'other-model',
			key: { action: 'remove' },
		}),
	);
	expect(removed.text).toMatchObject({
		baseUrl: ENDPOINT,
		model: 'other-model',
		keyPresent: false,
	});
	expect(await host.keychain.get('whispering-text')).toBe(
		JSON.stringify({ endpoint: ENDPOINT, key: '' }),
	);
	// The row keeps its title and every field another program added.
	expect(
		await readFile(join(host.root, 'connections/whispering-text.md'), 'utf8'),
	).toContain('title: Whispering text');
	await second.close();

	// A row synced from another computer is not set up here until this
	// computer saves its endpoint.
	await host.keychain.delete('whispering-text');
	const third = expectOk(await openWith(host));
	expect((await third.connections.read()).text).toBeUndefined();
	await third.close();
});

test('a connection row that does not read is reported, never taken for none', async () => {
	setup();
	await granted();
	const host = await epicenter();
	await mkdir(join(host.root, 'connections'), { recursive: true });
	await Bun.write(
		join(host.root, 'connections/whispering-text.md'),
		'---\nkind: [open\n---\n',
	);
	const workspace = expectOk(await openWith(host));

	await expect(workspace.connections.read()).rejects.toThrow(
		'does not read as a connection',
	);
	await workspace.close();
});

test('a transcription reads the audio through the shell and Epicenter sends it with the key, only while the connection is the one it was prepared for', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));
	const request = {
		audioPath: 'audio/take.wav',
		expectedBaseUrl: ENDPOINT,
		model: 'whisper-1',
	};

	// Nothing set up: nothing is read or sent.
	const { error: none } = await workspace.transcribe(request);
	expect(none?.name).toBe('ConnectionUnavailable');
	expect(host.provider).toEqual([]);

	expectOk(
		await workspace.connections.set('transcription', {
			baseUrl: ENDPOINT,
			model: 'whisper-1',
			key: { action: 'replace', key: 'transcription-key' },
		}),
	);
	expect(expectOk(await workspace.transcribe(request))).toEqual({
		text: 'a steady tone',
	});
	expect(host.provider).toHaveLength(1);
	const [call] = host.provider;
	expect(call?.url).toBe(`${ENDPOINT}/audio/transcriptions`);
	expect(call?.authorization).toBe('Bearer transcription-key');
	expect(call?.cookie).toBeNull();
	const form = await call!.body.formData();
	const file = form.get('file') as File;
	expect(file.name).toBe('take.wav');
	expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(
		Array.from(toneWav()),
	);
	expect(form.get('model')).toBe('whisper-1');
	// The page read the audio through the shell, and was never sent the key.
	expect(
		sent('read_folder_file').some((read) =>
			String(read.args.path).endsWith('audio/take.wav'),
		),
	).toBe(true);
	expect(host.lines.join('\n')).not.toContain('transcription-key');

	// A request prepared for another base URL is not sent.
	const { error: changed } = await workspace.transcribe({
		...request,
		expectedBaseUrl: 'http://127.0.0.1:18081/v1',
	});
	expect(changed?.name).toBe('ConnectionChanged');
	// Audio that cannot be read is certain: nothing is sent.
	const { error: unreadable } = await workspace.transcribe({
		...request,
		audioPath: 'audio/gone.wav',
	});
	expect(unreadable?.name).toBe('AudioUnreadable');
	expect(host.provider).toHaveLength(1);
	await workspace.close();
});

test('a reply Epicenter never delivered is reported as unknown, never as not sent, and nothing is sent again', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));
	for (const operation of ['transcription', 'text'] as const)
		expectOk(
			await workspace.connections.set(operation, {
				baseUrl: ENDPOINT,
				model: 'model',
				key: { action: 'replace', key: 'test-key' },
			}),
		);
	const transformation = {
		expectedBaseUrl: ENDPOINT,
		model: 'model',
		prompt: 'Fix the punctuation.',
		input: 'um so a steady tone',
	};
	host.lose(true);

	const transcribed = await workspace.transcribe({
		audioPath: 'audio/take.wav',
		expectedBaseUrl: ENDPOINT,
		model: 'model',
	});
	const transformed = await workspace.transform(transformation);

	// The endpoint was called, once each, and the page was not told the answer.
	expect(host.provider).toHaveLength(2);
	for (const { data: answer, error: lost } of [transcribed, transformed]) {
		expect(answer).toBeNull();
		expect(lost?.name).toBe('HostUnavailable');
		expect(lost?.message).toContain(
			'it is not known whether the request was sent',
		);
		expect(lost?.message).toContain('Load failed');
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(host.provider).toHaveLength(2);

	// Asking again is the person's choice, and it is one more request.
	host.lose(false);
	expect(expectOk(await workspace.transform(transformation))).toEqual({
		text: 'A steady tone.',
	});
	expect(host.provider).toHaveLength(3);
	await workspace.close();
});

// ============================================================================
// The chosen microphone
// ============================================================================

test('the chosen microphone is kept in the origin’s storage and survives a new window', async () => {
	const stored = setup();
	await granted();
	const usb = { deviceId: 'usb-id', label: 'USB Microphone' };
	const first = expectOk(await openDesktop());
	expect(await first.preferences.microphone()).toBeUndefined();
	expect(await first.preferences.setMicrophone(usb)).toBeUndefined();
	await first.close();

	const second = expectOk(await openDesktop());
	expect(await second.preferences.microphone()).toEqual(usb);
	expect(await second.preferences.setMicrophone(undefined)).toBeUndefined();
	expect(stored.has('whispering.microphone')).toBe(false);
	await second.close();
});

// ============================================================================
// Transcription on this computer
// ============================================================================

type LocalOutcome =
	| { outcome: 'transcribed'; text: string }
	| { outcome: 'empty-audio' }
	| { error: { name: string; message: string } };

/** Scripted shell commands for the local model, recording what was asked. */
function localModel({
	active,
	outcome = { outcome: 'transcribed', text: 'a local tone' },
}: {
	active: string | undefined;
	outcome?: LocalOutcome;
}) {
	const asked: { modelId: string; bytes: number[] }[] = [];
	const opened: unknown[] = [];
	const commands = {
		getLocalTranscriptionReadiness: async () =>
			active === undefined
				? {
						status: 'unavailable',
						reason: 'no-active-model',
						message: 'No local transcription model is chosen on this device.',
					}
				: { status: 'ready', supportsPrompt: true, supportsLanguage: true },
		listInferenceModels: async () => [
			{ id: 'other-model', installed: true, active: false },
			...(active === undefined
				? []
				: [{ id: active, installed: true, active: true }]),
		],
		transcribeAudioBytes: async (modelId: string, bytes: number[]) => {
			asked.push({ modelId, bytes });
			if ('error' in outcome) return { data: null, error: outcome.error };
			return {
				data:
					outcome.outcome === 'empty-audio'
						? outcome
						: {
								...outcome,
								modelId,
								applied: { language: null, initialPrompt: false },
							},
				error: null,
			};
		},
		openHome: async (section: unknown) => {
			opened.push(section);
		},
	} as unknown as LocalTranscriptionCommands;
	return { commands, asked, opened };
}

test('a recording is transcribed on this computer with Epicenter’s active model, from the bytes its row names', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const local = localModel({ active: 'parakeet-tdt-0.6b-v3' });
	const workspace = expectOk(await openDesktop({ commands: local.commands }));
	const transcriber = workspace.localTranscription!;

	expect(await transcriber.readiness()).toEqual({ ready: true });
	expect(expectOk(await transcriber.transcribe('audio/take.wav'))).toEqual({
		text: 'a local tone',
		model: 'parakeet-tdt-0.6b-v3',
	});
	// The active model, never another installed one, and exactly the file's bytes.
	expect(local.asked).toEqual([
		{ modelId: 'parakeet-tdt-0.6b-v3', bytes: Array.from(toneWav()) },
	]);

	// Audio that cannot be read is not handed to the model.
	const { error: unreadable } = await transcriber.transcribe('audio/gone.wav');
	expect(unreadable?.name).toBe('AudioUnreadable');
	expect(local.asked).toHaveLength(1);

	await transcriber.openSettings();
	expect(local.opened).toEqual(['transcription']);
	await workspace.close();
});

test('with no active local model nothing is transcribed, and the reason names Settings', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const local = localModel({ active: undefined });
	const workspace = expectOk(await openDesktop({ commands: local.commands }));
	const transcriber = workspace.localTranscription!;

	expect(await transcriber.readiness()).toEqual({
		ready: false,
		message: 'No local transcription model is chosen on this device.',
	});
	const { error } = await transcriber.transcribe('audio/take.wav');
	expect(error?.name).toBe('ConnectionUnavailable');
	expect(error?.message).toContain('Epicenter’s Settings');
	expect(local.asked).toEqual([]);
	await workspace.close();
});

test('a local model that fails is reported as that failure, and an empty recording is an empty transcript', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	for (const [outcome, expected] of [
		[
			{ error: { name: 'ModelLoadError', message: 'the model did not load' } },
			'LocalFailed',
		],
		[
			{
				error: {
					name: 'LocalRouteUnavailable',
					message: 'The chosen model is not on this computer.',
				},
			},
			'ConnectionUnavailable',
		],
	] as const) {
		const local = localModel({ active: 'whisper-small', outcome });
		const workspace = expectOk(await openDesktop({ commands: local.commands }));
		const { error } =
			await workspace.localTranscription!.transcribe('audio/take.wav');
		expect(error?.name).toBe(expected);
		expect(error?.message).toContain(outcome.error.message);
		await workspace.close();
	}

	const empty = localModel({
		active: 'whisper-small',
		outcome: { outcome: 'empty-audio' },
	});
	const workspace = expectOk(await openDesktop({ commands: empty.commands }));
	expect(
		expectOk(await workspace.localTranscription!.transcribe('audio/take.wav')),
	).toEqual({ text: '', model: 'whisper-small' });
	await workspace.close();
});
