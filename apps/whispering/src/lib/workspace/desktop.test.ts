/**
 * Opening a workspace, and the desktop workspace over a shell and a host that
 * refuse or fail.
 *
 * The shell's replies and the host's answers are scripted here, so these pin
 * what the page itself decides: which storage it asks for, that it names a
 * folder and never a path, that a refusal from either side is returned and
 * nothing else is opened in its place, that the folder's calls go to the
 * shell and not to the host, and how the close question reaches the page.
 * Nothing here runs the Rust owner or a WebView; `packages/folder` tests the
 * adapter against the real owner.
 *
 * Where a test is about what the host really does (answering a close, calling
 * an endpoint before its reply is lost), the host is the real one over its
 * real request handler and a real directory, with a stubbed endpoint.
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { GitSnapshot } from '../../../../../packages/folder/src/native/bindings.gen.js';
import { createHost, type HostOptions } from '../../../native/host.js';
import { encode } from '../bridge/codec.js';
import { toneWav } from '../capture.js';

type Call = { cmd: string; args: Record<string, unknown> };

let inShell = true;
let calls: Call[] = [];
/** The shell's replies by command. A reply that throws is a refusal. */
let replies: Record<string, (call: Call) => unknown> = {};
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(cmd: string, args: Record<string, unknown> = {}) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		calls.push({ cmd: name, args });
		const reply = replies[name];
		if (reply === undefined) throw new Error(`no scripted reply for ${name}`);
		return reply({ cmd: name, args });
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	async listen(name: string, callback: (event: { payload: unknown }) => void) {
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return () => set.delete(callback);
	},
}));

const { openWorkspace } = await import('./index.js');
const { openBrowserWorkspace } = await import('./browser.js');
const { openDesktopWorkspace } = await import('./desktop.js');
const { mountSession } = await import('../session.svelte.ts');
const { createRowSession } = await import('@epicenter/svelte/edit-session');

const ROOT = '/Users/someone/Epicenter/local/so.epicenter.whispering';
const SCOPE = 'so.epicenter.whispering';
const CONNECTION = { origin: 'http://127.0.0.1:4999', token: 'test-token' };

const snapshot = () =>
	({
		branch: 'main',
		remote: null,
		pendingIncoming: null,
		files: { state: 'unknown', error: null },
		sync: { state: 'unknown', error: null },
		activity: {
			scan: { active: false },
			commit: { active: false },
			push: { active: false },
			fetch: { active: false },
			pull: { active: false },
			merge: { active: false },
		},
		lastCommit: null,
		lastPush: null,
		lastFetch: null,
		lastPull: null,
		lastMerge: null,
		closed: false,
	}) satisfies GitSnapshot;

/** A shell whose owner has the folder registered for this window. */
function attachable(root = ROOT) {
	replies = {
		attach: () => ({ session: 7, root, sequence: 3, snapshot: snapshot() }),
		detach: () => null,
	};
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
const answer = (ok: unknown) => Response.json({ ok: encode(ok) });
const info = (overrides: Record<string, unknown> = {}) => ({
	root: ROOT,
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

/**
 * A host whose operations are scripted. Its event streams stay open until
 * ended by the test, and each one is handed over so a test can write to it.
 */
function host(
	operations: Record<string, (payload: unknown) => unknown> = {},
	hostInfo = info(),
) {
	const requested: string[] = [];
	const operationsAsked: HostCall[] = [];
	const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const path = new URL(input).pathname;
		requested.push(path);
		if (path === '/bridge/events')
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						streams.push(controller);
					},
				}),
			);
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
		streams,
		say(event: unknown, stream = streams.at(-1)) {
			stream?.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
		},
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
	replies = {};
	listeners.clear();
	const scope = globalThis as { window?: unknown; location?: unknown };
	delete scope.window;
	delete scope.location;
});

/**
 * The globals the page has when a shell did, or did not, inject the host's
 * token: the token, the page's origin, the shell's page events, and where the
 * page was told to navigate.
 */
