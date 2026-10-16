/**
 * Opening a workspace, and the desktop workspace: Whispering installed in
 * Epicenter.
 *
 * The shell's replies are scripted here, so these pin what the page itself
 * decides: that the browser workspace refuses inside a desktop app, that it
 * names a folder and never a path, that a refusal is returned and nothing else is opened in its place,
 * and that the folder's changes go to the shell. The shell grants a real
 * directory, and the page's own folder engine opens it
 * (`granted-folder.test-support.ts`); nothing here runs the Rust shell or a
 * WebView.
 *
 * The connections are rows of a real `so.epicenter` folder on disk, opened
 * through `epicenterDefinition`. The AI commands are scripted with the code the
 * `epicenter` CLI runs (`@epicenter/ai/send`) over an in-memory keychain and
 * a stubbed endpoint, so a test about a key or a request runs against what
 * the CLI really checks and sends.
 * Local transcription answers with scripted shell commands.
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterDefinition } from '@epicenter/ai/connection-table';
import {
	base64ToBytes,
	createMemorySecrets,
	keyState,
	removeKey,
	responseEvents,
	saveKey,
	sendRequest,
} from '@epicenter/ai/send';
import { isStoredRow } from '@epicenter/folder';
import { openFolder as openBunFolder } from '@epicenter/folder/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { git } from '../../../../../packages/folder/src/git-http.test-support.js';
import { audioMimeTypeOf } from '../audio-format.js';
import { toneWav } from '../capture.js';
import {
	type Route,
	transcribeOver,
	transformOver,
} from '../connection-routes.js';
import type { ConnectionCommands } from './desktop.js';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
	shellArguments,
} from './granted-folder.test-support.js';
import type { LocalTranscriptionCommands } from './local-transcription.js';
import type { Workspace } from './types.js';

type Call = { cmd: string; args: Record<string, unknown> };

let inShell = true;
/** Every command the page sent the shell. */
let calls: Call[] = [];
/** The shell, once a test has one grant a directory. */
let shell: GrantedShell | undefined;

