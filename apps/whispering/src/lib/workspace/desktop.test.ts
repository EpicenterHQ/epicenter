/**
 * Opening a workspace, and the desktop workspace over a shell and a host that
 * refuse or fail.
 *
 * The shell's replies and the host's answers are scripted here, so these pin
 * what the page itself decides: which storage it asks for, that it names a
 * folder and never a path, that a refusal from either side is returned and
 * nothing else is opened in their place, that the folder's changes go to the
 * shell and not to the host.
 * The shell grants a real directory, and the page's own folder engine opens
 * it (`granted-folder.test-support.ts`); nothing here runs the Rust shell or
 * a WebView.
 *
 * Where a test is about what the host really does (keeping the chosen
 * microphone, calling an endpoint before its reply is lost), the host is the real one over its
 * real request handler and a real directory, with a stubbed endpoint.
 */
import '../svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { git } from '../../../../../packages/folder/src/git-http.test-support.js';
import { createHost, type HostOptions } from '../../../native/host.js';
import { encode } from '../bridge/codec.js';
import { toneWav } from '../capture.js';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
	shellArguments,
} from './granted-folder.test-support.js';

type Call = { cmd: string; args: Record<string, unknown> };

let inShell = true;
/** Every command the page sent the shell. */
let calls: Call[] = [];
/** The shell, once a test has one grant a directory. */
let shell: GrantedShell | undefined;

mock.module('@tauri-apps/api/core', () => ({
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

const { openWorkspace } = await import('./index.js');
const { openBrowserWorkspace } = await import('./browser.js');
const { openDesktopWorkspace } = await import('./desktop.js');

const ROOT = '/Users/someone/Epicenter/local/so.epicenter.whispering';
const SCOPE = 'so.epicenter.whispering';
const CONNECTION = { origin: 'http://127.0.0.1:4999', token: 'test-token' };

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

/**
 * A shell that grants this window `root`, a new empty directory unless one
 * is named. The host reports the same directory unless a test says otherwise.
 */
async function granted(root?: string) {
	const directory = root ?? (await grantedDirectory());
	if (root === undefined)
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
	shell = createGrantedShell(directory, SCOPE);
	return shell;
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
/** Whether the page changed anything in the folder. */
const changedFiles = () =>
	calls.some((call) =>
		[
			'write_folder_file',
			'rename_folder_path',
			'remove_folder_path',
			'make_folder_directory',
		].includes(call.cmd),
	);
const answer = (ok: unknown) => Response.json({ ok: encode(ok) });
const info = (overrides: Record<string, unknown> = {}) => ({
	root: shell?.root ?? ROOT,
	shell: '/bin/sh',
	debug: false,
	fixture: null,
	fixtureRefused: false,
	defaults: {
		transcription: { baseUrl: 'u', model: 'm' },
		text: { baseUrl: 'u', model: '' },
	},
	...overrides,
});

type HostCall = { op: string; payload: unknown };

/** A host whose operations are scripted. */
function host(
	operations: Record<string, (payload: unknown) => unknown> = {},
	hostInfo = info(),
) {
	const requested: string[] = [];
	const operationsAsked: HostCall[] = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const path = new URL(input).pathname;
		requested.push(path);
		const body = JSON.parse(String(init?.body)) as HostCall;
		operationsAsked.push(body);
		if (body.op === 'info') return answer(hostInfo);
		const operation = operations[body.op];
		if (operation === undefined)
			return Response.json({ fault: 'unexpected call' }, { status: 500 });
		return answer(await operation(body.payload));
	};
	return {
		fetch,
		requested,
		operationsAsked,
	};
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: (() => Promise<void> | void)[] = [];
const pageFetch = globalThis.fetch;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	globalThis.fetch = pageFetch;
	inShell = true;
	calls = [];
	shell = undefined;
	const scope = globalThis as { window?: unknown; location?: unknown };
	delete scope.window;
	delete scope.location;
});

/**
 * The globals the page has when a shell did, or did not, inject the host's
 * token: the token and the page's origin.
 */
function setup(
	{ bridge }: { bridge: { token: string } | undefined } = {
		bridge: { token: CONNECTION.token },
	},
) {
	const scope = globalThis as { window?: unknown; location?: unknown };
	scope.window = { __WHISPERING_BRIDGE__: bridge };
	scope.location = { origin: CONNECTION.origin };
}

/** The real host over a real directory, reached through its own request handler. */
async function realHost(overrides: Partial<HostOptions> = {}) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-desktop-')),
	);
	const root = join(directory, 'data');
	await mkdir(root);
	const served = await createHost({
		root,
		token: CONNECTION.token,
		uiDist: undefined,
		debug: false,
		fixturePath: undefined,
		env: {},
		log: () => {},
		...overrides,
	});
	served.listening(4999);
	cleanups.push(async () => {
		await served.close();
		await rm(directory, { recursive: true, force: true });
	});
	return {
		root,
		host: served,
		fetch: (input: string, init?: RequestInit) =>
			served.handle(new Request(input, init)),
	};
}

