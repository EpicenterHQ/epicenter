/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` page engine and
 * the real Capture store, on a real directory with the system `git`. The
 * shell's `invoke` is scripted: `grant_directory` grants a fresh temporary
 * directory, and the commands that follow a grant act on it (see
 * `granted-directory.test-support.ts`). Departure events are scripted too.
 *
 * Key behaviors:
 * - Outside the shell, opening fails and invokes nothing
 * - A refused grant (an unregistered scope, a refused window, a folder
 *   another Epicenter holds, a missing plugin, a call that never reaches the
 *   shell) fails the open with its reason
 * - The page names the Capture scope and is told the directory; departure is
 *   heard on this window only
 * - A write saves the row and keeps undeclared metadata
 * - An edit made elsewhere is a conflict: it is not overwritten, and the
 *   capture shows it
 * - Closing waits for a save already sent and the latest edit after it
 * - Save version commits and rewrites no file
 * - An import whose export landed but lost its reply is finished by a
 *   retry, and repeats create nothing
 *
 * See also:
 * - `packages/folder/src/tauri-directory.test.ts` for the granted opener
 * - `packages/folder/src/directory-folder.test.ts` for the directory engine
 * - `departure.test.ts` for the departure wire
 */
import '../svelte-modules.test-support.js';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	mock,
	test,
} from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import {
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	HOST_STOPPED_EVENT,
} from '@epicenter/epicenter/departure';
import { expectErr, expectOk } from 'wellcrafted/testing';
import fixture from '../../../fixtures/legacy-bundle.json';
import {
	git,
	installWebLocks,
	scratch,
	shellArguments,
	shellCommand,
} from './granted-directory.test-support.js';
import { CAPTURE_FOLDER_ID } from './types.js';

const PLUGIN = 'plugin:epicenter-folder|';

type Call = { cmd: string; args: Record<string, unknown> };
let inShell = true;
let calls: Call[] = [];
/** The directory the shell grants, new for each test. */
let root = '';
/** Replaces the shell's answer to `grant_directory`. Throw to refuse. */
let grant: (() => unknown) | undefined;
/** Runs before the shell answers a command; throw to fail it unanswered. */
let before: Record<string, (call: Call) => Promise<void> | void> = {};
/** This window's focus listeners, kept beside its events. */
const FOCUS = 'focus-changed';
/** Events heard through this window only, by event name. */
const windowListeners = new Map<string, Set<() => void>>();

/** The departure status the host reports; this file only reads it. */
const IDLE = { version: 1, generation: 1, phase: 'idle' };

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(
		name: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) {
		const args = shellArguments(body, options);
		const call = { cmd: name.replace(PLUGIN, ''), args };
		calls.push(call);
		if (name === DEPARTURE_STATUS_COMMAND) return IDLE;
		await before[call.cmd]?.(call);
		if (call.cmd === 'grant_directory')
			return grant
				? grant()
				: {
						root,
						branch: 'main',
						authorName: 'Capture',
						authorEmail: 'capture@localhost',
					};
		const answered = await shellCommand(root, call.cmd, args);
		if (answered === undefined)
			throw new Error(`the scripted shell has no ${call.cmd}`);
		return answered.reply;
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

const { openCaptureHost, openDeparture } = await import(
	'./folder.epicenter-host.js'
);
const { createCaptures } = await import('../captures.svelte.ts');
const { cached, createQueryClient, observe, quiet } = await import(
	'../query.test-support.js'
);
type WriteFailure = import('../captures.svelte.js').WriteFailure;

const text = (path: string) => readFile(join(root, path), 'utf8');
/** Another program writes the file. */
async function put(path: string, source: string) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), source);
}

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
	const failures: WriteFailure[] = [];
	const captures = createCaptures(host, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
	});
	observe(captures);
	await quiet(captures);
	return { host, captures, failures };
}

/** The capture at PATH, opened, and its form. */
async function openOne(
	captures: Awaited<ReturnType<typeof opened>>['captures'],
) {
	captures.open('one', 'capture');
	await quiet(captures);
	return { form: captures.formOf('one') };
}

let removeLocks: () => void;
beforeAll(() => {
	removeLocks = installWebLocks();
});
afterAll(() => removeLocks());
beforeEach(async () => {
	root = await scratch('capture-host-');
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	inShell = true;
	calls = [];
	grant = undefined;
	before = {};
	windowListeners.clear();
});

/** A Rust `Err` rejects with the error value itself, not an `Error`. */
const refuse = (error: unknown): never => {
	throw error;
};

test('outside the desktop shell, opening fails with the reason and invokes nothing', async () => {
	inShell = false;

	await expect(openCaptureHost()).rejects.toThrow('desktop app');

	expect(calls).toEqual([]);
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
		() => refuse({ name: 'Busy', root: '/Users/someone/Epicenter/capture' }),
		'/Users/someone/Epicenter/capture',
	],
	[
		// Tauri rejects an unknown or unpermitted command with a bare string.
		'a plugin the shell did not install',
		() => refuse('epicenter-folder.grant_directory not allowed'),
		'The folder could not be opened: epicenter-folder.grant_directory not allowed',
	],
	[
		'a grant that never reaches the shell',
		() => {
			throw new Error(LOST);
		},
		LOST,
	],
] as const)('%s fails the open with its reason', async (_name, refusal, reason) => {
	grant = refusal;

	await expect(openCaptureHost()).rejects.toThrow(reason);

	expect(calls.map((call) => call.cmd)).toEqual(['grant_directory']);
});

test('the page names the Capture scope and is told the directory', async () => {
	const host = await openCaptureHost();

	expect(calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: CAPTURE_FOLDER_ID },
	});
	expect(CAPTURE_FOLDER_ID).toBe('so.epicenter.capture');
	// Everything after the grant is for the granted scope.
	for (const call of calls.slice(1))
		expect(call.args.scope).toBe(CAPTURE_FOLDER_ID);
	expect(host.location).toEqual({ kind: 'directory', root });
	await host.close();
});

test('departure is heard on this window only, registered before its first status read', async () => {
	const departure = openDeparture();
	if (!departure) throw new Error('the desktop leaf has a departure gate');
	await departure.start();
	// Targeted at this window: a global listener would invoke the shell.
	expect([...windowListeners.keys()].sort()).toEqual(
		[DEPARTURE_CHANGED_EVENT, FOCUS, HOST_STOPPED_EVENT].sort(),
	);
	expect(calls.map((call) => call.cmd)).toEqual([DEPARTURE_STATUS_COMMAND]);
	expect(departure.known).toBe(true);
	expect(departure.fenced).toBe(false);

	let stopped = 0;
	departure.onHostStopped(() => stopped++);
	for (const listener of windowListeners.get(HOST_STOPPED_EVENT) ?? [])
		listener();
	expect(stopped).toBe(1);
	departure.destroy();
	expect(
		[...windowListeners.values()].reduce((count, set) => count + set.size, 0),
	).toBe(0);
});

test('a write saves the row on disk and keeps undeclared metadata', async () => {
	await put(PATH, SAVED);
	const { host, captures, failures } = await opened();
	const { form } = await openOne(captures);

	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	await quiet(captures);

	expect(failures).toEqual([]);
	expect(await text(PATH)).toBe(`${FORMATTED}- second\n`);
	await captures.close();
	await host.close();
});

test('an edit made elsewhere is a conflict: it is not overwritten, and the capture shows it', async () => {
	await put(PATH, SAVED);
	const { host, captures, failures } = await opened();
	const { form } = await openOne(captures);
	const theirs = `${SAVED}- from another window\n`;
	await put(PATH, theirs);

	form.inputText('Mine');
	await quiet(captures);
	expect(failures).toMatchObject([{ path: PATH, error: { name: 'Conflict' } }]);
	expect(failures[0]?.lost).toContain('\nMine\n');
	expect(await text(PATH)).toBe(theirs);
	expect(cached(captures, 'one').row.body).toContain('- from another window');
	await captures.close();
	await host.close();
});

test('closing waits for a save already sent and the latest edit after it', async () => {
	await put(PATH, SAVED);
	const { host, captures } = await opened();
	const { form } = await openOne(captures);
	// The first save of the capture is held just before it lands.
	const landing = Promise.withResolvers<void>();
	let held = 0;
	before.rename_folder_path = async (call) => {
		if (!String(call.args.to).endsWith(`/${PATH}`)) return;
		if (held++ === 0) await landing.promise;
	};

	form.inputText('Submitted');
	form.inputText('Typed later');
	let closed = false;
	const closing = captures
		.close()
		.then(() => host.close())
		.then(() => {
			closed = true;
		});
	await Bun.sleep(20);
	expect(held).toBe(1);
	expect(closed).toBe(false);

	landing.resolve();
	await closing;
	expect(await text(PATH)).toBe(withText('Typed later'));
});

test('Save version commits and rewrites no file', async () => {
	const { host, captures } = await opened();
	captures.inputNewCapture('Saved before history');
	expectOk(await captures.create('Saved before history'));
	await quiet(captures);
	const path = `captures/${captures.opened?.stem}.md`;
	const saved = await text(path);
	// Saving the file made no commit.
	expect(await git(root, 'status', '--porcelain', '--', path)).toBe(
		`?? ${path}`,
	);

	calls = [];
	expect(expectOk(await captures.saveVersion()).status).toBe('committed');
	// Only Git ran and files were read: none was written, moved, or removed.
	expect(
		new Set(
			calls
				.map((call) => call.cmd)
				.filter((cmd) => !cmd.startsWith('read_') && !cmd.startsWith('stat_')),
		),
	).toEqual(new Set(['run_git']));
	expect(await text(path)).toBe(saved);
	expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toContain(
		path,
	);
	expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
		'Capture <capture@localhost>',
	);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await captures.close();
	await host.close();
});

test('an import whose export landed but lost its reply is finished by a retry, and repeats create nothing', async () => {
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('the fixture is not a bundle');
	const { host, captures } = await opened();
	const exported = () =>
		readdir(join(root, 'recovery')).then(
			(names) => names.filter((name) => name.startsWith('legacy-export-')),
			() => [],
		);
	let lost = 0;
	// The export lands in the folder, and its reply never comes back.
	before.rename_folder_path = async (call) => {
		if (!String(call.args.to).includes('/recovery/legacy-export-')) return;
		await shellCommand(root, call.cmd, call.args);
		lost++;
		throw new Error(LOST);
	};

	expect(expectErr(await captures.importLegacy(read.bundle)).message).toContain(
		'Nothing was imported',
	);
	expect(lost).toBe(1);
	const exports = await exported();
	expect(exports).toHaveLength(1);
	const original = await text(`recovery/${exports[0]}`);

	delete before.rename_folder_path;
	const retry = expectOk(await captures.importLegacy(read.bundle));
	expect(retry.complete).toBe(true);
	expect(retry.documents.map((document) => document.status)).toEqual(
		Array.from({ length: 6 }, () => 'created'),
	);
	expect(await exported()).toEqual(exports);
	expect(await text(`recovery/${exports[0]}`)).toBe(original);

	const again = expectOk(await captures.importLegacy(read.bundle));
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toHaveLength(6);
	expect(await readdir(join(root, 'captures'))).toHaveLength(6);
	await captures.close();
	await host.close();
});