mock.module('@tauri-apps/api/core', () => ({
	// What Epicenter's generated bindings import beside `invoke`; nothing here
	// listens for an event or opens a channel.
	transformCallback: () => 0,
	Channel: class {},
	isTauri: () => inShell,
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

const { openWorkspace: openBrowserWorkspace } = await import('./browser.js');
const { openDesktopWorkspace } = await import('./desktop.js');

const ORIGIN = 'epicenter-app://localhost';
const SCOPE = 'so.epicenter.whispering';
const ENDPOINT = 'http://127.0.0.1:18080/v1';

const gitConfig = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
beforeAll(() => {
	// No Git identity of this machine's user: the shell's author is the fallback.
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
	for (const [key, value] of Object.entries(gitConfig))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
});

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	inShell = true;
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
	shell = createGrantedShell(directory, SCOPE);
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
};

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
	const root = await mkdtemp(join(tmpdir(), 'whispering-so-epicenter-'));
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
		async aiKeyRemove(connection) {
			const { data, error } = await removeKey(keychain, connection);
			return error === null
				? { status: 'ok', data: data.removed, error: null }
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
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	return {
		root,
		keychain,
		provider,
		lines,
		ai,
		open: () =>
			openBunFolder({
				root,
				definition: epicenterDefinition,
				git: { author: { name: 'Test', email: 'test@localhost' } },
			}),
		lose(next: boolean) {
			losing = next;
		},
	};
}

type Epicenter = Awaited<ReturnType<typeof epicenter>>;

/** The desktop workspace over `host`'s connections. */
const openWith = (host: Epicenter) =>
	openDesktopWorkspace({
		commands: noCommands,
		connectionCommands: host.ai,
		openConnectionsFolder: host.open,
	});

// ============================================================================
// The browser workspace inside a desktop app
// ============================================================================

test('a browser folder that is refused is returned as that refusal', async () => {
	setup();
	// This process has no origin private file system, as a server render has none.
	inShell = false;
	const none = expectErr(await openBrowserWorkspace());
	expect(none.name).toBe('BrowserFolder');
	if (none.name === 'BrowserFolder') {
		expect(none.refusal.name).toBe('NoFileSystem');
		expect(none.message).toBe(none.refusal.message);
	}

	// Inside a desktop app the browser opener refuses, even where storage exists.
	inShell = true;
	const inside = expectErr(await openBrowserWorkspace());
	expect(inside.name).toBe('BrowserFolder');
	if (inside.name === 'BrowserFolder')
		expect(inside.refusal.name).toBe('InsideTauri');
	expect(inside.message).toContain('Browser storage is not used');
});

// ============================================================================
// Opening
// ============================================================================

test('the page names the folder by its ID and nothing else, and opens the directory the shell grants', async () => {
	setup();
	const { root } = await granted();

	const workspace = expectOk(
		await openDesktopWorkspace({ commands: noCommands }),
	);

	// No root, author, or branch: the shell decided all of them.
	expect(calls[0]).toEqual({ cmd: 'grant_directory', args: { scope: SCOPE } });
	expect(sent('grant_directory')).toHaveLength(1);
	// Everything after the grant names the folder, never another.
	for (const call of calls.slice(1)) expect(call.args.scope).toBe(SCOPE);
	expect(workspace.location).toBe(root);
	expect(workspace.folder.git.snapshot.branch).toBe('main');
	// Opening made no repository; the first commit does.
	expect(existsSync(join(root, '.git', 'HEAD'))).toBe(false);
	expect((await workspace.folder.git.commit()).status).toBe('unchanged');
	expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true);
	// Epicenter offers Whispering no terminal, reveal, or failure injection.
	expect(workspace.terminal).toBeUndefined();
	expect(workspace.reveal).toBeUndefined();
	expect(workspace.injection).toBeUndefined();
	expect(workspace.debugControls).toBe(false);
	expect(workspace.capture.source).toBe('microphone');
	await workspace.close();
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

		const refused = expectErr(
			await openDesktopWorkspace({ commands: noCommands }),
		);

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

	const repaired = expectOk(
		await openDesktopWorkspace({ commands: noCommands }),
	);
	expect(asked).toEqual([{ scope: repaired.folderId, under: 'audio' }]);
	expect(repaired.captureNotice).toBeUndefined();
	await repaired.close();

	refuse = true;
	const unrepaired = expectOk(
		await openDesktopWorkspace({ commands: noCommands }),
	);
	expect(unrepaired.captureNotice).toContain('could not be checked');
	expect(unrepaired.captureNotice).toContain('the disk is gone');
	await unrepaired.close();
});

test('saves and history go through the shell', async () => {
	setup();
	const { root } = await granted();
	const workspace = expectOk(
		await openDesktopWorkspace({ commands: noCommands }),
	);
	const audio = new Uint8Array([1, 2, 3, 0, 255]);

	expectOk(await workspace.folder.files.create('audio/a.wav', audio));
	expectOk(await workspace.folder.files.create('notes.md', 'hello'));
	expect((await workspace.folder.git.commit()).status).toBe('committed');
	const { error: readError } = await workspace.folder.files.read('missing.md');
	expect(readError?.name).toBe('NotFound');

	// The recording's bytes reach the shell as a raw body, staged and then
	// renamed into place, and land exactly.
	const staged = sent('write_folder_file').map((call) => call.args.bytes);
	expect(staged).toContainEqual(audio);
	expect(sent('rename_folder_path').map((call) => call.args.to)).toContainEqual(
		join(root, 'audio', 'a.wav'),
	);
	expect(new Uint8Array(await readFile(join(root, 'audio', 'a.wav')))).toEqual(
		audio,
	);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await workspace.close();
});

test('a version is recorded as the person Git’s configuration names, and as Epicenter only when none is set', async () => {
	setup();
	const { root } = await granted();
	const first = expectOk(await openDesktopWorkspace({ commands: noCommands }));
	expectOk(await first.folder.files.create('notes.md', 'first'));
	expect((await first.folder.git.commit()).status).toBe('committed');
	await first.close();
	expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
		'Epicenter <epicenter@localhost>',
	);

	// The person sets who they are; the next opening records versions as them.
	await git(root, 'config', 'user.name', 'Someone');
	await git(root, 'config', 'user.email', 'someone@example.test');
	const second = expectOk(await openDesktopWorkspace({ commands: noCommands }));
	expectOk(await second.folder.files.create('notes-2.md', 'second'));
	expect((await second.folder.git.commit()).status).toBe('committed');
	await second.close();
	expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
		'Someone <someone@example.test>',
	);
});