// ============================================================================
// Which storage is asked for
// ============================================================================

test('inside a desktop app with no Whispering host, nothing is opened: no folder, no host call, no browser storage', async () => {
	setup({ bridge: undefined });
	await granted();

	const refused = expectErr(await openWorkspace());

	expect(refused.name).toBe('HostMissing');
	expect(refused.message).toContain('browser storage is not used');
	// A folder the shell would have granted is not a reason to open half an app.
	expect(calls).toEqual([]);
});

test('a host token does not make a browser tab the desktop app', async () => {
	inShell = false;
	setup({ bridge: { token: 'left-over-token' } });

	const refused = expectErr(await openWorkspace());

	// The tab asked for browser storage, which this process does not have, and
	// never asked a shell for anything.
	expect(refused.name).toBe('BrowserFolder');
	if (refused.name === 'BrowserFolder')
		expect(refused.refusal.name).toBe('NoFileSystem');
	expect(calls).toEqual([]);
});

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

test('a host that does not answer is the refusal, and the shell is not asked for a folder', async () => {
	setup();
	await granted();
	const requested: string[] = [];

	const refused = expectErr(
		await openDesktopWorkspace({
			...CONNECTION,
			fetch: async (input) => {
				requested.push(new URL(input).pathname);
				throw new TypeError('Load failed');
			},
		}),
	);

	expect(refused.name).toBe('HostUnreachable');
	expect(refused.message).toContain('Load failed');
	// One request to the host, nothing after it, and no grant.
	expect(requested).toEqual(['/bridge/app']);
	expect(calls).toEqual([]);
});

test('the page names the folder by its ID and nothing else, and opens the directory the shell grants', async () => {
	setup();
	const { root } = await granted();
	const served = host();

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	// No root, author, or branch: the shell decided all of them.
	expect(calls[0]).toEqual({ cmd: 'grant_directory', args: { scope: SCOPE } });
	expect(sent('grant_directory')).toHaveLength(1);
	// Everything after the grant names the folder, never another.
	for (const call of calls.slice(1)) expect(call.args.scope).toBe(SCOPE);
	expect(workspace.kind).toBe('native');
	expect(workspace.location).toBe(root);
	expect(workspace.folder.git.snapshot.branch).toBe('main');
	// Opening made no repository; the first commit does.
	expect(existsSync(join(root, '.git', 'HEAD'))).toBe(false);
	expect((await workspace.folder.git.commit()).status).toBe('unchanged');
	expect(existsSync(join(root, '.git', 'HEAD'))).toBe(true);
	await workspace.close();
});

test('a refusal from the shell is returned, and nothing is opened in its place', async () => {
	setup();
	for (const refusal of [
		{ name: 'UnknownScope', scope: SCOPE },
		{ name: 'WindowNotPermitted', scope: SCOPE, window: 'other' },
		{ name: 'Busy', root: ROOT },
		// What Tauri answers a window with no capability for the plugin.
		'epicenter-folder.grant_directory not allowed',
	]) {
		calls = [];
		(await granted()).control.grant = () => {
			throw refusal;
		};
		const served = host();

		const refused = expectErr(
			await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
		);

		expect(refused.name).toBe('DesktopFolder');
		if (refused.name === 'DesktopFolder')
			expect<string>(refused.refusal.name).toBe(
				typeof refusal === 'string' ? 'Unavailable' : refusal.name,
			);
		// One attempt, no later host call.
		expect(calls.map((call) => call.cmd)).toEqual(['grant_directory']);
		expect(served.requested).toEqual(['/bridge/app']);
	}
});

