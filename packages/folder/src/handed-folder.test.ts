/**
 * Handed Folder Tests
 *
 * Which folder the automatic `openFolder` opens in the desktop app, and how.
 * The shell opens an installed app's window on one folder and answers the
 * window which app it runs and which folder it was handed
 * (`window_folder`). The shell's commands are the stand-ins in
 * `granted-shell.test-support.ts`, over a real directory per test.
 *
 * Key behaviors:
 * - A window handed the app's own folder, named by the app's id, publishes
 *   the app's definition there
 * - A window handed another folder opens it through the app's definition:
 *   it reads its rows, writes them, and never publishes over its declaration
 * - `folder.id` is the granted scope, and `folder.own` is true only for the
 *   app's own folder
 * - A handed folder whose declaration does not contain the definition is
 *   `ShapeMismatch`, naming the app and the folder's directory, and opens
 *   nothing
 * - A folder opened by ID, with no definition, reads its own `epicenter.json`,
 *   and with one reads through it, whatever the window was handed
 * - The window's URL decides nothing: a page that navigated, or names
 *   another folder in its query, still opens the folder the shell handed it
 * - A page that names an app its window does not run is `AppMismatch`, and
 *   asks for no folder
 *
 * See also:
 * - `read-through.test.ts` for the containment check and the Bun rule
 * - `apps/epicenter/src-tauri/src/installed_apps.rs` for the hand-off
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { scratch } from './git-http.test-support.js';
import {
	createGrantedShell,
	type GrantedShell,
	type WindowFolder,
} from './granted-shell.test-support.js';

/** The shell; each test grants it the directory it opens. */
let shell: GrantedShell;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));

mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({
		listen: async () => () => {},
	}),
}));

const { openFolder, defineFolder, defineTable, field } = await import(
	'./index.js'
);

const TODOS = 'so.epicenter.todos';

