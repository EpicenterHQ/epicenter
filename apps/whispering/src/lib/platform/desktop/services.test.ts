/**
 * Opening a folder, and the desktop services: Whispering in Epicenter.
 *
 * The shell's replies are scripted here, so these pin what the page itself
 * decides: that the desktop folder names no folder, path, or scope, that a
 * refusal is returned and nothing else is opened in its place, and that the
 * folder's changes go to the shell. The shell has a real directory bound to
 * the window, and the page's own folder mirror opens it through
 * `@epicenter/folder/tauri` (`granted-shell.test-support.ts` in the
 * folder package); nothing here runs the Rust shell or a WebView.
 *
 * The connections are rows of a real `so.epicenter` folder on disk, which the
 * page never opens: its row commands are answered by the code
 * `epicenter whispering-connection` runs (`packages/cli/src/connection-rows.ts`),
 * with each reply passed through JSON as it crosses the shell. The AI
 * commands are scripted with the code the `epicenter` CLI runs
 * (`@epicenter/ai/send`) over an in-memory keychain and a stubbed endpoint,
 * so a test about a key or a request runs against what the CLI really
 * checks and sends. Local transcription answers with scripted shell
 * commands.
 */
import '../../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionsTables } from '@epicenter/ai/connection-table';
import {
	base64ToBytes,
	createMemorySecrets,
	keyState,
	responseEvents,
	saveKey,
	sendRequest,
} from '@epicenter/ai/send';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { resolveAppPaths } from '../../../../../../packages/cli/src/app-paths.js';
import {
	readConnectionRow,
	setConnectionRow,
} from '../../../../../../packages/cli/src/connection-rows.js';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
	shellArguments,
} from '../../../../../../packages/folder/src/granted-shell.test-support.js';
import { openFolder as openDirectoryFolder } from '@epicenter/folder/bun';
import { svelteFolder } from '@epicenter/svelte/folder';
import { toneWav } from '../../capture.js';
import { whisperingTables } from '../../definition.js';
import { readBytes } from '../../files.js';
import { eventually } from '../../services.test-support.js';
import type { ConnectionCommands } from './connections.js';
import type { LocalTranscriptionCommands } from './transcription.js';

type Call = { cmd: string; args: Record<string, unknown> };

/** Every command the page sent the shell. */
let calls: Call[] = [];
/** The shell, once a test has bound the window a directory. */
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
mock.module('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ listen: async () => () => {} }),
}));

const { openFolder } = await import('@epicenter/folder/tauri');
const { createServices } = await import('./services.js');
const { createDesktopAccount } = await import('./account.js');

const ORIGIN = 'epicenter-app://localhost';
const ENDPOINT = 'http://127.0.0.1:18080/v1';

test('the desktop Account sends one hosted request with its captured grant generation', async () => {
	const generation = '11111111-1111-4111-8111-111111111111';
	const sent: {
		audience: string;
		generation: string;
		path: string;
		authorization: unknown;
	}[] = [];
	const auth = createDesktopAccount({
		async authStatus() {
			return {
				status: 'ok',
				data: {
					origin: 'https://api.example.test',
					grants: [
						{
							grant: 'desktop',
							client: 'so.epicenter',
							signedIn: true,
							account: { id: 'alice' },
							generation,
						},
					],
				},
				error: null,
			};
		},
		async accountSend(audience, current, request, _id, channel) {
			sent.push({
				audience,
				generation: current,
				path: request.path,
				authorization: request.headers.find(
					([name]) => name.toLowerCase() === 'authorization',
				),
			});
			channel.onmessage(
				JSON.stringify({
					type: 'head',
					status: 200,
					statusText: 'OK',
					headers: [],
				}),
			);
			channel.onmessage(JSON.stringify({ type: 'end' }));
			return {
				status: 'ok',
				data: { code: 0, reply: null, stderr: '' },
				error: null,
			};
		},
		async sendCancel() {
			return { status: 'ok', data: null, error: null };
		},
		async openHome() {},
	});
	await auth.refresh();
	const response = await auth
		.getState()
		.account!.fetch('/v1/chat/completions', {
			method: 'POST',
			headers: { authorization: 'Bearer page' },
		});
	expect(response.status).toBe(200);
	expect(sent).toEqual([
		{
			audience: 'api',
			generation,
			path: 'v1/chat/completions',
			authorization: undefined,
		},
	]);
});

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	calls = [];
	shell = undefined;
	const scope = globalThis as { location?: unknown; localStorage?: unknown };
	delete scope.location;
	delete scope.localStorage;
});

