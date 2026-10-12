/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` adapter and the
 * real Capture store, with the shell's `invoke` and events scripted.
 * The scripted owner keeps files in memory and checks versions and presence
 * the way the shell's owner does; it stands in for the reply shapes and lets
 * a test lose a reply or fail a read or a write. It does not run the owner.
 *
 * Key behaviors:
 * - Outside the shell, a refused window, an unregistered scope, and a missing
 *   plugin each fail the open with a reason, and leave no listener behind
 * - The page names the Capture scope and is told the directory; the host's
 *   stop is heard on this window only
 * - Closing detaches this page once, and a sibling page keeps saving
 * - A save sends the whole row as one replacement guarded by the bytes this
 *   page last saved, and keeps undeclared metadata
 * - An edit made elsewhere is a conflict and is not overwritten
 * - A lost reply is unknown and shown as such; saving again is guarded, so a
 *   save that did land answers as a conflict for the person to resolve
 * - Closing waits for every save already requested
 * - A failed commit is reported beside a saved file; a closed folder is
 *   reported as stopped
 * - An import whose first save lost its reply is finished by a retry
 *
 * See also:
 * - `packages/folder/src/tauri.test.ts` for what the adapter decides
 * - `packages/folder/src/tauri-native.test.ts` for the real Rust owner
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import { HOST_STOPPED_EVENT } from '@epicenter/epicenter/page-close';
import { expectOk } from 'wellcrafted/testing';
import type {
	FileChange as Change,
	GitSnapshot,
} from '../../../../../packages/folder/src/native/bindings.gen.js';
import fixture from '../../../fixtures/legacy-bundle.json';
import { CAPTURE_FOLDER_ID } from './types.js';

const ROOT = '/Users/someone/Epicenter/so.epicenter.capture';
const PLUGIN = 'plugin:epicenter-folder|';
const SNAPSHOT_CHANGED = 'plugin:epicenter-folder:folder-snapshot-changed';

type Call = { cmd: string; args: Record<string, unknown> };
let inShell = true;
let calls: Call[] = [];
/** Replaces the owner's reply to one command. Throw an `Error` to lose the reply. */
let overrides: Record<string, (call: Call, reply: () => unknown) => unknown> =
	{};
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
/** This window's focus listeners, kept beside its events. */
const FOCUS = 'focus-changed';
/** Events heard through this window only, by event name. */
const windowListeners = new Map<string, Set<() => void>>();
const files = new Map<string, Uint8Array>();
const sessions = new Set<number>();
let nextSession = 1;

const hashOf = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

const wireSnapshot = (overridden: Partial<GitSnapshot> = {}) =>
	({
		branch: 'main',
		remote: null,
		commitOnEdit: true,
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
		...overridden,
	}) satisfies GitSnapshot;

/** A Rust `Err` rejects with the error value itself, not an `Error`. */
const refuse = (error: unknown): never => {
	throw error;
};

function own({ cmd, args }: Call): unknown {
	const read = (path: string) => {
		const bytes = files.get(path);
		if (bytes === undefined) return undefined;
		return { bytes: Array.from(bytes), sha256: hashOf(bytes) };
	};
	switch (cmd) {
		case 'attach': {
			const session = nextSession++;
			sessions.add(session);
			return { session, root: ROOT, sequence: 0, snapshot: wireSnapshot() };
		}
		case 'detach':
			sessions.delete(args.session as number);
			return null;
		case 'children': {
			const prefix = `${args.directory as string}/`;
			const names = [...files.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length));
			if (names.length === 0)
				return refuse({ name: 'NotFound', path: args.directory });
			return { files: names, directories: [] };
		}
		case 'read':
			return (
				read(args.path as string) ??
				refuse({ name: 'NotFound', path: args.path })
			);
		case 'read_many':
			return (args.paths as string[]).map((path) => {
				const found = read(path);
				return found === undefined
					? { status: 'err', error: { name: 'NotFound', path } }
					: { status: 'ok', value: found };
			});
		case 'apply': {
			const changes = args.changes as Change[];
			for (const change of changes) {
				if (change.kind === 'move')
					throw new Error('this fixture does not move files');
				const current = files.get(change.path);
				if (change.kind === 'create' && current !== undefined)
					return refuse({
						name: 'Refused',
						error: { name: 'Exists', path: change.path },
					});
				// A replacement requires its file, guarded or not: nothing is put back.
				if (
					(change.kind === 'remove' || change.kind === 'replace') &&
					current === undefined &&
					change.expectedSha256 == null
				)
					return refuse({
						name: 'Refused',
						error: { name: 'NotFound', path: change.path },
					});
				if (
					(change.kind === 'replace' || change.kind === 'remove') &&
					change.expectedSha256 != null
				) {
					const actualSha256 = current === undefined ? null : hashOf(current);
					if (actualSha256 !== change.expectedSha256)
						return refuse({
							name: 'Refused',
							error: {
								name: 'Conflict',
								path: change.path,
								expectedSha256: change.expectedSha256,
								actualSha256,
							},
						});
				}
			}
			for (const change of changes) {
				if (change.kind === 'move')
					throw new Error('this fixture does not move files');
				if (change.kind === 'remove') files.delete(change.path);
				else files.set(change.path, Uint8Array.from(change.bytes));
			}
			return null;
		}
		case 'commit':
			return { status: 'unchanged', head: null, indexWarning: null };
		default:
			throw new Error(`the scripted owner has no ${cmd}`);
	}
}

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(name: string, args: Record<string, unknown> = {}) {
		const call = { cmd: name.replace(PLUGIN, ''), args };
		calls.push(call);
		const override = overrides[call.cmd];
		return override ? override(call, () => own(call)) : own(call);
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen(name: string, callback: (event: { payload: unknown }) => void) {
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return Promise.resolve(() => set.delete(callback));
	},
}));
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({
		label: 'capture',
		listen(name: string, callback: () => void) {
			const set = windowListeners.get(name) ?? new Set();
			windowListeners.set(name, set);
			set.add(callback);
			return Promise.resolve(() => set.delete(callback));
		},
		onFocusChanged(callback: (event: { payload: boolean }) => void) {
			const set = windowListeners.get(FOCUS) ?? new Set();
			windowListeners.set(FOCUS, set);
			const listener = () => callback({ payload: true });
			set.add(listener);
			return Promise.resolve(() => set.delete(listener));
		},
	}),
}));

const { openCaptureHost, hostSignals } = await import(
	'./folder.epicenter-host.js'
);
const { createCaptures } = await import('../captures.svelte.ts');

function emit(name: string, payload?: unknown) {
	for (const listener of listeners.get(name) ?? []) listener({ payload });
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
const listening = () =>
	[...listeners.values()].reduce((count, set) => count + set.size, 0);
const text = (path: string) => new TextDecoder().decode(files.get(path));
const put = (path: string, source: string | Uint8Array) =>
	files.set(
		path,
		typeof source === 'string' ? new TextEncoder().encode(source) : source,
	);

const SAVED =
	'---\ncapturedAt: 2026-10-01T10:30:00+08:00\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n  nested line\n';
const PATH = 'captures/one.md';
/** SAVED as a save writes it: plain YAML frontmatter, the body byte for byte. */
const FORMATTED = SAVED.replace(
	'capturedAt: 2026-10-01T10:30:00+08:00\n',
	'capturedAt: "2026-10-01T10:30:00+08:00"\n',
);
const withText = (body: string) => FORMATTED.replace('\nText\n', `\n${body}\n`);
const LOST = 'the webview lost its IPC connection';

async function opened() {
	const host = await openCaptureHost();
	const captures = createCaptures(host);
	await captures.refresh();
	return { host, captures };
}

/** The open capture at PATH. */
async function openOne(
	captures: Awaited<ReturnType<typeof opened>>['captures'],
) {
	await captures.open('one', 'capture');
	const item = captures.opened;
	if (item?.kind !== 'capture') throw new Error(`opened ${item?.kind}`);
	return item;
}

const encode = (source: string) => new TextEncoder().encode(source);
const replaced = () =>
	sent('apply').flatMap((call) => call.args.changes as Change[]);

afterEach(() => {
	inShell = true;
	calls = [];
	overrides = {};
	listeners.clear();
	windowListeners.clear();
	files.clear();
	sessions.clear();
});

test('outside the desktop shell, opening fails with the reason and invokes nothing', async () => {
	inShell = false;

	await expect(openCaptureHost()).rejects.toThrow('desktop app');

	expect(calls).toEqual([]);
	expect(listening()).toBe(0);
});

test.each([
	[
		'a scope the shell did not register',
		() => refuse({ name: 'UnknownScope', scope: CAPTURE_FOLDER_ID }),
		`no folder registered as '${CAPTURE_FOLDER_ID}'`,
	],
	[
		'a window the scope does not allow',
		() =>
			refuse({
				name: 'WindowNotPermitted',
				scope: CAPTURE_FOLDER_ID,
				window: 'capture',
			}),
		"The window 'capture' may not use the folder",
	],
	[
		'a folder another Epicenter holds',
		() => refuse({ name: 'Busy', root: ROOT }),
		ROOT,
	],
	[
		'an attach that never reaches the shell',
		() => {
			throw new Error(LOST);
		},
		LOST,
	],
] as const)('%s fails the open with its reason and leaves no listener', async (_name, attach, reason) => {
	overrides.attach = attach;

	await expect(openCaptureHost()).rejects.toThrow(reason);

	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect(listening()).toBe(0);
});

test('a plugin the shell did not install fails the open instead of opening anything else', async () => {
	// Tauri rejects an unknown or unpermitted command with a bare string.
	overrides.attach = () => refuse('epicenter-folder.attach not allowed');

	const failure = await openCaptureHost().then(
		() => undefined,
		(error: unknown) => error,
	);

	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe(
		'The folder could not be opened: epicenter-folder.attach not allowed',
	);
	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect(listening()).toBe(0);
});

test('the page names the Capture scope and is told the directory', async () => {
	const host = await openCaptureHost();

	expect(sent('attach')[0]?.args).toEqual({
		scope: 'so.epicenter.capture',
		protocol: 9,
	});
	expect(host.location).toEqual({ kind: 'directory', root: ROOT });
	await host.close();
});

test('the host stopping is heard on this window only', async () => {
	const { captures } = await opened();
	let stopped = 0;
	const stopHearing = await hostSignals.stopped?.(() => stopped++);
	// Targeted at this window, not any window's global listener.
	expect(windowListeners.get(HOST_STOPPED_EVENT)?.size).toBe(1);
	expect(listeners.has(HOST_STOPPED_EVENT)).toBe(false);

	for (const listener of windowListeners.get(HOST_STOPPED_EVENT) ?? [])
		listener();
	expect(stopped).toBe(1);
	stopHearing?.();
	expect(windowListeners.get(HOST_STOPPED_EVENT)?.size).toBe(0);
	await captures.close();
});

test('closing detaches this page once, and a sibling page keeps saving', async () => {
	const first = await openCaptureHost();
	const second = await openCaptureHost();
	const [mine, theirs] = [...sessions] as [number, number];
	calls = [];

	await first.close();
	await first.close();

	expect(calls).toEqual([{ cmd: 'detach', args: { session: mine } }]);
	expect([...sessions]).toEqual([theirs]);
	expectOk(await second.folder.files.create(PATH, SAVED));
	expect(text(PATH)).toBe(SAVED);
	await second.close();
	expect(listening()).toBe(0);
});

test('a save sends the whole row as one replacement guarded by the bytes this page last saved', async () => {
	put(PATH, SAVED);
	const { captures } = await opened();
	const { session, form } = await openOne(captures);
	calls = [];

	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	expect((await session.settled()).status).toBe('saved');

	const expected = `${FORMATTED}- second\n`;
	expect(text(PATH)).toBe(expected);
	expect(sent('apply')).toHaveLength(1);
	expect(replaced()).toMatchObject([
		{
			kind: 'replace',
			path: PATH,
			bytes: Array.from(encode(expected)),
			expectedSha256: hashOf(encode(SAVED)),
		},
	]);
	await captures.close();
});

test('an edit made elsewhere is a conflict and is not overwritten', async () => {
	put(PATH, SAVED);
	const { captures } = await opened();
	const { session, form } = await openOne(captures);
	const theirs = `${SAVED}- from another window\n`;
	put(PATH, theirs);

	form.inputText('Mine');
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(text(PATH)).toBe(theirs);
	expect(await captures.keepMine(session)).toBeUndefined();
	await session.settled();
	expect(text(PATH)).toBe(`${withText('Mine')}`);
	await captures.close();
});

test('a save whose reply is lost is confirmed by one read when it landed', async () => {
	put(PATH, SAVED);
	const { captures } = await opened();
	const { session, form } = await openOne(captures);
	overrides.apply = (_call, reply) => {
		reply();
		throw new Error(LOST);
	};

	form.inputText('Mine');
	expect((await session.settled()).status).toBe('saved');
	delete overrides.apply;
	expect(text(PATH)).toBe(withText('Mine'));
	// Its own landed save guards the next one.
	form.inputText('Mine, more');
	expect((await session.settled()).status).toBe('saved');
	expect(text(PATH)).toBe(withText('Mine, more'));
	await captures.close();
});

test('a save whose reply is lost and did not land stays unknown until it is saved again', async () => {
	put(PATH, SAVED);
	const { captures } = await opened();
	const { session, form } = await openOne(captures);
	overrides.apply = () => {
		throw new Error(LOST);
	};

	form.inputText('Mine');
	const lost = await session.settled();
	delete overrides.apply;
	expect(lost.status === 'error' && lost.error.name).toBe('Unconfirmed');
	expect(text(PATH)).toBe(SAVED);
	expect(captures.unsettled).toBe(1);

	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(text(PATH)).toBe(withText('Mine'));
	expect(captures.unsettled).toBe(0);
	await captures.close();
});

test('closing waits for a save already sent and the latest edit after it, and only then detaches', async () => {
	put(PATH, SAVED);
	const { captures } = await opened();
	const { form } = await openOne(captures);
	calls = [];
	const landing = Promise.withResolvers<void>();
	overrides.apply = async (_call, reply) => {
		await landing.promise;
		return reply();
	};

	form.inputText('Submitted');
	form.inputText('Typed later');
	let closed = false;
	const closing = captures.close().then(() => {
		closed = true;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	expect(sent('detach')).toEqual([]);

	landing.resolve();
	await closing;
	expect(text(PATH)).toBe(withText('Typed later'));
	expect(sent('apply')).toHaveLength(2);
	expect(sent('detach')).toHaveLength(1);
});

test('a failed commit is reported beside a saved file, and retried without rewriting it', async () => {
	const { captures } = await opened();
	captures.inputNewCapture('Saved before history');
	expect(await captures.create()).toBeUndefined();
	const path =
		captures.opened?.kind === 'capture' ? captures.opened.session.path : '';
	const saved = text(path);

	emit(SNAPSHOT_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		sequence: 1,
		snapshot: wireSnapshot({
			lastCommit: {
				at: 1,
				result: { status: 'failed', error: 'index.lock exists' },
			},
		}),
	});

	expect(captures.git.lastCommit).toMatchObject({
		status: 'failed',
		error: 'index.lock exists',
	});
	expect(captures.unsettled).toBe(0);
	expect(captures.folderStopped).toBe(false);
	calls = [];
	expect((await captures.commit()).status).toBe('unchanged');
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);
	expect(text(path)).toBe(saved);
	await captures.close();
});

test('a folder its owner closed is reported as stopped, and the text typed stays', async () => {
	const { captures } = await opened();
	emit(SNAPSHOT_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		sequence: 1,
		snapshot: wireSnapshot({ closed: true }),
	});
	expect(captures.folderStopped).toBe(true);
	expect(captures.serviceStopped).toBe(false);

	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });
	captures.inputNewCapture('typed after the folder closed');
	expect(await captures.create()).toContain('was not saved');
	expect(captures.newCapture).toBe('typed after the folder closed');
	await captures.close();
});

test('an import whose first save lost its reply is finished by a retry, and repeats create nothing', async () => {
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('the fixture is not a bundle');
	const { captures } = await opened();
	let lost = 0;
	overrides.apply = (_call, reply) => {
		reply();
		lost++;
		throw new Error(LOST);
	};

	// The export landed, but its reply did not: nothing is claimed.
	await expect(captures.importLegacy(read.bundle)).rejects.toThrow(
		'Nothing was imported',
	);
	expect(lost).toBe(1);
	const exported = [...files.keys()].filter((path) =>
		path.startsWith('recovery/legacy-export-'),
	);
	expect(exported).toHaveLength(1);
	const original = text(exported[0] as string);

	delete overrides.apply;
	const retry = await captures.importLegacy(read.bundle);
	expect(retry.complete).toBe(true);
	expect(retry.documents.map((document) => document.status)).toEqual(
		Array.from({ length: 6 }, () => 'created'),
	);
	expect(text(exported[0] as string)).toBe(original);

	const again = await captures.importLegacy(read.bundle);
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toHaveLength(6);
	expect(
		[...files.keys()].filter((path) => path.startsWith('captures/')),
	).toHaveLength(6);
	await captures.close();
});