test('a row write whose reply the shell never sent is confirmed by what landed, and is unknown, not refused, when that cannot be read', async () => {
	setup();
	const granting = await granted();
	const PATH = 'transformations/clean.md';
	await granting.write(
		PATH,
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n',
	);
	const workspace = expectOk(
		await openDesktopWorkspace({ commands: noCommands }),
	);
	const table = workspace.folder.tables.transformations;
	const stored = expectOk(await table.get('clean'))!;

	// The shell writes, and its reply never reaches the page. The page reads
	// the file back, finds exactly what it wrote, and the write is confirmed.
	granting.control.loseReplies = 1;
	const confirmed = expectOk(
		await table.write('clean', stored.row, {
			...stored.row,
			body: 'Tidy it.\n',
		}),
	);
	if (!isStoredRow(confirmed)) throw new Error('Expected the row to be there');
	expect(confirmed.row.body).toBe('Tidy it.\n');
	expect(granting.kinds).toEqual(['write']);

	// Again, and now the file cannot be read back either: nothing says
	// whether the write landed, so it is unknown, never refused.
	granting.control.loseReplies = 1;
	granting.control.beforeChange = async () => {
		granting.control.beforeChange = undefined;
		granting.control.failReads.add(PATH);
	};
	const lost = await table.write('clean', confirmed.row, {
		...confirmed.row,
		body: 'Tidy it again.\n',
	});
	expect(lost.error).toMatchObject({
		name: 'Io',
		cause: {
			name: 'Unconfirmed',
			message: expect.stringContaining('the reply never reached the window'),
		},
	});
	expect(granting.kinds).toEqual(['write', 'write']);

	granting.control.failReads.delete(PATH);
	const landed = expectOk(await table.get('clean'));
	if (landed === undefined) throw new Error('Expected the row to be there');
	expect(landed.row.body).toBe('Tidy it again.\n');
	await workspace.close();
});

// ============================================================================
// Connections are rows of so.epicenter, and keys stay in the keychain
// ============================================================================

/** A route over `connection`, as the library resolves one. */
const routeOver = (connection: string, model = 'whisper-1'): Route => ({
	connection,
	kind: 'openai-compatible',
	title: connection,
	model,
	endpoint: ENDPOINT,
});

/** The audio at `path`, read through the workspace's folder as the library reads it. */
const audioOf = (workspace: Workspace) => async (path: string) => {
	const { data: audio, error } = await workspace.folder.files.read(path);
	if (error !== null) return { data: null, error: error.message } as const;
	return {
		data: {
			bytes: audio.bytes,
			filename: path.slice(path.lastIndexOf('/') + 1),
			mimeType: audioMimeTypeOf(path) ?? 'application/octet-stream',
		},
		error: null,
	} as const;
};

test('a connection is a row of so.epicenter with its endpoint and key in the keychain; the page is told whether a key is set and never the key', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));
	const { connections } = workspace;
	expect(connections.kinds).toEqual([
		'openai-compatible',
		'epicenter',
		'local',
	]);
	expect(connections.keys.place).toBe('computer');

	const folder = expectOk(await connections.open());
	expectOk(
		await folder.tables.connections.create(
			{
				fields: {
					kind: 'openai-compatible',
					title: 'Groq',
					model: 'chat-model',
				},
				body: '',
			},
			{ stem: 'groq' },
		),
	);
	expect(
		expectOk(
			await connections.keys.save('groq', `${ENDPOINT}/`, 'device-secret-key'),
		),
	).toEqual({ state: 'saved', endpoint: ENDPOINT, hasKey: true });
	expect(expectOk(await connections.keys.state('groq'))).toEqual({
		state: 'saved',
		endpoint: ENDPOINT,
		hasKey: true,
	});
	// The row holds no endpoint and no key; the keychain holds both.
	const row = await readFile(join(host.root, 'connections/groq.md'), 'utf8');
	expect(row).toContain('kind: openai-compatible');
	expect(row).not.toContain(ENDPOINT);
	expect(row).not.toContain('device-secret-key');
	expect(await host.keychain.get('groq')).toBe(
		JSON.stringify({ endpoint: ENDPOINT, key: 'device-secret-key' }),
	);

	expectOk(await connections.keys.remove('groq'));
	expect(expectOk(await connections.keys.state('groq'))).toEqual({
		state: 'missing',
	});
	// Signed out, an Epicenter connection has nowhere to send.
	expect((await connections.epicenterEndpoint()).error).toContain('sign in');
	await workspace.close();
});

test('a transcription reads the audio through the shell and Epicenter sends it with the key, only to the endpoint it was prepared for', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));
	expectOk(
		await workspace.connections.keys.save(
			'groq',
			ENDPOINT,
			'transcription-key',
		),
	);
	const transcribe = (route: Route, path = 'audio/take.wav') =>
		transcribeOver({ workspace }, route, path, audioOf(workspace));

	expect(expectOk(await transcribe(routeOver('groq')))).toEqual({
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

	// A request prepared for another endpoint is not sent: Epicenter refuses it.
	const { error: changed } = await transcribe({
		...routeOver('groq'),
		endpoint: 'http://127.0.0.1:18081/v1',
	});
	expect(changed?.message).toContain(`saved for ${ENDPOINT}`);
	// Audio that cannot be read is certain: nothing is sent.
	const { error: unreadable } = await transcribe(
		routeOver('groq'),
		'audio/gone.wav',
	);
	expect(unreadable?.message).toContain('could not be read');
	expect(host.provider).toHaveLength(1);
	await workspace.close();
});