function setup(
	{ bridge }: { bridge: { token: string } | undefined } = {
		bridge: { token: CONNECTION.token },
	},
) {
	const scope = globalThis as { window?: unknown; location?: unknown };
	const events = new EventTarget();
	const navigations: string[] = [];
	const listening = new Set<EventListener>();
	scope.window = {
		__WHISPERING_BRIDGE__: bridge,
		addEventListener(type: string, listener: EventListener) {
			listening.add(listener);
			events.addEventListener(type, listener);
		},
		removeEventListener(type: string, listener: EventListener) {
			listening.delete(listener);
			events.removeEventListener(type, listener);
		},
		location: { assign: (url: string) => navigations.push(url) },
	};
	scope.location = { origin: CONNECTION.origin };
	return {
		navigations,
		/** How many page-event listeners are attached now. */
		get listening() {
			return listening.size;
		},
		/** What the shell does when a close is attempted and its host is gone. */
		closeBlocked: () =>
			events.dispatchEvent(new Event('whispering:close-blocked')),
	};
}

/**
 * The real host over a real directory, reached through its own request
 * handler. `approvals` counts the line it would print to let the shell close.
 */
async function realHost(overrides: Partial<HostOptions> = {}) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-desktop-')),
	);
	const root = join(directory, 'data');
	await mkdir(root);
	let approvals = 0;
	const served = await createHost({
		root,
		token: CONNECTION.token,
		uiDist: undefined,
		debug: false,
		fixturePath: undefined,
		env: {},
		log: () => {},
		onCloseApproved: () => {
			approvals += 1;
		},
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
		get approvals() {
			return approvals;
		},
	};
}