/** A shell with a new empty directory bound to this window. */
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

/** The desktop services over the scripted shell. */
async function openDesktop(options: Parameters<typeof createServices>[1] = {}) {
	const folder = expectOk(
		await openFolder({ tables: whisperingTables }),
	);
	cleanups.push(() => folder.close());
	return {
		/** The opened folder; the services get it as `<OpenFolder>` hands it on. */
		folder,
		services: createServices(svelteFolder(folder), {
			commands: noCommands,
			...options,
		}),
	};
}

/** Whether a command named a folder, a root, or a window. */
const namesAFolder = (call: Call) =>
	['scope', 'root', 'window', 'directory'].some((name) => name in call.args);

/** A provider's request, as the stubbed endpoint received it. */
type ProviderCall = {
	url: string;
	authorization: string | null;
	cookie: string | null;
	body: Request;
};

/**
 * Epicenter as Whispering's connections reach it: a real Epicenter folder on
 * disk, whose `so.epicenter` the row commands read and save as
 * `epicenter whispering-connection` does, and the AI commands answered by
 * the code `epicenter send` and `epicenter auth key` run, over an in-memory
 * keychain and an endpoint that answers every request. `keychain` is what
 * the CLI would hold; the page is never handed it. `so.epicenter` is made by
 * the first save.
 */
