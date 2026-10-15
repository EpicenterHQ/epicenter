/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` page engine and
 * the real Capture store, on a real directory with the system `git`. The
 * shell's `invoke` is scripted: `grant_directory` grants a fresh temporary
 * directory, and the commands that follow a grant act on it (see
 * `granted-directory.test-support.ts`).
 *
 * Key behaviors:
 * - Outside the shell, opening fails and invokes nothing
 * - A refused grant (an unregistered scope, a refused window, a folder
 *   another Epicenter holds, a missing plugin, a call that never reaches the
 *   shell) fails the open with its reason
 * - The page names the Capture scope and is told the directory
 * - A save writes the row and keeps undeclared metadata
 * - An edit made elsewhere merges with this one: both survive
 * - Closing waits for a save already sent and the latest edit after it
 * - Save version commits and rewrites no file
 *
 * See also:
 * - `packages/folder/src/tauri-directory.test.ts` for the granted opener
 * - `packages/folder/src/directory-folder.test.ts` for the directory engine
 */
import '../svelte-modules.test-support.js';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	git,
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

const { openCaptureHost } = await import('./folder.epicenter-host.js');
const { createCaptures } = await import('../captures.svelte.ts');
const { createQueryClient, observe, quiet } = await import(
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

beforeEach(async () => {
	root = await scratch('capture-host-');
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	inShell = true;
	calls = [];
	grant = undefined;
	before = {};
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

test('an edit made elsewhere merges with this one: both survive', async () => {
	await put(PATH, SAVED);
	const { host, captures, failures } = await opened();
	const { form } = await openOne(captures);
	const theirs = `${SAVED}- from another window\n`;
	await put(PATH, theirs);

	form.inputText('Mine');
	await quiet(captures);
	expect(failures).toEqual([]);
	// The edit changed the text; the other window added a thought.
	expect(await text(PATH)).toContain('\nMine\n');
	expect(await text(PATH)).toContain('- from another window');
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
	// Saving the file made no commit, and no repository: the first commit
	// creates it.
	expect(await Bun.file(join(root, '.git/HEAD')).exists()).toBe(false);

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