test('a refusal Epicenter names before sending reads as that refusal, never as an unknown outcome', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));

	// No key is saved for this connection: Epicenter refuses, and sends nothing.
	const { error } = await transformOver(
		{ workspace },
		routeOver('unsaved', 'model'),
		{
			prompt: 'Fix it.',
			input: 'text',
		},
	);
	expect(error?.message).toBe(
		"No endpoint or key is saved on this computer for the connection 'unsaved'. Add your key on this computer.",
	);
	expect(host.provider).toEqual([]);
	await workspace.close();
});

test('a reply Epicenter never delivered is reported as unknown, never as not sent, and nothing is sent again', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const host = await epicenter();
	const workspace = expectOk(await openWith(host));
	expectOk(await workspace.connections.keys.save('groq', ENDPOINT, 'test-key'));
	const route = routeOver('groq', 'model');
	const transformation = {
		prompt: 'Fix the punctuation.',
		input: 'um so a steady tone',
	};
	host.lose(true);

	const transcribed = await transcribeOver(
		{ workspace },
		route,
		'audio/take.wav',
		audioOf(workspace),
	);
	const transformed = await transformOver({ workspace }, route, transformation);

	// The endpoint was called, once each, and the page was not told the answer.
	expect(host.provider).toHaveLength(2);
	for (const { data: answer, error: lost } of [transcribed, transformed]) {
		expect(answer).toBeNull();
		expect(lost?.message).toContain(
			'it is not known whether the request was sent',
		);
		expect(lost?.message).toContain('Load failed');
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(host.provider).toHaveLength(2);

	// Asking again is the person's choice, and it is one more request.
	host.lose(false);
	expect(
		expectOk(await transformOver({ workspace }, route, transformation)),
	).toEqual({ text: 'A steady tone.' });
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
	const first = expectOk(await openDesktopWorkspace({ commands: noCommands }));
	expect(await first.preferences.microphone()).toBeUndefined();
	expect(await first.preferences.setMicrophone(usb)).toBeUndefined();
	await first.close();

	const second = expectOk(await openDesktopWorkspace({ commands: noCommands }));
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
	} as unknown as LocalTranscriptionCommands;
	return { commands, asked };
}

test('a recording is transcribed on this computer with Epicenter’s active model, from the bytes its row names', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const local = localModel({ active: 'parakeet-tdt-0.6b-v3' });
	const workspace = expectOk(
		await openDesktopWorkspace({ commands: local.commands }),
	);
	const transcriber = workspace.localTranscription!;

	expect(expectOk(await transcriber.activeModel())).toBe(
		'parakeet-tdt-0.6b-v3',
	);
	expect(
		expectOk(
			await transcriber.transcribe('audio/take.wav', 'parakeet-tdt-0.6b-v3'),
		),
	).toEqual({ text: 'a local tone' });
	// The active model, never another installed one, and exactly the file's bytes.
	expect(local.asked).toEqual([
		{ modelId: 'parakeet-tdt-0.6b-v3', bytes: Array.from(toneWav()) },
	]);

	// Audio that cannot be read is not handed to the model.
	const { error: unreadable } = await transcriber.transcribe(
		'audio/gone.wav',
		'parakeet-tdt-0.6b-v3',
	);
	expect(unreadable?.message).toContain('could not be read');
	expect(local.asked).toHaveLength(1);

	await workspace.close();
});

test('with no active local model nothing is transcribed, and the reason names Settings', async () => {
	setup();
	const granting = await granted();
	await granting.write('audio/take.wav', toneWav());
	const local = localModel({ active: undefined });
	const workspace = expectOk(
		await openDesktopWorkspace({ commands: local.commands }),
	);
	const transcriber = workspace.localTranscription!;

	const { error } = await transcriber.activeModel();
	expect(error).toBe(
		'No local transcription model is chosen on this device. Choose a model in Epicenter’s Settings.',
	);
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
			'Transcription on this computer failed',
		],
		[
			{
				error: {
					name: 'LocalRouteUnavailable',
					message: 'The chosen model is not on this computer.',
				},
			},
			'Epicenter’s Settings',
		],
	] as const) {
		const local = localModel({ active: 'whisper-small', outcome });
		const workspace = expectOk(
			await openDesktopWorkspace({ commands: local.commands }),
		);
		const { error } = await workspace.localTranscription!.transcribe(
			'audio/take.wav',
			'whisper-small',
		);
		expect(error?.message).toContain(expected);
		expect(error?.message).toContain(outcome.error.message);
		await workspace.close();
	}

	const empty = localModel({
		active: 'whisper-small',
		outcome: { outcome: 'empty-audio' },
	});
	const workspace = expectOk(
		await openDesktopWorkspace({ commands: empty.commands }),
	);
	expect(
		expectOk(
			await workspace.localTranscription!.transcribe(
				'audio/take.wav',
				'whisper-small',
			),
		),
	).toEqual({ text: '' });
	await workspace.close();
});