test('a host that uses another directory than the shell granted is refused, and the folder is closed', async () => {
	setup();
	const elsewhere = await grantedDirectory();
	cleanups.push(() => rm(elsewhere, { recursive: true, force: true }));
	const served = host();
	await granted(elsewhere);

	const refused = expectErr(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(refused.name).toBe('FolderMismatch');
	expect(refused.message).toContain(elsewhere);
	expect(refused.message).toContain(ROOT);
	// Opening wrote nothing in the folder, and the host was asked nothing more.
	expect(changedFiles()).toBe(false);
	expect(served.requested).toEqual(['/bridge/app']);
});

// ============================================================================
// The folder is the shell's
// ============================================================================

test('saves and history go through the shell and never to the host', async () => {
	setup();
	const { root } = await granted();
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	const audio = new Uint8Array([1, 2, 3, 0, 255]);

	expectOk(await workspace.folder.files.create('recordings/a.wav', audio));
	expectOk(await workspace.folder.files.create('notes.md', 'hello'));
	expect((await workspace.folder.git.commit()).status).toBe('committed');
	const { error: readError } = await workspace.folder.files.read('missing.md');
	expect(readError?.name).toBe('NotFound');

	// The recording's bytes reach the shell as a raw body, staged and then
	// renamed into place, and land exactly.
	const staged = sent('write_folder_file').map((call) => call.args.bytes);
	expect(staged).toContainEqual(audio);
	expect(sent('rename_folder_path').map((call) => call.args.to)).toContainEqual(
		join(root, 'recordings', 'a.wav'),
	);
	expect(
		new Uint8Array(await readFile(join(root, 'recordings', 'a.wav'))),
	).toEqual(audio);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	// The host was asked who it is. Nothing else.
	expect(served.operationsAsked.map((call) => call.op)).toEqual(['info']);
	expect(new Set(served.requested)).toEqual(new Set(['/bridge/app']));
	await workspace.close();
});

test('a version is recorded as the person Git’s configuration names, and as Whispering only when none is set', async () => {
	setup();
	const { root } = await granted();
	const served = host();
	const first = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	expectOk(await first.folder.files.create('notes.md', 'first'));
	expect((await first.folder.git.commit()).status).toBe('committed');
	await first.close();
	expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
		'Whispering <whispering@localhost>',
	);

	// The person sets who they are; the next opening records versions as them.
	await git(root, 'config', 'user.name', 'Someone');
	await git(root, 'config', 'user.email', 'someone@example.test');
	const second = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
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
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	const table = workspace.folder.tables.transformations;
	const stored = expectOk(await table.get('clean'))!;

	// The shell writes, and its reply never reaches the page. The page reads
	// the file back, finds exactly what it wrote, and the write is confirmed.
	granting.control.loseReplies = 1;
	const { stored: confirmed } = expectOk(
		await table.save(stored, { ...stored.row, body: 'Tidy it.\n' }),
	);
	expect(confirmed.row.body).toBe('Tidy it.\n');
	expect(granting.kinds).toEqual(['write']);

	// Again, and now the file cannot be read back either: nothing says
	// whether the write landed, so it is unknown, never refused.
	granting.control.loseReplies = 1;
	granting.control.beforeChange = async () => {
		granting.control.beforeChange = undefined;
		granting.control.failReads.add(PATH);
	};
	const lost = await table.save(confirmed, {
		...confirmed.row,
		body: 'Tidy it again.\n',
	});
	expect(lost.error).toMatchObject({
		name: 'Unconfirmed',
		message: expect.stringContaining('the reply never reached the window'),
	});
	expect(granting.kinds).toEqual(['write', 'write']);

	// The page reads what landed, and writes on top of it; its own reply
	// confirms it. Nothing was written again on its own.
	granting.control.failReads.delete(PATH);
	const landed = expectOk(await table.get('clean'));
	if (landed === undefined) throw new Error('Expected the row to be there');
	expect(landed.row.body).toBe('Tidy it again.\n');
	expectOk(
		await table.save(landed, { ...landed.row, body: 'Tidy it more.\n' }),
	);
	expect(granting.kinds).toEqual(['write', 'write', 'write']);
	expect(await granting.text(PATH)).toContain('Tidy it more.');

	await workspace.close();
});

test('a host that stops answering does not close the folder: the page keeps saving', async () => {
	setup();
	const { root } = await granted();
	let hostUp = true;
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({
			...CONNECTION,
			fetch: async (input, init) => {
				if (!hostUp) throw new TypeError('Load failed');
				return served.fetch(input, init);
			},
		}),
	);

	hostUp = false;

	// The folder is granted to the window, not the host, so a save still
	// lands with the host gone.
	expectOk(await workspace.folder.files.create('note.md', 'still saved'));
	expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('still saved');
	// What needs the host answers as unavailable, as a Result.
	const { error: transcribeError } = await workspace.transcribe({
		audioPath: 'recordings/a.wav',
		expectedBaseUrl: 'u',
		model: 'm',
	});
	expect(transcribeError?.name).toBe('HostUnavailable');
	await workspace.close();
});

