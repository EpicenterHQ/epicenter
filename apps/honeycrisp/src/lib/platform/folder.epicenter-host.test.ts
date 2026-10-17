/**
 * Epicenter Host Leaf Tests
 *
 * Which folder the installed leaf opens, and how. The shell's `invoke` is
 * the stand-in of `granted-shell.test-support.ts` in the folder package,
 * granting a real temporary directory per test, named as the shell names
 * it: an app's own folder by the app's id, another by its own name. The
 * window's URL carries the folder the shell handed it, as
 * `open_installed_app` writes it.
 *
 * Key behaviors:
 * - A window handed no folder opens Honeycrisp's own folder with Honeycrisp's
 *   definition, and sets up its missing layout
 * - A window handed Honeycrisp's own folder opens it the same way
 * - A window handed another folder opens it through Honeycrisp's
 *   definition, reads its notes, and writes nothing: its declaration stays,
 *   and no layout or settings are added
 * - A handed folder whose declaration lacks Honeycrisp's definition is
 *   refused by name
 *
 * See also:
 * - `packages/folder/src/handed-folder.test.ts` for the opener's rule
 * - `first-open.test.ts` for setting up Honeycrisp's own folder
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../packages/folder/src/granted-shell.test-support.js';
import { HONEYCRISP_FOLDER_ID } from './types.js';

/** The shell; each test grants it the directory it opens (`register`). */
let shell: GrantedShell = createGrantedShell('');
/** The directories the tests made. */
const made: string[] = [];

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));

// The shell's watcher of the granted directory, which these tests never fire.
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));

const { openNotesFolder } = await import('./folder.epicenter-host.js');

/** Open the window as the shell does, handed `folder` in `?folder=`, or none. */
function openWindow(folder?: string) {
	const url = new URL(
		`epicenter-app://localhost/apps/${HONEYCRISP_FOLDER_ID}/`,
	);
	if (folder !== undefined) url.searchParams.set('folder', folder);
	Object.defineProperty(globalThis, 'location', {
		value: url,
		configurable: true,
	});
}

/**
 * The shell grants a fresh directory for `scope`, holding `files`: the
 * app's own named by its id, a data folder `data:<name>` named `<name>`.
 */
async function register(scope: string, files: Record<string, string> = {}) {
	const name = scope.startsWith('data:') ? scope.slice('data:'.length) : scope;
	const root = join(await grantedDirectory('honeycrisp-host-'), name);
	await mkdir(root);
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(root, path), text);
	}
	made.push(dirname(root));
	shell = createGrantedShell(root);
	return root;
}

/** The scopes this window asked the shell to grant. */
const granted = () =>
	shell.calls
		.filter(({ cmd }) => cmd === 'grant_directory')
		.map(({ args }) => args.scope);

const STRING = { type: 'string', 'x-field': { kind: 'string' } };
const BOOLEAN = { type: 'boolean', 'x-field': { kind: 'boolean' } };
const NULLABLE_STRING = { anyOf: [STRING, { type: 'null' }] };
const INSTANT = {
	type: 'string',
	format: 'date-time',
	pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
	'x-field': { kind: 'instant' },
};
/** A folder's `epicenter.json` with `tables`, as Epicenter writes one. */
const declaration = (title: string, tables: Record<string, unknown>) =>
	`${JSON.stringify({ title, tables }, null, '\t')}\n`;

afterEach(async () => {
	Reflect.deleteProperty(globalThis, 'location');
	for (const directory of made.splice(0))
		await rm(directory, { recursive: true, force: true });
});

test("a window handed no folder opens Honeycrisp's own with its definition and sets it up", async () => {
	openWindow();
	const root = await register(HONEYCRISP_FOLDER_ID);

	const folder = await openNotesFolder();

	expect(granted()).toEqual([HONEYCRISP_FOLDER_ID]);
	expect(folder.own).toBe(true);
	expect(folder.location).toEqual({ kind: 'directory', root });
	expect((await readdir(root)).sort()).toEqual([
		'.git',
		'epicenter.json',
		'folders',
		'notes',
	]);
	await folder.close();
});

test("a window handed Honeycrisp's own folder opens it the same way", async () => {
	openWindow(HONEYCRISP_FOLDER_ID);
	await register(HONEYCRISP_FOLDER_ID);

	const folder = await openNotesFolder();

	expect(granted()).toEqual([HONEYCRISP_FOLDER_ID]);
	expect(folder.own).toBe(true);
	await folder.close();
});

test('a window handed another folder reads its notes and writes nothing to it', async () => {
	openWindow('data:Journal');
	const journal = declaration('Journal', {
		notes: {
			type: 'object',
			properties: {
				folderId: NULLABLE_STRING,
				title: STRING,
				pinned: BOOLEAN,
				createdAt: INSTANT,
				updatedAt: INSTANT,
				deletedAt: { anyOf: [INSTANT, { type: 'null' }] },
				mood: STRING,
			},
			required: [
				'folderId',
				'title',
				'pinned',
				'createdAt',
				'updatedAt',
				'deletedAt',
				'mood',
			],
		},
		folders: {
			type: 'object',
			properties: { name: STRING, icon: NULLABLE_STRING },
			required: ['name', 'icon'],
		},
	});
	const root = await register('data:Journal', {
		'epicenter.json': journal,
		'notes/monday.md': [
			'---',
			'folderId: null',
			'title: Monday',
			'pinned: false',
			'createdAt: 2026-10-12T09:00:00.000Z',
			'updatedAt: 2026-10-12T09:00:00.000Z',
			'deletedAt: null',
			'mood: calm',
			'---',
			'',
			'Rain.',
			'',
		].join('\n'),
	});

	const folder = await openNotesFolder();

	expect(granted()).toEqual(['data:Journal']);
	expect(folder.id).toBe('data:Journal');
	expect(folder.own).toBe(false);
	expect(folder.location).toEqual({ kind: 'directory', root });
	const rows = expectOk(await folder.tables.notes.list());
	expect(rows.map(({ result }) => result.data?.row.fields.title)).toEqual([
		'Monday',
	]);
	// Its own declaration stays, and setup made no `folders/`.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(journal);
	expect((await readdir(root)).sort()).toEqual(['epicenter.json', 'notes']);
	await folder.close();
});

test('a handed folder without the notes Honeycrisp reads is refused by name', async () => {
	openWindow('data:Recipes');
	const recipes = declaration('Recipes', {
		recipes: {
			type: 'object',
			properties: { title: STRING },
			required: ['title'],
		},
	});
	const root = await register('data:Recipes', { 'epicenter.json': recipes });

	await expect(openNotesFolder()).rejects.toThrow(
		"Honeycrisp cannot open the folder 'Recipes': ",
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
});