async function epicenter() {
	// The Epicenter folder; Epicenter's own folder, where its connections are
	// rows, is `root` inside it.
	const folderDir = await mkdtemp(join(tmpdir(), 'whispering-epicenter-'));
	const root = join(folderDir, 'so.epicenter');
	const paths = resolveAppPaths({
		EPICENTER_FOLDER_DIR: folderDir,
		EPICENTER_DATA_DIR: join(folderDir, '.app-data'),
	});
	const keychain = createMemorySecrets();
	const provider: ProviderCall[] = [];
	/** Every line the page was sent. */
	const lines: string[] = [];
	let losing = false;
	/** Whether a row save lands and its reply is lost on the way back. */
	let losingSave = false;
	/** Runs between the page's key save and its row save, as another writer would. */
	let beforeRowSave: (() => Promise<void>) | undefined;
	/** A row command's reply as it crosses the shell: JSON, or the CLI's refusal. */
	const reply = (
		answered:
			| { data: unknown; error: null }
			| { data: null; error: { message: string } },
	) =>
		answered.error === null
			? { data: JSON.parse(JSON.stringify(answered.data)), error: null }
			: {
					data: null,
					error: { name: 'Refused' as const, message: answered.error.message },
				};
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
		async whisperingConnectionRead(connection) {
			return reply(await readConnectionRow(paths, connection));
		},
		async whisperingConnectionSet(connection, fields) {
			await beforeRowSave?.();
			const answered = reply(
				await setConnectionRow(
					paths,
					connection,
					JSON.parse(JSON.stringify({ fields })),
				),
			);
			// The CLI saved the row; its reply is lost on the way back.
			if (losingSave)
				return {
					data: null,
					error: {
						name: 'Failed' as const,
						message: 'the page that started the CLI ended',
					},
				};
			return answered;
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
	cleanups.push(() => rm(folderDir, { recursive: true, force: true }));
	return {
		root,
		keychain,
		provider,
		lines,
		ai,
		/** `so.epicenter` as Settings opens it, as its own folder. */
		settings: () =>
			openDirectoryFolder({
				directory: root,
				tables: connectionsTables,
			}),
		lose(next: boolean) {
			losing = next;
		},
		loseSave(next: boolean) {
			losingSave = next;
		},
		beforeRowSave(next: (() => Promise<void>) | undefined) {
			beforeRowSave = next;
		},
	};
}

type Epicenter = Awaited<ReturnType<typeof epicenter>>;

/** The desktop services over `host`'s connections. */
const openWith = (host: Epicenter) =>
	openDesktop({ connectionCommands: host.ai });

// ============================================================================
// Opening
// ============================================================================

test('the page opens its window folder naming no folder, and opening writes nothing', async () => {
	setup();
	const { root } = await granted();

	const { services, folder: opened } = await openDesktop();

	// The window opens the folder bound to it and supplies only a change channel.
	expect(calls[0]).toMatchObject({
		cmd: 'open_folder',
		args: { onChange: expect.anything() },
	});
	expect(sent('open_folder')).toHaveLength(1);
	expect(calls.filter(namesAFolder)).toEqual([]);
	expect(services.location).toBe('The folder opened in Epicenter');
	expect(services.capture.source).toBe('microphone');
	// No declaration, ignore file, or repository is made.
	expect(await readdir(root)).toEqual([]);
	await opened.close();
});

test('a refusal from the shell is returned, and nothing is opened in its place', async () => {
	setup();
	for (const refusal of [
		// A window the shell bound no folder to, and one whose folder is gone.
		{ name: 'NotBound' },
		{ name: 'Missing' },
		{ name: 'ShuttingDown' },
		// What Tauri answers a window with no capability for the plugin.
		'epicenter-folder.open_folder not allowed',
	]) {
		calls = [];
		(await granted()).control.open = () => {
			throw refusal;
		};

		const refused = expectErr(await openFolder({ tables: whisperingTables }));

		expect<string>(refused.name).toBe(
			typeof refusal === 'string' ? 'Unavailable' : refusal.name,
		);
		expect(calls.map((call) => call.cmd)).toEqual(['open_folder']);
	}
});

// ============================================================================
// The folder is the shell's
// ============================================================================

test('recovery repairs recordings a quit cut off and reports a repair failure', async () => {
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

	const { services: repaired, folder: repairedFolder } = await openDesktop();
	// The recorder repairs the window's folder; the page names none.
	expect(asked).toEqual([]);
	const notice = await repaired.recoverRecordings();
	expect(asked).toEqual([{ under: 'recordings' }]);
	expect(notice).toBeUndefined();
	await repairedFolder.close();

	refuse = true;
	const { services: unrepaired, folder: unrepairedFolder } =
		await openDesktop();
	const refusedNotice = await unrepaired.recoverRecordings();
	expect(refusedNotice).toContain('could not be checked');
	expect(refusedNotice).toContain('the disk is gone');
	await unrepairedFolder.close();
});

test('saves go through the shell: audio lands as its exact bytes, and a row as text', async () => {
	setup();
	const { root } = await granted();
	const { folder: openedFolder } = await openDesktop();
	const audio = new Uint8Array([1, 2, 3, 0, 255]);

	expectOk(await openedFolder.write('recordings/a.wav', audio));
	expectOk(
		await openedFolder.tables.transformations.create('clean', {
			fields: { title: 'Clean up', model: null },
			body: 'Tidy.\n',
		}),
	);
	expect(expectOk(await openedFolder.read('missing.md'))).toBeNull();

	// The recording's bytes reach the shell as a raw body, in the one call
	// that puts them at their path, and land exactly.
	const put = sent('put_folder_file').find(
		(call) => call.args.path === 'recordings/a.wav',
	);
	expect(put?.args.bytes).toEqual(audio);
	expect(
		new Uint8Array(await readFile(join(root, 'recordings', 'a.wav'))),
	).toEqual(audio);
	expect(expectOk(await readBytes(openedFolder, 'recordings/a.wav'))).toEqual(
		audio,
	);
	expect(
		await readFile(join(root, 'transformations', 'clean.md'), 'utf8'),
	).toContain('title: Clean up');
	await openedFolder.close();
});

test('a row save whose reply the shell never sent is not reported saved, and the folder shows what landed once it looks again', async () => {
	setup();
	const granting = await granted();
	const PATH = 'transformations/clean.md';
	await granting.write(PATH, '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n');
	const { folder: openedFolder } = await openDesktop();
	const table = openedFolder.tables.transformations;
	expect(table.row('clean')?.body).toBe('Tidy.\n');

	// The shell writes, and its reply never reaches the page: nothing says
	// whether the save landed, so it is a failure the person is told of.
	granting.control.loseReplies = 1;
	const lost = await table.update('clean', { body: 'Tidy it.\n' });
	expect(lost.error?.name).toBe('StorageFailed');
	expect(granting.kinds).toEqual(['write']);
	// The mirror shows only what it knows landed.
	expect(table.row('clean')?.body).toBe('Tidy.\n');

	// Looking again reads what the shell did write.
	openedFolder.refresh();
	await eventually(() => table.row('clean')?.body === 'Tidy it.\n');
	expect(await granting.text(PATH)).toContain('Tidy it.');
	await openedFolder.close();
});

// ============================================================================
// Connections are rows of so.epicenter, and keys stay in the keychain
// ============================================================================

test('a connection is a row of so.epicenter with its endpoint and key in the keychain; the page is told whether a key is set and never the key', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const { services: first, folder: firstFolder } = await openWith(host);
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
	// The window opened its own folder and no other: the row was saved
	// through Epicenter, by operation.
	expect(sent('open_folder')).toHaveLength(1);
	expect(calls.filter(namesAFolder)).toEqual([]);

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
	await firstFolder.close();

	// Another window reads the same row; removing the key keeps the endpoint.
	const { services: second, folder: secondFolder } = await openWith(host);
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
	await secondFolder.close();

	// A row synced from another computer is not set up here until this
	// computer saves its endpoint.
	await host.keychain.delete('whispering-text');
	const { services: third, folder: thirdFolder } = await openWith(host);
	expect((await third.connections.read()).text).toBeUndefined();
	await thirdFolder.close();
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
	const { services, folder: openedFolder } = await openWith(host);

	await expect(services.connections.read()).rejects.toThrow(
		'connections/whispering-text.md does not read as a connection',
	);
	// A save is refused with the same reason, and the file keeps its bytes.
	const refused = await services.connections.set('text', {
		baseUrl: ENDPOINT,
		model: 'chat-model',
		key: { action: 'replace', key: 'k' },
	});
	expect(refused.error).toContain('does not read as a connection');
	expect(refused.error).toContain('Fix that file');
	expect(
		await readFile(join(host.root, 'connections/whispering-text.md'), 'utf8'),
	).toBe('---\nkind: [open\n---\n');
	await openedFolder.close();
});