// ============================================================================
// Host operations
// ============================================================================

test('a failed transcription call is a Result, and the next call still works', async () => {
	setup();
	await granted();
	let transcribeCalls = 0;
	const asked: unknown[] = [];
	const served = host();
	const opened = await openDesktopWorkspace({
		...CONNECTION,
		fetch: async (input, init) => {
			const body = init?.body
				? (JSON.parse(String(init.body)) as HostCall)
				: undefined;
			if (body?.op !== 'transcribe') return served.fetch(input, init);
			transcribeCalls += 1;
			asked.push(body.payload);
			if (transcribeCalls === 1) throw new TypeError('Load failed');
			if (transcribeCalls === 2)
				return Response.json({ fault: 'host fault' }, { status: 500 });
			return answer({ data: { text: 'ok' }, error: null });
		},
	});
	const workspace = expectOk(opened);
	const request = {
		audioPath: 'recordings/a.wav',
		expectedBaseUrl: 'u',
		model: 'm',
	};

	const { error: unreachable } = await workspace.transcribe(request);
	expect(unreachable?.name).toBe('HostUnavailable');
	expect(unreachable?.message).toContain('Load failed');

	const { error: faulted } = await workspace.transcribe(request);
	expect(faulted?.name).toBe('HostUnavailable');
	expect(faulted?.message).toContain('host fault');

	const answered = expectOk(await workspace.transcribe(request));
	expect(answered).toEqual({ text: 'ok' });
	// The page sends the path the row names, and no audio: the host reads the
	// file. It names the base URL it expects, and the host decides where to send.
	expect(asked).toEqual(
		Array(3).fill({
			path: 'recordings/a.wav',
			expectedBaseUrl: 'u',
			model: 'm',
		}),
	);
	expect(
		sent('read_folder_file').filter((call) =>
			String(call.args.path).endsWith('recordings/a.wav'),
		),
	).toEqual([]);
	await workspace.close();
});

test('a failed transformation call is a Result, and the next call still works', async () => {
	setup();
	await granted();
	let transformCalls = 0;
	const asked: unknown[] = [];
	const served = host();
	const opened = await openDesktopWorkspace({
		...CONNECTION,
		fetch: async (input, init) => {
			const body = init?.body
				? (JSON.parse(String(init.body)) as HostCall)
				: undefined;
			if (body?.op !== 'transform') return served.fetch(input, init);
			transformCalls += 1;
			asked.push(body.payload);
			if (transformCalls === 1) throw new TypeError('Load failed');
			if (transformCalls === 2)
				return Response.json({ fault: 'host fault' }, { status: 500 });
			return answer({ data: { text: 'ok' }, error: null });
		},
	});
	const workspace = expectOk(opened);
	const request = {
		expectedBaseUrl: 'u',
		model: 'm',
		prompt: 'p',
		input: 'text',
	};

	const { error: unreachable } = await workspace.transform(request);
	expect(unreachable?.name).toBe('HostUnavailable');
	expect(unreachable?.message).toContain('Load failed');

	const { error: faulted } = await workspace.transform(request);
	expect(faulted?.name).toBe('HostUnavailable');
	expect(faulted?.message).toContain('host fault');

	const answered = expectOk(await workspace.transform(request));
	expect(answered).toEqual({ text: 'ok' });
	// The page sends what to transform and never a key: the host adds it.
	expect(asked).toEqual([request, request, request]);
	await workspace.close();
});

// ============================================================================
// The chosen microphone
// ============================================================================

test('the chosen microphone is kept by the host beside the connections, survives a new window, and never brings a key back', async () => {
	setup();
	const served = await realHost();
	await granted(served.root);
	const usb = { deviceId: 'usb-id', label: 'USB Microphone' };
	const replies: string[] = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const response = await served.fetch(input, init);
		replies.push(await response.clone().text());
		return response;
	};
	const first = expectOk(await openDesktopWorkspace({ ...CONNECTION, fetch }));
	const saved = expectOk(
		await first.connections.set('text', {
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'chat-model',
			key: { action: 'replace', key: 'device-secret-key' },
		}),
	);
	expect(saved.text).toEqual({
		baseUrl: 'http://127.0.0.1:18080/v1',
		model: 'chat-model',
		keyPresent: true,
		readOnlyReason: undefined,
	});

	expect(await first.preferences.microphone()).toBeUndefined();
	expect(await first.preferences.setMicrophone(usb)).toBeUndefined();
	await first.close();

	// The page's own storage would be gone: a new launch serves a new origin.
	const second = expectOk(await openDesktopWorkspace({ ...CONNECTION, fetch }));
	expect(await second.preferences.microphone()).toEqual(usb);
	expect((await second.connections.read()).text?.keyPresent).toBe(true);
	expect(await second.preferences.setMicrophone(undefined)).toBeUndefined();
	expect(await second.preferences.microphone()).toBeUndefined();
	expect((await second.connections.read()).text?.keyPresent).toBe(true);
	expect(replies.join('\n')).not.toContain('device-secret-key');
	await second.close();
});

