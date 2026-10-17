/**
 * Which folder the desktop workspace opens, and how. The shell's `invoke` is
 * the stand-in of `granted-shell.test-support.ts` in the folder package,
 * granting a real temporary directory per test, named as the shell names
 * it: an app's own folder by the app's id, another by its own name. The
 * shell answers the window the folder it handed it (`window_folder`).
 *
 * Key behaviors:
 * - A window handed Whispering's own folder opens it with Whispering's
 *   definition
 * - A window handed another folder opens it through Whispering's
 *   definition, leaves its declaration as it was, and records under its
 *   scope
 * - A handed folder whose declaration lacks Whispering's definition is
 *   refused by name
 *
 * See also:
 * - `desktop.test.ts` for the rest of the desktop workspace
 * - `packages/folder/src/handed-folder.test.ts` for the opener's rule
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatDefinition } from '@epicenter/folder';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../packages/folder/src/granted-shell.test-support.js';
import { whisperingDefinition } from '../definition.js';
import type { LocalTranscriptionCommands } from './local-transcription.js';
import { WHISPERING_FOLDER_ID } from './types.js';

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

/** The folder the shell handed the window, which runs this app: its own by default. */
let handed = WHISPERING_FOLDER_ID;

/** The shell opens the window on `folder`, or on the app's own folder. */
function openWindow(folder: string = WHISPERING_FOLDER_ID) {
	handed = folder;
}

/**
 * The shell grants a fresh directory for `scope`, holding `files`: the
 * app's own named by its id, a data folder `data:<name>` named `<name>`.
 */
async function register(scope: string, files: Record<string, string> = {}) {
	const name = scope.startsWith('data:') ? scope.slice('data:'.length) : scope;
	const root = join(await grantedDirectory('whispering-host-'), name);
	await mkdir(root);
	for (const [path, text] of Object.entries(files)) {
		await Bun.write(join(root, path), text);
	}
	made.push(dirname(root));
	shell = createGrantedShell(root, {
		app: WHISPERING_FOLDER_ID,
		folder: handed,
	});
	return root;
}

/** The scopes this window asked the shell to grant. */
const granted = () =>
	shell.calls
		.filter(({ cmd }) => cmd === 'grant_directory')
		.map(({ args }) => args.scope);

afterEach(async () => {
	handed = WHISPERING_FOLDER_ID;
	for (const directory of made.splice(0))
		await rm(directory, { recursive: true, force: true });
});

test("a window handed Whispering's own folder opens it with its definition", async () => {
	openWindow();
	await register(WHISPERING_FOLDER_ID);

	const workspace = expectOk(await open());

	expect(granted()).toEqual([WHISPERING_FOLDER_ID]);
	expect(workspace.folderId).toBe(WHISPERING_FOLDER_ID);
	expect(workspace.folder.own).toBe(true);
	await workspace.close();
});

test('a window handed another folder opens it through the definition and keeps its declaration', async () => {
	openWindow('data:Dictation');
	// Whispering's tables, declared by the folder itself, with one more table.
	const declared = JSON.parse(formatDefinition(whisperingDefinition));
	declared.title = 'Dictation';
	declared.tables.notes = { type: 'object', properties: {} };
	const dictation = `${JSON.stringify(declared, null, '\t')}\n`;
	const root = await register('data:Dictation', {
		'epicenter.json': dictation,
	});

	const workspace = expectOk(await open());

	expect(granted()).toEqual(['data:Dictation']);
	expect(workspace.folder.own).toBe(false);
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
