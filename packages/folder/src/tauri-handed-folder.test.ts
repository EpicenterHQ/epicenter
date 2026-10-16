/**
 * Handed Folder Tests
 *
 * Which folder an installed app's window opens, and how. The shell's openers
 * are stood in for by the directory openers of `./bun.js` over real temporary
 * directories, one per scope, so the lens check and what opening writes are
 * the folder engine's own. The window's URL carries the folder the shell
 * handed it, as `open_installed_app` writes it.
 *
 * Key behaviors:
 * - A window handed no folder opens the app's own folder with its definition
 * - A window handed the app's own folder opens it the same way
 * - A window handed another folder opens it through the app's shape, reads
 *   its rows, and leaves its declaration as it was
 * - Only the app's own folder is marked `own`
 * - A handed folder whose declaration lacks the app's shape is refused with
 *   the app's name and the folder's directory name
 *
 * See also:
 * - `lens.test.ts` for the containment check
 * - `apps/epicenter/src-tauri/src/installed_apps.rs` for the hand-off
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import * as bun from './bun.js';
import {
	defineFolder,
	defineTable,
	type FolderDefinition,
	field,
	type OpenDataFolderOptions,
	type OpenFolderOptions,
} from './contract.js';

const AUTHOR = { name: 'Todos', email: 'todos@localhost' };
const OWN_ID = 'so.epicenter.todos';

const definition = defineFolder({
	title: 'Todos',
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

type Opened = { opener: 'openFolder' | 'openDataFolder'; id: string };
let opened: Opened[] = [];
/** The directory the shell registered under each scope. */
let roots: Record<string, string> = {};

mock.module('./tauri-adapter.js', () => ({
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

const { openHandedFolder } = await import('./tauri-handed-folder.js');

function openTodos() {
	return openHandedFolder({ ownId: OWN_ID, definition, appTitle: 'Todos' });
}

/** Open the window as the shell does, handed `folder` in `?folder=`, or none. */
function openWindow(folder?: string) {
	const url = new URL(`epicenter-app://localhost/apps/${OWN_ID}/`);
	if (folder !== undefined) url.searchParams.set('folder', folder);
	Object.defineProperty(globalThis, 'location', {
		value: url,
		configurable: true,
	});
}

/** Register a fresh directory under `scope`, holding `files`. */
async function register(scope: string, files: Record<string, string> = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'handed-folder-')));
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
	`${JSON.stringify({ title, tables }, null, '\t')}\n`;

beforeEach(() => {
	opened = [];
	roots = {};
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, 'location');
	for (const root of Object.values(roots))
		await rm(root, { recursive: true, force: true });
});

test("a window handed no folder opens the app's own with its definition, as its own", async () => {
	openWindow();
	await register(OWN_ID);

	const { folder, id, own } = expectOk(await openTodos());

	expect(opened).toEqual([{ opener: 'openFolder', id: OWN_ID }]);
	expect(id).toBe(OWN_ID);
	expect(own).toBe(true);
	await folder.close();
});

test("a window handed the app's own folder opens it the same way", async () => {
	openWindow(OWN_ID);
	await register(OWN_ID);

	const { folder, own } = expectOk(await openTodos());

	expect(opened).toEqual([{ opener: 'openFolder', id: OWN_ID }]);
	expect(own).toBe(true);
	await folder.close();
});

test('a window handed another folder reads its rows and keeps its declaration', async () => {
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

	const { folder, id, own } = expectOk(await openTodos());

	expect(opened).toEqual([{ opener: 'openDataFolder', id: 'data:Groceries' }]);
	expect(id).toBe('data:Groceries');
	expect(own).toBe(false);
	const rows = expectOk(await folder.tables.todos.list());
	expect(rows.map(({ result }) => result.data?.row.fields.title)).toEqual([
		'Milk',
	]);
	// The folder's own declaration stays; the app's is never published over it.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(groceries);
	await folder.close();
});

test("a handed folder without the app's shape is refused by the app's and the folder's names", async () => {
	openWindow('data:Recipes');
	const recipes = declaration('Recipes', {
		recipes: {
			type: 'object',
			properties: { title: STRING },
			required: ['title'],
		},
	});
	const root = await register('data:Recipes', { 'epicenter.json': recipes });

	const error = expectErr(await openTodos());

	expect(error.name).toBe('ShapeMismatch');
	expect(error.message).toBe(
		"Todos cannot open the folder 'Recipes': The folder declares no 'todos' table.",
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
});