test('a choice the host cannot save is returned as the reason, and one it cannot read rejects', async () => {
	setup();
	await granted();
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(
		await workspace.preferences.setMicrophone({ deviceId: 'x', label: 'X' }),
	).toBe('unexpected call');
	await expect(workspace.preferences.microphone()).rejects.toThrow(
		'unexpected call',
	);
	await workspace.close();
});

test('with fixture audio the workspace has no microphone input to list, ask for, or test', async () => {
	setup();
	await granted();
	const served = host(
		{},
		info({ debug: true, fixture: { name: 'tone.wav', size: 44 } }),
	);

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(workspace.capture.source).toBe('fixture');
	expect(workspace.capture.inputs).toBeUndefined();
	await workspace.close();
});

// ============================================================================
// Debug failure injection
// ============================================================================

test('a release shell offers no failure injection, and asks the host for none', async () => {
	setup();
	await granted();
	const served = host();

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(workspace.injection).toBeUndefined();
	expect(workspace.debugControls).toBe(false);
	expect(served.operationsAsked.map((call) => call.op)).toEqual(['info']);
	await workspace.close();
});

test('a debug shell tells the host once the folder is open, and wraps each recording write in its own obstacle', async () => {
	setup();
	const { root } = await granted();
	const order: string[] = [];
	const served = host(
		{
			'injection-launch': () => {
				if (existsSync(join(root, '.git', 'HEAD'))) order.push('git');
				order.push('injection-launch');
				return { rowWrites: 0, audioWrites: 0, commitsBlocked: true };
			},
			obstruct: () => {
				order.push('obstruct');
				return { obstacle: 'obstacle-1' };
			},
			unobstruct: () => {
				order.push('unobstruct');
				return {};
			},
		},
		info({ debug: true }),
	);

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	// The host is told once the folder is open. Opening made no repository:
	// a lock asked for at launch waits for the first commit to create Git.
	expect(order).toEqual(['injection-launch']);

	const around = workspace.injection!.aroundRecordingWrite;
	const audio = await around(
		{ step: 'audio', stem: 'take', path: 'recordings/take.wav' },
		async () => {
			order.push('audio');
			return 'the folder’s own answer';
		},
	);
	const row = await around({ step: 'row', stem: 'take' }, async () => {
		order.push('row');
		return 'the folder’s own answer';
	});

	expect([audio, row]).toEqual([
		'the folder’s own answer',
		'the folder’s own answer',
	]);
	// Each write is its own: obstructed, made, and cleared before the next.
	expect(order.slice(1)).toEqual([
		'obstruct',
		'audio',
		'unobstruct',
		'obstruct',
		'row',
		'unobstruct',
	]);
	expect(served.operationsAsked.slice(-4)).toMatchObject([
		{
			op: 'obstruct',
			payload: { step: 'audio', stem: 'take', path: 'recordings/take.wav' },
		},
		{ op: 'unobstruct', payload: { obstacle: 'obstacle-1' } },
		{ op: 'obstruct', payload: { step: 'row', stem: 'take' } },
		{ op: 'unobstruct', payload: { obstacle: 'obstacle-1' } },
	]);
	await workspace.close();
});