/** Wait for something another task does, without guessing how long it takes. */
async function until(condition: () => boolean, what: string) {
	for (let waited = 0; waited < 300; waited++) {
		if (condition()) return;
		await settle(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ============================================================================
// Which storage is asked for
// ============================================================================

test('inside a desktop app with no Whispering host, nothing is opened: no folder, no host call, no browser storage', async () => {
	setup({ bridge: undefined });
	attachable();

	const refused = expectErr(await openWorkspace());

	expect(refused.name).toBe('HostMissing');
	expect(refused.message).toContain('browser storage is not used');
	// A folder the shell would have attached is not a reason to open half an app.
	expect(calls).toEqual([]);
	expect(listeners.size).toBe(0);
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
	attachable();
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
	// One request to the host, nothing after it, and no attach.
	expect(requested).toEqual(['/bridge/app']);
	expect(calls).toEqual([]);
});

test('the page names the folder by its ID and nothing else, and shows the directory the owner reports', async () => {
	setup();
	attachable();
	const served = host();

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	// No root, author, remote, or policy: the shell decided all of them.
	expect(sent('attach')).toHaveLength(1);
	expect(sent('attach')[0]?.args).toEqual({
		scope: SCOPE,
		protocol: expect.any(Number),
	});
	expect(workspace.kind).toBe('native');
	expect(workspace.location).toBe(ROOT);
	expect(workspace.folder.git.snapshot.branch).toBe('main');
	await workspace.close();
	expect(sent('detach')).toEqual([{ cmd: 'detach', args: { session: 7 } }]);
});

test('a refusal from the shell’s owner is returned, and nothing is opened in its place', async () => {
	setup();
	for (const refusal of [
		{ name: 'UnknownScope', scope: SCOPE },
		{ name: 'WindowNotPermitted', scope: SCOPE, window: 'other' },
		{ name: 'Busy', root: ROOT },
		{ name: 'Incompatible', host: 9, page: 2 },
		// What Tauri answers a window with no capability for the plugin.
		'epicenter-folder.attach not allowed',
	]) {
		calls = [];
		replies = {
			attach: () => {
				throw refusal;
			},
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
		// One attempt, no event stream, no later host call.
		expect(calls.map((call) => call.cmd)).toEqual(['attach']);
		expect(served.requested).toEqual(['/bridge/app']);
		expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
	}
});

test('a host that uses another directory than the owner’s is refused, and the window detaches', async () => {
	setup();
	attachable('/Users/someone/elsewhere');
	const served = host();

	const refused = expectErr(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(refused.name).toBe('FolderMismatch');
	expect(refused.message).toContain('/Users/someone/elsewhere');
	expect(refused.message).toContain(ROOT);
	// Attaching publishes the folder's definition; nothing else reaches the owner.
	expect(
		calls.map((call) => call.cmd).filter((cmd) => cmd !== 'apply'),
	).toEqual(['attach', 'detach']);
	expect(served.requested).toEqual(['/bridge/app']);
});

// ============================================================================
// The folder is the shell's
// ============================================================================

test('saves and history go to the shell’s owner and never to the host', async () => {
	setup();
	attachable();
	Object.assign(replies, {
		apply: () => null,
		commit: () => ({ status: 'unchanged', head: null, indexWarning: null }),
		read: () => {
			throw { name: 'NotFound', path: 'notes.md' };
		},
	});
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	const audio = new Uint8Array([1, 2, 3]);

	// Each write is the shared adapter's own call: one `apply` apiece, in order.
	expectOk(await workspace.folder.files.create('recordings/a.wav', audio));
	expectOk(await workspace.folder.files.create('notes.md', 'hello'));
	expect((await workspace.folder.git.commit()).status).toBe('unchanged');
	const { error: readError } = await workspace.folder.files.read('notes.md');
	expect(readError?.name).toBe('NotFound');

	expect(
		sent('apply')
			.map((call) =>
				(call.args.changes as { path: string }[]).map((change) => change.path),
			)
			// Attaching publishes the folder's definition first.
			.filter((paths) => !paths.includes('epicenter.json')),
	).toEqual([['recordings/a.wav'], ['notes.md']]);
	expect(sent('commit')).toHaveLength(1);
	// The host was asked who it is, and for its event stream. Nothing else.
	expect(served.operationsAsked.map((call) => call.op)).toEqual(['info']);
	expect(new Set(served.requested)).toEqual(
		new Set(['/bridge/app', '/bridge/events']),
	);
	await workspace.close();
});

test('a row save whose reply the shell never sent stays unknown, and later input starts another save', async () => {
	setup();
	attachable();
	const disk = new Map<string, Uint8Array>([
		[
			'transformations/clean.md',
			new TextEncoder().encode(
				'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n',
			),
		],
	]);
	const written: string[] = [];
	let loseReplies = false;
	Object.assign(replies, {
		// While replies are lost, the owner cannot be asked what landed either.
		read: ({ args }: Call) => {
			if (loseReplies) throw 'the reply was lost';
			const bytes = disk.get(String(args.path));
			if (bytes === undefined) throw { name: 'NotFound', path: args.path };
			return {
				bytes: [...bytes],
				sha256: createHash('sha256').update(bytes).digest('hex'),
			};
		},
		// The owner writes, and the reply never reaches the page.
		apply: ({ args }: Call) => {
			for (const change of args.changes as {
				path: string;
				bytes: number[];
			}[]) {
				disk.set(change.path, Uint8Array.from(change.bytes));
				written.push(new TextDecoder().decode(Uint8Array.from(change.bytes)));
			}
			if (loseReplies) throw 'the reply was lost';
			return null;
		},
	});
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	const table = workspace.folder.tables.transformations;
	const session = createRowSession(table, expectOk(await table.get('clean'))!);
	// From here the owner writes, and its replies never reach the page.
	written.length = 0;
	loseReplies = true;
	const lost = async () => {
		const state = await session.settled();
		return state.status === 'error' ? state.error : undefined;
	};

	session.edit((row) => {
		row.body = 'Tidy it.\n';
	});
	expect(await lost()).toMatchObject({
		name: 'Unconfirmed',
		message: expect.stringContaining('the reply was lost'),
	});
	expect(written).toHaveLength(1);

	// Later input starts another write, whose reply is lost too.
	session.edit((row) => {
		row.body = 'Tidy it more.\n';
	});
	expect(session.draft.body).toBe('Tidy it more.\n');
	expect((await lost())?.name).toBe('Unconfirmed');
	expect(written).toHaveLength(2);

	// Saving again is the person's choice, and writes the latest input; its
	// own reply confirms it.
	loseReplies = false;
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(written).toHaveLength(3);
	expect(written[2]).toContain('Tidy it more.');

	session.release();
	await workspace.close();
});

// ============================================================================
// The close question
// ============================================================================

test('a close question reaches the page from the host’s stream, across a reconnect, and one that came early is not lost', async () => {
	setup();
	attachable();
	const served = host({ close: () => ({ closing: false }) });
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	await settle();
	expect(served.streams).toHaveLength(1);

	// Asked before the session's guard was listening: kept for it.
	served.say({ type: 'close-requested' });
	await settle();
	let asked = 0;
	const stop = workspace.closing!.onRequest(() => {
		asked += 1;
	});
	expect(asked).toBe(1);

	served.say({ type: 'ping' });
	served.say({ type: 'close-requested' });
	await settle();
	expect(asked).toBe(2);

	// The stream drops. The workspace connects again by itself, and the host
	// repeats an unanswered question on the new stream.
	served.streams[0]?.close();
	await settle(650);
	expect(served.streams).toHaveLength(2);
	served.say({ type: 'close-requested' });
	await settle();
	expect(asked).toBe(3);

	// The answer is an ordinary authenticated call to the host.
	await workspace.closing!.answer('cancel');
	expect(served.operationsAsked.at(-1)).toMatchObject({
		op: 'close',
		payload: { decision: 'cancel' },
	});

	stop();
	await workspace.close();
	// Closed: no further stream is opened, and the window detached once.
	await settle(650);
	expect(served.streams).toHaveLength(2);
	expect(sent('detach')).toHaveLength(1);
});

test('a close attempted with the host gone before anything listens is kept for the first listener, and closing stops hearing it', async () => {
	const shell = setup({ bridge: { token: CONNECTION.token } });
	attachable();
	const served = host();
	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);
	expect(shell.listening).toBe(1);

	// The session is still starting: no guard is listening yet. The attempt
	// is not answered and not lost.
	shell.closeBlocked();
	expect(shell.navigations).toEqual([]);
	let told = 0;
	const stop = workspace.closing!.onRequestWithoutHost(() => {
		told += 1;
	});
	expect(told).toBe(1);

	shell.closeBlocked();
	expect(told).toBe(2);
	// Quitting is still only what the listener chooses to do.
	expect(shell.navigations).toEqual([]);
	workspace.closing!.quitWithoutHost();
	expect(shell.navigations).toEqual([
		`${CONNECTION.origin}/__whispering__/quit`,
	]);

	stop();
	await workspace.close();
	expect(shell.listening).toBe(0);
	shell.closeBlocked();
	expect(told).toBe(2);
});

test('a host that stops answering does not close the folder: the page keeps saving and keeps trying the stream', async () => {
	setup();
	attachable();
	Object.assign(replies, { apply: () => null });
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
	await settle();

	hostUp = false;
	served.streams[0]?.error(new Error('the host stopped'));
	await settle(650);

	// The owner is the shell's, so a save still lands with the host gone.
	expectOk(await workspace.folder.files.create('note.md', 'still saved'));
	// What needs the host answers as unavailable, as a Result.
	const { error: transcribeError } = await workspace.transcribe({
		audioPath: 'recordings/a.wav',
		expectedBaseUrl: 'u',
		model: 'm',
	});
	expect(transcribeError?.name).toBe('HostUnavailable');
	// An answer that cannot be delivered rejects, so the guard can say so; the
	// window stays open.
	await expect(workspace.closing!.answer('proceed')).rejects.toThrow(
		'Load failed',
	);
	await workspace.close();
	expect(sent('detach')).toHaveLength(1);
});

// ============================================================================
// Host operations
// ============================================================================

test('a failed transcription call is a Result, and the next call still works', async () => {
	setup();
	attachable();
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
	expect(sent('read')).toEqual([]);
	await workspace.close();
});

test('a failed transformation call is a Result, and the next call still works', async () => {
	setup();
	attachable();
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
	attachable(served.root);
	const usb = { deviceId: 'usb-id', label: 'USB Microphone' };
	const replies: string[] = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const response = await served.fetch(input, init);
		if (!input.endsWith('/bridge/events'))
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
	attachable();
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
	attachable();
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
	attachable();
	const served = host();

	const workspace = expectOk(
		await openDesktopWorkspace({ ...CONNECTION, fetch: served.fetch }),
	);

	expect(workspace.injection).toBeUndefined();
	expect(workspace.debugControls).toBe(false);
	expect(served.operationsAsked.map((call) => call.op)).toEqual(['info']);
	await workspace.close();
});

test('a debug shell tells the host the folder is open only after the owner attached it, and wraps each recording write in its own obstacle', async () => {
	setup();
	attachable();
	const order: string[] = [];
	const attach = replies.attach!;
	replies.attach = (call) => {
		order.push('attach');
		return attach(call);
	};
	const served = host(
		{
			'injection-launch': () => {
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
	// Git exists once the owner has opened the folder, and not before.
	expect(order).toEqual(['attach', 'injection-launch']);

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
	expect(order.slice(2)).toEqual([
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
	attachable();
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
// Closing a window whose folder could not be opened
// ============================================================================

test('after a refused attach there is no session, and the person’s close is answered with proceed by the real host', async () => {
	const served = await realHost();
	globalThis.fetch = served.fetch as typeof fetch;
	setup({ bridge: { token: CONNECTION.token } });
	const refusedAttach = Promise.withResolvers<never>();
	replies = { attach: () => refusedAttach.promise };

	const mounted = mountSession();
	cleanups.push(() => mounted.release());
	// The person asks to close while the folder is still being opened. Nothing
	// answers for an opening that has not settled: it might yet hold work.
	await until(() => sent('attach').length === 1, 'the attach to be sent');
	served.host.closeRequested();
	await settle(100);
	expect(served.approvals).toBe(0);

	// The owner refuses this window. No session exists and nothing is held.
	refusedAttach.reject({
		name: 'WindowNotPermitted',
		scope: SCOPE,
		window: 'main',
	});
	const refused = expectErr(await mounted.opening);
	expect(refused.name).toBe('DesktopFolder');

	// The close asked during opening was kept by the host and is now answered.
	await until(() => served.approvals === 1, 'the pending close to be approved');
	// And so is one asked afterward. Each approval answers a request.
	served.host.closeRequested();
	await until(() => served.approvals === 2, 'a later close to be approved');
	// Nothing was opened to get there: one attach, refused, and no browser storage.
	expect(calls.map((call) => call.cmd)).toEqual(['attach']);

	// Released, it answers nothing more: a later opening would be its own judge.
	mounted.release();
	await settle(50);
	served.host.closeRequested();
	await settle(150);
	expect(served.approvals).toBe(2);
});

test('nothing is approved unasked: a failed opening by itself closes nothing', async () => {
	const served = await realHost();
	globalThis.fetch = served.fetch as typeof fetch;
	const shell = setup({ bridge: { token: CONNECTION.token } });
	attachable('/Users/someone/elsewhere');

	const mounted = mountSession();
	cleanups.push(() => mounted.release());
	expect(expectErr(await mounted.opening).name).toBe('FolderMismatch');
	await settle(200);

	// The window stays until the person asks: no approval and no navigation.
	expect(served.approvals).toBe(0);
	expect(shell.navigations).toEqual([]);
	// The mismatch detached the window it had attached.
	expect(
		calls.map((call) => call.cmd).filter((cmd) => cmd !== 'apply'),
	).toEqual(['attach', 'detach']);
});

test('after a failed opening with the host gone, the shell’s close attempt is answered with the quit address', async () => {
	const shell = setup({ bridge: { token: CONNECTION.token } });
	attachable();
	const hostDown = Promise.withResolvers<never>();
	globalThis.fetch = (() => hostDown.promise) as unknown as typeof fetch;

	const mounted = mountSession();
	cleanups.push(() => mounted.release());
	// Still opening: a close attempt is not answered.
	shell.closeBlocked();
	await settle(20);
	expect(shell.navigations).toEqual([]);

	globalThis.fetch = (async () => {
		throw new TypeError('Load failed');
	}) as unknown as typeof fetch;
	hostDown.reject(new TypeError('Load failed'));
	expect(expectErr(await mounted.opening).name).toBe('HostUnreachable');
	// The host was never reached, so the owner was never asked for a folder.
	expect(calls).toEqual([]);
	await settle(50);
	expect(shell.navigations).toEqual([]);

	// The person closes. The shell cannot ask a host that is gone, and says so.
	shell.closeBlocked();
	expect(shell.navigations).toEqual([
		`${CONNECTION.origin}/__whispering__/quit`,
	]);

	mounted.release();
	shell.closeBlocked();
	expect(shell.navigations).toHaveLength(1);
});

test('after an opening that failed without proof, the real host approves only the person’s own Quit', async () => {
	const served = await realHost();
	globalThis.fetch = served.fetch as typeof fetch;
	const shell = setup({ bridge: { token: CONNECTION.token } });
	// The failure is not one that proves anything was released, as when the
	// desktop workspace's own module cannot be loaded.
	const mounted = mountSession(async () => {
		throw new Error('Failed to fetch dynamically imported module');
	});
	cleanups.push(() => mounted.release());
	await expect(mounted.opening).rejects.toThrow('dynamically imported');
	served.host.closeRequested();
	await settle(100);

	// The shell's question is not answered for the person.
	expect(served.approvals).toBe(0);
	expect(shell.navigations).toEqual([]);

	expect(await mounted.quit?.()).toBeUndefined();
	expect(served.approvals).toBe(1);
	expect(shell.navigations).toEqual([]);
});

test('a Quit the host cannot take also uses the quit address, and says it was not confirmed', async () => {
	globalThis.fetch = (async () => {
		throw new TypeError('Load failed');
	}) as unknown as typeof fetch;
	const shell = setup({ bridge: { token: CONNECTION.token } });
	const mounted = mountSession(async () => {
		throw new Error('Failed to fetch dynamically imported module');
	});
	cleanups.push(() => mounted.release());
	await expect(mounted.opening).rejects.toThrow('dynamically imported');

	const problem = await mounted.quit?.();

	expect(problem).toContain('could not confirm the quit');
	expect(shell.navigations).toEqual([
		`${CONNECTION.origin}/__whispering__/quit`,
	]);
});

test('a desktop app that is not Whispering’s shell, and a browser tab, are asked no close question and answer none', async () => {
	const requested: string[] = [];
	globalThis.fetch = (async (input: string) => {
		requested.push(input);
		throw new TypeError('Load failed');
	}) as unknown as typeof fetch;

	// Inside another desktop app: no host token was injected.
	const embedded = setup({ bridge: undefined });
	const inApp = mountSession();
	expect(expectErr(await inApp.opening).name).toBe('HostMissing');
	// Nothing to quit through, so no Quit is offered.
	expect(inApp.quit).toBeUndefined();
	embedded.closeBlocked();
	await settle(50);
	inApp.release();

	// A browser tab that somehow carries a token: the browser owns leaving.
	inShell = false;
	const tab = setup({ bridge: { token: 'left-over-token' } });
	const inTab = mountSession();
	expect(expectErr(await inTab.opening).name).toBe('BrowserFolder');
	expect(inTab.quit).toBeUndefined();
	tab.closeBlocked();
	await settle(50);
	inTab.release();

	expect(requested).toEqual([]);
	expect(embedded.navigations).toEqual([]);
	expect(tab.navigations).toEqual([]);
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
	attachable(served.root);
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
