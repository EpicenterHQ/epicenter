/**
 * Epicenter Host Leaf Tests
 *
 * Which folder the installed leaf opens, and how. The shell's openers are
 * stood in for by the directory openers of `@epicenter/folder/bun` over real
 * temporary directories, one per scope, so the lens check and what opening
 * writes are the folder package's own. The window's URL carries the folder
 * the shell handed it, as `open_installed_app` writes it.
 *
 * Key behaviors:
 * - A window handed no folder opens Honeycrisp's own folder with Honeycrisp's
 *   definition, and sets up its missing layout
 * - A window handed Honeycrisp's own folder opens it the same way
 * - A window handed another folder opens it through Honeycrisp's shape,
 *   reads its notes, and writes nothing: its declaration stays, and no
 *   layout or settings are added
 * - A handed folder whose declaration lacks Honeycrisp's shape is refused by
 *   name
 * - The installed leaf gives no terminal, reveal, or per-file history
 *
 * See also:
 * - `packages/folder/src/lens.test.ts` for the containment check
 * - `first-open.test.ts` for setting up Honeycrisp's own folder
 */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	FolderDefinition,
	OpenDataFolderOptions,
	OpenFolderOptions,
} from '@epicenter/folder';
import * as bun from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { HONEYCRISP_FOLDER_ID, type NotesHost } from './types.js';

const AUTHOR = { name: 'Honeycrisp', email: 'honeycrisp@localhost' };

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

const { openNotes } = await import('./notes-host.epicenter-host.js');

/** Open the window as the shell does, handed `folder` in `?folder=`, or none. */
function openWindow(folder?: string) {
	const url = new URL(`http://127.0.0.1/apps/${HONEYCRISP_FOLDER_ID}/`);
	if (folder !== undefined) url.searchParams.set('folder', folder);
	Object.defineProperty(globalThis, 'location', {
		value: url,
		configurable: true,
	});
}

/** Register a fresh directory under `scope`, holding `files`. */
async function register(scope: string, files: Record<string, string> = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'honeycrisp-host-')),
	);
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(root, path), text);
	}
	roots[scope] = root;
	return root;
}

/** Open the notes host and keep it, closing it once the test has looked. */
function openHost(): Promise<NotesHost> {
	return openNotes({ create: async (host) => host });
}

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

test("a window handed no folder opens Honeycrisp's own with its definition and sets it up", async () => {
	openWindow();
	const root = await register(HONEYCRISP_FOLDER_ID);

	const host = await openHost();

	expect(opened).toEqual([{ opener: 'openFolder', id: HONEYCRISP_FOLDER_ID }]);
	expect(host.location).toBe(root);
	expect((await readdir(root)).sort()).toEqual([
		'.git',
		'epicenter.json',
		'folders',
		'kv.json',
		'notes',
	]);
	await host.close();
});

test("a window handed Honeycrisp's own folder opens it the same way", async () => {
	openWindow(HONEYCRISP_FOLDER_ID);
	await register(HONEYCRISP_FOLDER_ID);

	const host = await openHost();

	expect(opened).toEqual([{ opener: 'openFolder', id: HONEYCRISP_FOLDER_ID }]);
	await host.close();
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

	const host = await openHost();

	expect(opened).toEqual([{ opener: 'openDataFolder', id: 'data:Journal' }]);
	expect(host.location).toBe(root);
	const rows = expectOk(await host.folder.tables.notes.list());
	expect(rows.map(({ result }) => result.data?.row.fields.title)).toEqual([
		'Monday',
	]);
	// Its own declaration stays, and setup made no `folders/` or `kv.json`.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(journal);
	expect((await readdir(root)).sort()).toEqual(['epicenter.json', 'notes']);
	await host.close();
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

	await expect(openHost()).rejects.toThrow(
		"Honeycrisp cannot open the folder 'Recipes': ",
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
});

test('the installed window has no terminal, reveal, or per-file history', async () => {
	openWindow();
	await register(HONEYCRISP_FOLDER_ID);

	const host = await openHost();

	expect(host.terminal).toBeUndefined();
	expect(host.reveal).toBeUndefined();
	expect(host.history).toBeUndefined();
	await host.close();
});