test('an obstacle that was not placed, or a host that cannot be asked, never keeps a recording write from being made', async () => {
	setup();
	await granted();
	let obstructs: 'none' | 'fault' = 'none';
	const removed: unknown[] = [];
	const served = host(
		{
			'injection-launch': () => {
				throw new Error('the branch is held by another Git process');
			},
			obstruct: () => {
				if (obstructs === 'fault') throw new Error('the host faulted');
				return { obstacle: null };
			},
			unobstruct: (payload) => {
				removed.push(payload);
				return {};
			},
		},
		info({ debug: true }),
	);
	// A launch lock the host could not take does not keep the workspace from opening.
	const workspace = expectOk(
		await openDesktopWorkspace({
			...CONNECTION,
			fetch: async (input, init) => {
				try {
					return await served.fetch(input, init);
				} catch (cause) {
					return Response.json({ fault: String(cause) }, { status: 500 });
				}
			},
		}),
	);
	const write = { step: 'row', stem: 'take' } as const;
	let writes = 0;
	const run = async () => {
		writes += 1;
		return 'written';
	};
	const around = workspace.injection!.aroundRecordingWrite;

	expect(await around(write, run)).toBe('written');
	obstructs = 'fault';
	expect(await around(write, run)).toBe('written');
	// A write that throws still has no obstacle to leave behind.
	await expect(
		around(write, async () => {
			throw new Error('the write threw');
		}),
	).rejects.toThrow('the write threw');

	expect(writes).toBe(2);
	expect(removed).toEqual([]);
	await workspace.close();
});

// ============================================================================
// A reply the host never delivered
// ============================================================================

test('a lost host reply after the endpoint was called is reported as unknown, never as not sent, and nothing is sent again', async () => {
	setup();
	const provider = { transcriptions: 0, completions: 0 };
	const served = await realHost({
		env: {
			WHISPERING_TRANSCRIPTION_API_KEY: 'local-test-key',
			WHISPERING_TRANSCRIPTION_BASE_URL: 'http://127.0.0.1:18080/v1',
		},
		// A counted local stand-in for the endpoint. Nothing leaves this process.
		fetch: async (input) => {
			if (input.endsWith('/audio/transcriptions')) {
				provider.transcriptions += 1;
				return Response.json({ text: 'a steady tone' });
			}
			provider.completions += 1;
			return Response.json({
				choices: [
					{ message: { role: 'assistant', content: 'A steady tone.' } },
				],
			});
		},
	});
	await mkdir(join(served.root, 'recordings'));
	await writeFile(join(served.root, 'recordings', 'take.wav'), toneWav());
	await granted(served.root);
	let losing = true;
	const workspace = expectOk(
		await openDesktopWorkspace({
			...CONNECTION,
			fetch: async (input, init) => {
				const body = init?.body
					? (JSON.parse(String(init.body)) as HostCall)
					: undefined;
				// The host handles the request in full. Its reply is then lost on
				// the way back to the page.
				const reply = await served.fetch(input, init);
				if (losing && (body?.op === 'transcribe' || body?.op === 'transform'))
					throw new TypeError('Load failed');
				return reply;
			},
		}),
	);
	expectOk(
		await workspace.connections.set('text', {
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'chat-model',
			key: { action: 'replace', key: 'text-test-key' },
		}),
	);
	const transcription = {
		audioPath: 'recordings/take.wav',
		expectedBaseUrl: 'http://127.0.0.1:18080/v1',
		model: 'verification-model',
	};
	const transformation = {
		expectedBaseUrl: 'http://127.0.0.1:18080/v1',
		model: 'chat-model',
		prompt: 'Fix the punctuation.',
		input: 'um so a steady tone',
	};

	const transcribed = await workspace.transcribe(transcription);
	const transformed = await workspace.transform(transformation);

	// The endpoint was called, once each, and the page was not told the answer.
	expect(provider).toEqual({ transcriptions: 1, completions: 1 });
	for (const { data: answer, error: lost } of [transcribed, transformed]) {
		expect(answer).toBeNull();
		expect(lost?.name).toBe('HostUnavailable');
		expect(lost?.message).toContain(
			'it is not known whether the request was sent',
		);
		expect(lost?.message).toContain('Load failed');
		expect(lost?.message).not.toContain('nothing was sent');
	}
	// Nothing retried behind the page's back.
	await settle(100);
	expect(provider).toEqual({ transcriptions: 1, completions: 1 });

	// Audio that cannot be read is the certain case: the host answers, says so,
	// and the endpoint is not called, whether or not the reply then arrives.
	losing = false;
	const { error: unreadable } = await workspace.transcribe({
		...transcription,
		audioPath: 'recordings/gone.wav',
	});
	expect(unreadable?.name).toBe('AudioUnreadable');
	expect(provider).toEqual({ transcriptions: 1, completions: 1 });

	// Asking again is the person's choice, and it is one more request.
	const retried = expectOk(await workspace.transcribe(transcription));
	expect(retried).toEqual({ text: 'a steady tone' });
	expect(provider).toEqual({ transcriptions: 2, completions: 1 });
	await workspace.close();
});