const definition = defineFolder({
	title: 'Todos',
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const STRING = { type: 'string', 'x-field': { kind: 'string' } };
const BOOLEAN = { type: 'boolean', 'x-field': { kind: 'boolean' } };
/** A folder's `epicenter.json` with `tables`, as Epicenter writes one. */
const declaration = (title: string, tables: Record<string, unknown>) =>
	`${JSON.stringify({ title, tables }, null, '\t')}\n`;

/** Groceries declares Todos's table, a field more, and a table more. */
const GROCERIES = declaration('Groceries', {
	todos: {
		type: 'object',
		properties: { title: STRING, done: BOOLEAN, aisle: STRING },
		required: ['title', 'done'],
	},
	stores: {
		type: 'object',
		properties: { name: STRING },
		required: ['name'],
	},
});

/** What the shell hands the next window `grant` makes: Todos on its own folder. */
let window: WindowFolder | null = { app: TODOS, folder: TODOS };

/** The shell opened this window for Todos on `folder`, or for no app (`null`). */
function openWindow(folder: string | null) {
	window = folder === null ? null : { app: TODOS, folder };
}

/** The page's own URL, which decides nothing. */
function navigate(path: string) {
	Object.defineProperty(globalThis, 'location', {
		value: new URL(`epicenter-app://localhost/apps/${TODOS}/${path}`),
		configurable: true,
	});
}

/** The shell grants a new directory named `name`, holding `files`. */
async function grant(name: string, files: Record<string, string> = {}) {
	const root = join(await scratch('handed-folder-'), name);
	await mkdir(root);
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	}
	shell = createGrantedShell(root, window);
	return root;
}

/** The scopes this window asked the shell to grant. */
const granted = () =>
	shell.calls
		.filter(({ cmd }) => cmd === 'grant_directory')
		.map(({ args }) => args.scope);

beforeEach(() => {
	window = { app: TODOS, folder: TODOS };
	shell = createGrantedShell('');
});
afterEach(() => {
	Reflect.deleteProperty(globalThis, 'location');
});

test("a window handed the app's own folder opens it and publishes its definition there", async () => {
	openWindow(TODOS);
	const root = await grant(TODOS);

	const folder = expectOk(await openFolder({ app: TODOS, definition }));

	expect(granted()).toEqual([TODOS]);
	expect(folder.id).toBe(TODOS);
	expect(folder.own).toBe(true);
	expect(folder.definition).toBe(definition);
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	expect(
		JSON.parse(await readFile(join(root, 'epicenter.json'), 'utf8')),
	).toMatchObject({ title: 'Todos', tables: { todos: {} } });
	await folder.close();
});

test('a window handed another folder reads and writes it through the definition, and never publishes there', async () => {
	openWindow('data:Groceries');
	const root = await grant('Groceries', {
		'epicenter.json': GROCERIES,
		'todos/milk.md': '---\ntitle: Milk\ndone: false\naisle: dairy\n---\n',
	});

	const folder = expectOk(await openFolder({ app: TODOS, definition }));

	expect(granted()).toEqual(['data:Groceries']);
	expect(folder.id).toBe('data:Groceries');
	expect(folder.own).toBe(false);
	expect(Object.keys(folder.tables)).toEqual(['todos']);
	expect(Object.keys(folder.definition.tables).sort()).toEqual([
		'stores',
		'todos',
	]);
	const rows = expectOk(await folder.tables.todos.list());
	expect(rows.map(({ result }) => result.data?.row.fields.title)).toEqual([
		'Milk',
	]);
	expectOk(await folder.tables.todos.set('milk', { done: true }));
	expect(await readFile(join(root, 'todos/milk.md'), 'utf8')).toBe(
		'---\ntitle: Milk\ndone: true\naisle: dairy\n---\n',
	);
	// The folder's own declaration stays; the app's is never published over it.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(GROCERIES);
	await folder.close();
});

test("a handed folder that does not contain the definition is refused by the app's and the folder's names", async () => {
	openWindow('data:Recipes');
	const recipes = declaration('Recipes', {
		recipes: {
			type: 'object',
			properties: { title: STRING },
			required: ['title'],
		},
	});
	const root = await grant('Recipes', { 'epicenter.json': recipes });

	const refused = expectErr(await openFolder({ app: TODOS, definition }));

	expect(refused.name).toBe('ShapeMismatch');
	expect(refused.message).toBe(
		"Todos cannot open the folder 'Recipes': The folder declares no 'todos' table.",
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
	expect(existsSync(join(root, '.git'))).toBe(false);
});

test('a page that navigated, or names another folder in its URL, still opens the folder its window was handed', async () => {
	openWindow('data:Groceries');
	navigate('recordings');
	await grant('Groceries', {
		'epicenter.json': GROCERIES,
		'todos/milk.md': '---\ntitle: Milk\ndone: false\naisle: dairy\n---\n',
	});

	const reloaded = expectOk(await openFolder({ app: TODOS, definition }));
	expect(reloaded.id).toBe('data:Groceries');
	expect(reloaded.own).toBe(false);
	await reloaded.close();

	navigate(`?folder=${TODOS}`);
	const claimed = expectOk(await openFolder({ app: TODOS, definition }));
	expect(claimed.id).toBe('data:Groceries');
	expect(granted()).toEqual(['data:Groceries', 'data:Groceries']);
	await claimed.close();
});

test('a page that names an app its window does not run is refused, and asks for no folder', async () => {
	openWindow(TODOS);
	await grant('so.epicenter');

	const epicenter = defineFolder({ title: 'Epicenter', tables: {} });
	const retargeted = expectErr(
		await openFolder({ app: 'so.epicenter', definition: epicenter }),
	);
	expect(retargeted).toMatchObject({
		name: 'AppMismatch',
		app: 'so.epicenter',
		windowApp: TODOS,
	});
	expect(granted()).toEqual([]);

	openWindow(null);
	await grant('so.epicenter');
	const appless = expectErr(await openFolder({ app: TODOS, definition }));
	expect(appless).toMatchObject({ name: 'AppMismatch', windowApp: null });
	expect(granted()).toEqual([]);
});

test('a folder opened by ID with a definition reads through it, whatever the window was handed', async () => {
	openWindow(TODOS);
	const root = await grant('Groceries', {
		'epicenter.json': GROCERIES,
		'todos/milk.md': '---\ntitle: Milk\ndone: false\naisle: dairy\n---\n',
	});

	const folder = expectOk(
		await openFolder({ id: 'data:Groceries', definition }),
	);

	expect(granted()).toEqual(['data:Groceries']);
	expect(folder.own).toBe(false);
	expect(Object.keys(folder.tables)).toEqual(['todos']);
	expectOk(await folder.tables.todos.set('milk', { done: true }));
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(GROCERIES);
	await folder.close();
});

test('a folder opened by ID with no definition reads its own epicenter.json, whatever the window was handed', async () => {
	openWindow(TODOS);
	const root = await grant('Groceries', {
		'epicenter.json': GROCERIES,
		'todos/milk.md': '---\ntitle: Milk\ndone: false\naisle: dairy\n---\n',
	});

	const folder = expectOk(await openFolder({ id: 'data:Groceries' }));

	expect(granted()).toEqual(['data:Groceries']);
	expect(folder.id).toBe('data:Groceries');
	expect(folder.own).toBe(false);
	expect(folder.definition.title).toBe('Groceries');
	expect(Object.keys(folder.tables).sort()).toEqual(['stores', 'todos']);
	const { stores } = folder.tables;
	if (stores === undefined) throw new Error('Groceries declares stores');
	expectOk(
		await stores.create(
			{ fields: { name: 'Corner' }, body: '' },
			{ stem: 'corner' },
		),
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(GROCERIES);
	await folder.close();
});
