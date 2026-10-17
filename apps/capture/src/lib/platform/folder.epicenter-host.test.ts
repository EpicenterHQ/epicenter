/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` page engine and
 * the real Capture store, on a real directory with the system `git`. The
 * shell's `invoke` is scripted: `grant_directory` grants a fresh temporary
 * directory, and the commands that follow a grant act on it (see
 * `granted-shell.test-support.ts` in the folder package).
 *
 * Key behaviors:
 * - Outside the shell, opening fails and invokes nothing
 * - A refused grant (an unregistered scope, a refused window, a folder
 *   another Epicenter holds, a missing plugin, a call that never reaches the
 *   shell) fails the open with its reason
 * - A window handed no folder names the Capture scope and is told the
 *   directory
 * - A window handed another folder opens it through Capture's shape and
 *   leaves its declaration as it was
 * - A handed folder whose declaration lacks Capture's shape is refused by name
 * - A save writes the row and keeps undeclared metadata
 * - An edit made elsewhere merges with this one: both survive
 * - Closing waits for a save already sent and the latest edit after it
 * - Save version commits and rewrites no file
 *
 * See also:
 * - `packages/folder/src/tauri-directory.test.ts` for the granted opener
 * - `packages/folder/src/directory-folder.test.ts` for the directory engine
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { git } from '../../../../../packages/folder/src/git-http.test-support.js';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../packages/folder/src/granted-shell.test-support.js';
import { CAPTURE_FOLDER_ID } from './types.js';

let inShell = true;
/** The directory the shell grants, new for each test. */
let root = '';
/** The shell granting `root`; its `calls` are every command the page sent. */
let shell: GrantedShell;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	invoke: (
		name: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(name, body, options),
}));

/** Hand the window `folder` as the shell does, in its URL's `?folder=`. */
function handWindow(folder: string) {
	Object.defineProperty(globalThis, 'location', {
		value: new URL(
			`epicenter-app://localhost/apps/so.epicenter.capture/?folder=${encodeURIComponent(folder)}`,
		),
		configurable: true,
	});
}

const { openCaptureFolder } = await import('./folder.epicenter-host.js');
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
/** SAVED as a write leaves it: the row's standard form (ADR-0576). */
const STANDARD = SAVED.replace(
	'capturedAt: 2026-10-01T10:30:00+08:00',
	'capturedAt: "2026-10-01T10:30:00+08:00"',
);
/** SAVED with its text replaced, as a body write leaves it. */
const withText = (body: string) => STANDARD.replace('\nText\n', `\n${body}\n`);
const LOST = 'the webview lost its IPC connection';

async function opened() {
	const folder = await openCaptureFolder();
	const failures: WriteFailure[] = [];
	const captures = createCaptures(folder, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
	});
	observe(captures);
	await quiet(captures);
	return { folder, captures, failures };
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
	root = await grantedDirectory('capture-host-');
	shell = createGrantedShell(root);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
	inShell = true;
	Reflect.deleteProperty(globalThis, 'location');
});

/** A Rust `Err` rejects with the error value itself, not an `Error`. */
const refuse = (error: unknown): never => {
	throw error;
};

test('outside the desktop shell, opening fails with the reason and invokes nothing', async () => {
	inShell = false;

	await expect(openCaptureFolder()).rejects.toThrow('desktop app');

	expect(shell.calls).toEqual([]);
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
	shell.control.grant = refusal;

	await expect(openCaptureFolder()).rejects.toThrow(reason);

	expect(shell.calls.map((call) => call.cmd)).toEqual(['grant_directory']);
});

test('a window handed no folder names the Capture scope and is told the directory', async () => {
	const folder = await openCaptureFolder();

	expect(shell.calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: CAPTURE_FOLDER_ID },
	});
	expect(CAPTURE_FOLDER_ID).toBe('so.epicenter.capture');
	// Everything after the grant is for the granted scope.
	for (const call of shell.calls.slice(1))
		expect(call.args.scope).toBe(CAPTURE_FOLDER_ID);
	expect(folder.location).toEqual({ kind: 'directory', root });
	await folder.close();
});

const STRING = { type: 'string', 'x-field': { kind: 'string' } };
/** A folder's `epicenter.json` with `tables`, as Epicenter writes one. */
const declaration = (title: string, tables: Record<string, unknown>) =>
	`${JSON.stringify({ title, tables }, null, '\t')}\n`;
/** A folder declaring Capture's captures table, a field more, and a table of its own. */
const NOTES = declaration('Notes', {
	captures: {
		type: 'object',
		properties: {
			capturedAt: {
				type: 'string',
				format: 'date-time',
				'x-field': { kind: 'datetime' },
			},
			source: STRING,
		},
		required: ['capturedAt'],
	},
	people: {
		type: 'object',
		properties: { name: STRING },
		required: ['name'],
	},
});