test('an edit Settings saved while Whispering saved a connection is kept beside Whispering’s', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const { services, folder: openedFolder } = await openWith(host);
	const change = (model: string) => ({
		baseUrl: ENDPOINT,
		model,
		key: { action: 'replace' as const, key: 'k' },
	});
	expectOk(await services.connections.set('text', change('first-model')));

	// After the page read the row, Settings renames it and adds a field.
	host.beforeRowSave(async () => {
		host.beforeRowSave(undefined);
		const folder = expectOk(await host.settings());
		expectOk(
			await folder.update(
				'connections/whispering-text.md',
				{ fields: { title: 'Renamed in Settings', note: 'kept' } },
				{ schema: connectionsTables.connections },
			),
		);
		await folder.close();
	});
	const saved = expectOk(
		await services.connections.set('text', change('second-model')),
	);
	expect(saved.text?.model).toBe('second-model');
	const text = await readFile(
		join(host.root, 'connections/whispering-text.md'),
		'utf8',
	);
	expect(text).toContain('title: Renamed in Settings');
	expect(text).toContain('note: kept');
	expect(text).toContain('model: second-model');
	await openedFolder.close();
});

test('a connection save whose reply Epicenter never delivered is not reported as saved', async () => {
	setup();
	await granted();
	const host = await epicenter();
	const { services, folder: openedFolder } = await openWith(host);
	host.loseSave(true);

	const lost = await services.connections.set('text', {
		baseUrl: ENDPOINT,
		model: 'chat-model',
		key: { action: 'replace', key: 'k' },
	});
	expect(lost.data).toBeNull();
	expect(lost.error).toContain('did not confirm');
	expect(lost.error).toContain('the page that started the CLI ended');

	// Reading again shows what landed.
	host.loseSave(false);
	expect((await services.connections.read()).text?.model).toBe('chat-model');
	await openedFolder.close();
});

test('a transcription reads the audio through the shell and Epicenter sends it with the key, only while the connection is the one it was prepared for', async () => {
	setup();
	const granting = await granted();
	await granting.write('recordings/take.wav', toneWav());
	const host = await epicenter();
	const { services, folder: openedFolder } = await openWith(host);
	const request = {
		audioPath: 'recordings/take.wav',
		expectedBaseUrl: ENDPOINT,
		model: 'whisper-1',
	};

	// Nothing set up: nothing is read or sent.
	const { error: none } = await services.transcribe(request);
	expect(none?.name).toBe('ConnectionUnavailable');
	expect(host.provider).toEqual([]);

	expectOk(
		await services.connections.set('transcription', {
			baseUrl: ENDPOINT,
			model: 'whisper-1',
			key: { action: 'replace', key: 'transcription-key' },
		}),
	);
	expect(expectOk(await services.transcribe(request))).toEqual({
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
			String(read.args.path).endsWith('recordings/take.wav'),
		),
	).toBe(true);
	expect(host.lines.join('\n')).not.toContain('transcription-key');

	// A request prepared for another base URL is not sent.
	const { error: changed } = await services.transcribe({
		...request,
		expectedBaseUrl: 'http://127.0.0.1:18081/v1',
	});
	expect(changed?.name).toBe('ConnectionChanged');
	// Audio that cannot be read is certain: nothing is sent.
	const { error: unreadable } = await services.transcribe({
		...request,
		audioPath: 'recordings/gone.wav',
	});
	expect(unreadable?.name).toBe('AudioUnreadable');
	expect(host.provider).toHaveLength(1);
	await openedFolder.close();
});

