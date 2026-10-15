/**
 * Which folder the desktop workspace opens, and how. The shell's openers are
 * stood in for by the directory openers of `@epicenter/folder/bun` over real
 * temporary directories, one per scope, so the lens check and what opening
 * writes are the folder package's own. The window's URL carries the folder
 * the shell handed it, as `open_installed_app` writes it.
 *
 * Key behaviors:
 * - A window handed no folder, or Whispering's own, opens Whispering's own
 *   folder with Whispering's definition
 * - A window handed another folder opens it through Whispering's definition
 *   as the lens, leaves its declaration as it was, and records under its scope
 * - A handed folder whose declaration lacks Whispering's shape is refused by
 *   name
 *
 * See also:
 * - `desktop.test.ts` for the rest of the desktop workspace
 * - `packages/folder/src/lens.test.ts` for the containment check
 */
import '../svelte-modules.test-support.js';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	FolderDefinition,
	OpenDataFolderOptions,
	OpenFolderOptions,
} from '@epicenter/folder';
import { formatDeclaration } from '@epicenter/folder';
import * as bun from '@epicenter/folder/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import type { LocalTranscriptionCommands } from './local-transcription.js';
import { WHISPERING_FOLDER_ID } from './types.js';

const AUTHOR = { name: 'Whispering', email: 'whispering@localhost' };

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

const { openDesktopWorkspace } = await import('./desktop.js');

const unexpected = () => {
	throw new Error('unexpected command');
};
/** Shell commands nobody should reach: local transcription is not under test. */
const noCommands: LocalTranscriptionCommands = {
	getLocalTranscriptionReadiness: unexpected,
	listInferenceModels: unexpected,
	transcribeAudioBytes: unexpected,
	openHome: unexpected,
};

const open = () => openDesktopWorkspace({ commands: noCommands });

/** Open the window as the shell does, handed `folder` in `?folder=`, or none. */
function openWindow(folder?: string) {
	const url = new URL(`http://127.0.0.1/apps/${WHISPERING_FOLDER_ID}/`);
	if (folder !== undefined) url.searchParams.set('folder', folder);
	Object.defineProperty(globalThis, 'location', {
		value: url,
		configurable: true,
	});
}

/** Register a fresh directory under `scope`, holding `files`. */
async function register(scope: string, files: Record<string, string> = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-host-')),
	);
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(root, path), text);
	}
	roots[scope] = root;
	return root;
}

beforeEach(() => {
	opened = [];
	roots = {};
});
afterEach(async () => {
	Reflect.deleteProperty(globalThis, 'location');
	for (const root of Object.values(roots))
		await rm(root, { recursive: true, force: true });
});

test("a window handed no folder opens Whispering's own with its definition", async () => {
	openWindow();
	await register(WHISPERING_FOLDER_ID);

	const workspace = expectOk(await open());

	expect(opened).toEqual([{ opener: 'openFolder', id: WHISPERING_FOLDER_ID }]);
	expect(workspace.folderId).toBe(WHISPERING_FOLDER_ID);
	await workspace.close();
});

test("a window handed Whispering's own folder opens it the same way", async () => {
	openWindow(WHISPERING_FOLDER_ID);
	await register(WHISPERING_FOLDER_ID);

	const workspace = expectOk(await open());

	expect(opened).toEqual([{ opener: 'openFolder', id: WHISPERING_FOLDER_ID }]);
	await workspace.close();
});

test('a window handed another folder opens it through the lens and keeps its declaration', async () => {
	openWindow('data:Dictation');
	// Whispering's tables, declared by the folder itself, with one more table.
	const declared = JSON.parse(formatDeclaration(whisperingDefinition));
	declared.title = 'Dictation';
	declared.tables.notes = { type: 'object', properties: {} };
	const dictation = `${JSON.stringify(declared, null, '\t')}\n`;
	const root = await register('data:Dictation', {
		'epicenter.json': dictation,
	});

	const workspace = expectOk(await open());

	expect(opened).toEqual([{ opener: 'openDataFolder', id: 'data:Dictation' }]);
	// A recording is written under the handed folder's scope.
	expect(workspace.folderId).toBe('data:Dictation');
	expect(Object.keys(workspace.folder.definition.tables)).toContain('notes');
	// The folder's own declaration stays; Whispering's is never published over it.
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(dictation);
	await workspace.close();
});

test('a handed folder without the recordings Whispering reads is refused by name', async () => {
	openWindow('data:Recipes');
	const recipes = `${JSON.stringify(
		{
			title: 'Recipes',
			kv: { type: 'object', properties: {} },
			tables: {
				recipes: {
					type: 'object',
					properties: { title: { type: 'string' } },
					required: ['title'],
				},
			},
		},
		null,
		'\t',
	)}\n`;
	const root = await register('data:Recipes', { 'epicenter.json': recipes });

	const error = expectErr(await open());

	expect(error.name).toBe('DesktopFolder');
	expect(error.message).toStartWith(
		"Whispering cannot open the folder 'Recipes': ",
	);
	expect(error.message).toContain("The folder declares no 'recordings' table");
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(recipes);
});