test('a window handed another folder opens it through the shape and keeps its declaration', async () => {
	handWindow('data:Notes');
	await put('epicenter.json', NOTES);
	await put(PATH, SAVED);

	const { folder, captures } = await opened();

	expect(shell.calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: 'data:Notes' },
	});
	for (const call of shell.calls.slice(1))
		expect(call.args.scope).toBe('data:Notes');
	const { form } = await openOne(captures);
	expect(form).toBeDefined();
	// The folder's own declaration stays; Capture's is never published over it.
	expect(await text('epicenter.json')).toBe(NOTES);
	await captures.close();
	await folder.close();
});

test('a handed folder without the captures Capture reads is refused by name', async () => {
	handWindow('data:Recipes');
	const recipes = declaration('Recipes', {
		recipes: {
			type: 'object',
			properties: { title: STRING },
			required: ['title'],
		},
	});
	await put('epicenter.json', recipes);

	await expect(openCaptureFolder()).rejects.toThrow(
		"Capture cannot open the folder 'Recipes': The folder declares no 'captures' table.",
	);
	expect(await text('epicenter.json')).toBe(recipes);
});

test('a write saves the row on disk and keeps undeclared metadata', async () => {
	await put(PATH, SAVED);
	const { folder, captures, failures } = await opened();
	const { form } = await openOne(captures);

	form.inputNewThought('second');
	expect(form.addThought()).toBe(true);
	await quiet(captures);

	expect(failures).toEqual([]);
	expect(await text(PATH)).toBe(`${STANDARD}- second\n`);
	await captures.close();
	await folder.close();
});

test('an edit made elsewhere merges with this one: both survive', async () => {
	await put(PATH, SAVED);
	const { folder, captures, failures } = await opened();
	const { form } = await openOne(captures);
	const theirs = `${SAVED}- from another window\n`;
	await put(PATH, theirs);

	form.inputText('Mine');
	void form.flush();
	await quiet(captures);
	expect(failures).toEqual([]);
	// The edit changed the text; the other window added a thought.
	expect(await text(PATH)).toContain('\nMine\n');
	expect(await text(PATH)).toContain('- from another window');
	await captures.close();
	await folder.close();
});

test('closing waits for a save already sent and the latest edit after it', async () => {
	await put(PATH, SAVED);
	const { folder, captures } = await opened();
	const { form } = await openOne(captures);
	// The first save of the capture is held just before it lands.
	const landing = Promise.withResolvers<void>();
	let held = 0;
	shell.control.beforeChange = async (change) => {
		if (change.kind !== 'write' || change.path !== PATH) return;
		if (held++ === 0) await landing.promise;
	};

	form.inputText('Submitted');
	form.inputText('Typed later');
	let closed = false;
	const closing = captures
		.close()
		.then(() => folder.close())
		.then(() => {
			closed = true;
		});
	// Wait for the save to reach the held rename, however long a loaded
	// machine takes, rather than a fixed pause.
	for (let waited = 0; held === 0 && waited < 2000; waited += 5)
		await Bun.sleep(5);
	expect(held).toBe(1);
	expect(closed).toBe(false);

	landing.resolve();
	await closing;
	expect(await text(PATH)).toBe(withText('Typed later'));
});

test('Save version commits and rewrites no file', async () => {
	const { folder, captures } = await opened();
	captures.inputNewCapture('Saved before history');
	expectOk(await captures.create('Saved before history'));
	await quiet(captures);
	const path = `captures/${captures.opened?.stem}.md`;
	const saved = await text(path);
	// Saving the file made no commit, and no repository: the first commit
	// creates it.
	expect(await Bun.file(join(root, '.git/HEAD')).exists()).toBe(false);

	shell.calls.length = 0;
	expect(expectOk(await captures.saveVersion()).status).toBe('committed');
	// Only the CLI's save version ran: the page wrote, moved, and removed
	// nothing.
	expect(
		new Set(
			shell.calls
				.map((call) => call.cmd)
				.filter((cmd) => !cmd.startsWith('read_') && !cmd.startsWith('stat_')),
		),
	).toEqual(new Set(['save_version']));
	expect(await text(path)).toBe(saved);
	expect(await git(root, 'show', '--format=', '--name-only', 'HEAD')).toContain(
		path,
	);
	expect(await git(root, 'log', '-1', '--format=%an <%ae>')).toBe(
		'Epicenter <epicenter@localhost>',
	);
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await captures.close();
	await folder.close();
});