test('a reply Epicenter never delivered is reported as unknown, never as not sent, and nothing is sent again', async () => {
	setup();
	const granting = await granted();
	await granting.write('recordings/take.wav', toneWav());
	const host = await epicenter();
	const { services, folder: openedFolder } = await openWith(host);
	for (const operation of ['transcription', 'text'] as const)
		expectOk(
			await services.connections.set(operation, {
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

	const transcribed = await services.transcribe({
		audioPath: 'recordings/take.wav',
		expectedBaseUrl: ENDPOINT,
		model: 'model',
	});
	const transformed = await services.transform(transformation);

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
	expect(expectOk(await services.transform(transformation))).toEqual({
		text: 'A steady tone.',
	});
	expect(host.provider).toHaveLength(3);
	await openedFolder.close();
});

// ============================================================================
// The chosen microphone
// ============================================================================

test('the chosen microphone is kept in the origin’s storage and survives a new window', async () => {
	const stored = setup();
	await granted();
	const usb = { deviceId: 'usb-id', label: 'USB Microphone' };
	const { services: first, folder: firstFolder } = await openDesktop();
	expect(await first.preferences.microphone()).toBeUndefined();
	expect(await first.preferences.setMicrophone(usb)).toBeUndefined();
	await firstFolder.close();

	const { services: second, folder: secondFolder } = await openDesktop();
	expect(await second.preferences.microphone()).toEqual(usb);
	expect(await second.preferences.setMicrophone(undefined)).toBeUndefined();
	expect(stored.has('whispering.microphone')).toBe(false);
	await secondFolder.close();
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
	await granting.write('recordings/take.wav', toneWav());
	const local = localModel({ active: 'parakeet-tdt-0.6b-v3' });
	const { services, folder: openedFolder } = await openDesktop({
		commands: local.commands,
	});
	const transcriber = services.localTranscription!;

	expect(await transcriber.readiness()).toEqual({ ready: true });
	expect(expectOk(await transcriber.transcribe('recordings/take.wav'))).toEqual(
		{
			text: 'a local tone',
			model: 'parakeet-tdt-0.6b-v3',
		},
	);
	// The active model, never another installed one, and exactly the file's bytes.
	expect(local.asked).toEqual([
		{ modelId: 'parakeet-tdt-0.6b-v3', bytes: Array.from(toneWav()) },
	]);

	// Audio that cannot be read is not handed to the model.
	const { error: unreadable } = await transcriber.transcribe(
		'recordings/gone.wav',
	);
	expect(unreadable?.name).toBe('AudioUnreadable');
	expect(local.asked).toHaveLength(1);

	await transcriber.openSettings();
	expect(local.opened).toEqual(['transcription']);
	await openedFolder.close();
});

test('with no active local model nothing is transcribed, and the reason names Settings', async () => {
	setup();
	const granting = await granted();
	await granting.write('recordings/take.wav', toneWav());
	const local = localModel({ active: undefined });
	const { services, folder: openedFolder } = await openDesktop({
		commands: local.commands,
	});
	const transcriber = services.localTranscription!;

	expect(await transcriber.readiness()).toEqual({
		ready: false,
		message: 'No local transcription model is chosen on this device.',
	});
	const { error } = await transcriber.transcribe('recordings/take.wav');
	expect(error?.name).toBe('ConnectionUnavailable');
	expect(error?.message).toContain('Epicenter’s Settings');
	expect(local.asked).toEqual([]);
	await openedFolder.close();
});

test('a local model that fails is reported as that failure, and an empty recording is an empty transcript', async () => {
	setup();
	const granting = await granted();
	await granting.write('recordings/take.wav', toneWav());
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
		const { services, folder: openedFolder } = await openDesktop({
			commands: local.commands,
		});
		const { error } = await services.localTranscription!.transcribe(
			'recordings/take.wav',
		);
		expect(error?.name).toBe(expected);
		expect(error?.message).toContain(outcome.error.message);
		await openedFolder.close();
	}

	const empty = localModel({
		active: 'whisper-small',
		outcome: { outcome: 'empty-audio' },
	});
	const { services, folder: openedFolder } = await openDesktop({
		commands: empty.commands,
	});
	expect(
		expectOk(
			await services.localTranscription!.transcribe('recordings/take.wav'),
		),
	).toEqual({ text: '', model: 'whisper-small' });
	await openedFolder.close();
});
