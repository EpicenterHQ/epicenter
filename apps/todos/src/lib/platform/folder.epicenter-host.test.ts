/**
 * Epicenter Host Leaf Tests
 *
 * Which folder the desktop leaf opens, and how. The shell's openers are stood
 * in for by the directory openers of `@epicenter/folder/bun` over real
 * temporary directories, one per scope, so the lens check and what opening
 * writes are the folder package's own. The window's URL carries the folder
 * the shell handed it, as `open_installed_app` writes it.
 *
 * Key behaviors:
 * - A window handed no folder opens Todos's own folder with Todos's
 *   definition
 * - A window handed Todos's own folder opens it the same way
 * - A window handed another folder opens it through Todos's shape, reads its
 *   todos, and leaves its declaration as it was
 * - Only Todos's own folder is marked `own`, which offers Connect
 * - A handed folder whose declaration lacks Todos's shape is refused by name
 *
 * See also:
 * - `packages/folder/src/lens.test.ts` for the containment check
 * - `apps/epicenter/src-tauri/src/installed_apps.rs` for the hand-off
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	FolderDefinition,
	OpenDataFolderOptions,
	OpenFolderOptions,
} from '@epicenter/folder';
import * as bun from '@epicenter/folder/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { TODOS_FOLDER_ID } from './types.js';

const AUTHOR = { name: 'Todos', email: 'todos@localhost' };

type Opened = { opener: 'openFolder' | 'openDataFolder'; id: string };
let opened: Opened[] = [];
/** The directory the shell registered under each scope. */
let roots: Record<string, string> = {};

mock.module('@epicenter/folder/tauri', () => ({
	openFolder: (options: OpenFolderOptions<FolderDefinition>) => {
		opened.push({ opener: 'openFolder', id: options.id });
		return bun.openFolder({
			root: roots[options.id] ?? '',
			definition: options.definition,
			git: { author: AUTHOR },
		});
	},
	openDataFolder: (options: OpenDataFolderOptions) => {
		opened.push({ opener: 'openDataFolder', id: options.id });
		return bun.openDataFolder({
			root: roots[options.id] ?? '',
			lens: options.lens,
			git: { author: AUTHOR },
		});
	},
}));
mock.module('../remote.js', () => ({ gitAccess: { credentials: undefined } }));

const { openTodosFolder } = await import('./folder.epicenter-host.js');

/** Open the window as the shell does, handed `folder` in `?folder=`, or none. */
function openWindow(folder?: string) {
	const url = new URL(`http://127.0.0.1/apps/${TODOS_FOLDER_ID}/`);
	if (folder !== undefined) url.searchParams.set('folder', folder);
	Object.defineProperty(globalThis, 'location', {
		value: url,
		configurable: true,
	});
}

/** Register a fresh directory under `scope`, holding `files`. */
async function register(scope: string, files: Record<string, string> = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'todos-host-')));
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(root, path), text);
	}
	roots[scope] = root;
	return root;
}

const STRING = { type: 'string', 'x-field': { kind: 'string' } };
const BOOLEAN = { type: 'boolean', 'x-field': { kind: 'boolean' } };
/** A folder's `epicenter.json` with `tables`, as Epicenter writes one. */
const declaration = (title: string, tables: Record<string, unknown>) =>
	`${JSON.stringify({ title, kv: { type: 'object', properties: {} }, tables }, null, '\t')}\n`;

beforeEach(() => {
	opened = [];
	roots = {};
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, 'location');
	for (const root of Object.values(roots))
		await rm(root, { recursive: true, force: true });
});

test("a window handed no folder opens Todos's own with Todos's definition, as its own", async () => {
	openWindow();
	await register(TODOS_FOLDER_ID);

	const { folder, own } = expectOk(await openTodosFolder());

	expect(opened).toEqual([{ opener: 'openFolder', id: TODOS_FOLDER_ID }]);
	expect(own).toBe(true);
	await folder.close();
});

test("a window handed Todos's own folder opens it the same way", async () => {
	openWindow(TODOS_FOLDER_ID);
	await register(TODOS_FOLDER_ID);

	const { folder, own } = expectOk(await openTodosFolder());

	expect(opened).toEqual([{ opener: 'openFolder', id: TODOS_FOLDER_ID }]);
	expect(own).toBe(true);
	await folder.close();
});

test('a window handed another folder reads its todos and keeps its declaration', async () => {
	openWindow('data:Groceries');
	const groceries = declaration('Groceries', {
		todos: {
			type: 'object',
			properties: { title: STRING, done: BOOLEAN, aisle: STRING },
			required: ['title', 'done', 'aisle'],
		},
		stores: {
			type: 'object',
			properties: { name: STRING },
			required: ['name'],
		},
	});
	const root = await register('data:Groceries', {
		'epicenter.json': groceries,
		'todos/milk.md': '---\ntitle: Milk\ndone: false\naisle: dairy\n---\n',
	});

	const { folder, own } = expectOk(await openTodosFolder());

	expect(opened).toEqual([{ opener: 'openDataFolder', id: 'data:Groceries' }]);
	// Connect would give this folder Todos's own repository, so it offers none.
	expect(own).toBe(false);
	const rows = expectOk(await folder.tables.todos.list());
	expect(rows.map(({ result }) => result.data?.row.fields.title)).toEqual([
		'Milk',
	]);
	// The folder's own declaration stays; Todos's is never published over it.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(groceries);
	await folder.close();
});

test('a handed folder without the todos Todos reads is refused by name', async () => {
	openWindow('data:Recipes');
	const recipes = declaration('Recipes', {
		recipes: {
			type: 'object',
			properties: { title: STRING },
			required: ['title'],
		},
	});
	const root = await register('data:Recipes', { 'epicenter.json': recipes });

	const error = expectErr(await openTodosFolder());

	expect(error.name).toBe('ShapeMismatch');
	expect(error.message).toBe(
		"Todos cannot open the folder 'Recipes': The folder declares no 'todos' table.",
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
});
