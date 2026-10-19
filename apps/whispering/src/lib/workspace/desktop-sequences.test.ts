/**
 * Save, repair, and delete sequences over the desktop opener.
 *
 * The real library and its local folder context run over the native
 * `Folder` the desktop page opens (`openTauriFolder`, reached by its module
 * until a public entry exports it), in a directory the shell grants
 * (`granted-shell.test-support.ts` in the folder package). That is where a
 * change can be held while the person types, fail before it lands, or lose
 * its reply after it landed, and where a read can fail.
 *
 * Key behaviors:
 * - typing is saved as it is typed, one save at a time; what was typed while
 *   one ran is saved next, so input superseded meanwhile is never written
 * - a save that failed or whose reply could not be confirmed keeps the
 *   typing and says it is not saved; the next edit saves it
 * - a save over another writer's change merges with it, and the typing wins
 *   where both changed
 * - a deletion waits for the save of the row, and one whose reply was lost
 *   is confirmed by reading back and recreates nothing
 *
 * See also:
 * - `desktop.test.ts` for the workspace over the shell and the host
 * - `editing.test.ts` for editing over a directory this process opens
 */
import '../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type DataChange,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../packages/folder/src/granted-shell.test-support.js';
import { whisperingTables } from '../definition.js';
import { settle, transformationEditor } from '../edits.test-support.js';
import { createTestLibrary } from '../library.test-support.js';
import { deferred, openTestWorkspace } from '../workspace.test-support.js';
import { WHISPERING_FOLDER_ID, type Workspace } from './types.js';

let shell: GrantedShell;
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));
// The shell's watcher: these tests change the directory only through the page.
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));

const { openTauriFolder } = await import(
	'../../../../../packages/folder/src/native/tauri.js'
);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n';

/** The library over the desktop opener, in a granted directory holding `files`. */
async function open(files: Record<string, string>, path = PATH) {
	const root = await grantedDirectory();
	shell = createGrantedShell(root);
	for (const [path, text] of Object.entries(files))
		await shell.write(path, text);
	const stubs = await openTestWorkspace();
	const folder = expectOk(
		await openTauriFolder({
			directory: WHISPERING_FOLDER_ID,
			tables: whisperingTables,
		}),
	);
	const workspace: Workspace = {
		...stubs.workspace,
		folder,
		close: () => folder.close(),
	};
	const library = await createTestLibrary(workspace);
	cleanups.push(async () => {
		await library.close();
		await stubs.workspace.close();
		await stubs.remove();
		await rm(root, { recursive: true, force: true });
	});
	await library.start();
	await library.open(path);
	return { library, session: transformationEditor(library) };
}

/** Type a new body into the open transformation. */
const type = (session: ReturnType<typeof transformationEditor>, body: string) =>
	session.edit((row) => {
		row.body = body;
	});

/** The text of the `index`th data file the page wrote. */
function written(index: number): string | undefined {
	const change = shell.changes[index];
	return change?.kind === 'write' ? change.text : undefined;
}

/** Hold the next data change of `kind` until `release`; `reached` when it arrives. */
function holdNext(kind: DataChange['kind']) {
	const reached = deferred<void>();
	const held = deferred<void>();
	shell.control.beforeChange = async (change) => {
		if (change.kind !== kind) return;
		shell.control.beforeChange = undefined;
		reached.resolve();
		await held.promise;
	};
	return { reached: reached.promise, release: () => held.resolve() };
}

test('a save whose reply could not be confirmed keeps the typing as not saved, and it saves again over what landed', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	shell.control.loseReplies = 1;
	// The engine reads the file to check it before it writes. Once the write
	// is under way, the file cannot be read back either.
	shell.control.beforeChange = async () => {
		shell.control.beforeChange = undefined;
		shell.control.failReads.add(PATH);
	};

	type(session, 'Tidy it.\n');
	await settle(library);
	expect(library.isUnsaved(PATH)).toBe(true);
	expect(library.unsaved).toBe(true);
	expect(await shell.text(PATH)).toContain('Tidy it.');

	shell.control.failReads.delete(PATH);
	await settle(library);
	type(session, 'Tidy it all.\n');
	await settle(library);
	// Whether the lost save landed was unknown, so the typing saves again from
	// where it started, over what did land, and wins.
	expect(library.unsaved).toBe(false);
	expect(session.draft.body).toBe('Tidy it all.\n');
	expect(await shell.text(PATH)).toContain('Tidy it all.\n');
});

test('typing during a save is shown at once and saved after it; input superseded meanwhile is never written', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	const first = holdNext('write');

	type(session, 'First.\n');
	await first.reached;
	expect(library.isSaving(PATH)).toBe(true);
	type(session, 'Second.\n');
	type(session, 'Third.\n');
	expect(session.draft.body).toBe('Third.\n');
	first.release();
	await settle(library);

	expect(library.unsaved).toBe(false);
	expect(shell.kinds).toEqual(['write', 'write']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Third.\n');
	expect(await shell.text(PATH)).toContain('Third.\n');
});

test('a refused save keeps the typing as not saved; the next edit saves it', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	shell.control.refuseNext = 1;

	type(session, 'Mine.\n');
	await settle(library);
	expect(library.isUnsaved(PATH)).toBe(true);
	expect(session.draft.body).toBe('Mine.\n');
	expect(await shell.text(PATH)).toBe(SEED);

	type(session, 'Mine, again.\n');
	await settle(library);
	expect(library.unsaved).toBe(false);
	expect(await shell.text(PATH)).toContain('Mine, again.\n');
});

test('another writer’s change merges with the typing: where both changed, the typing wins', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	await shell.write(PATH, SEED.replace('Tidy.', 'Theirs.'));

	type(session, 'Mine.\n');
	await settle(library);
	expect(library.unsaved).toBe(false);
	expect(await shell.text(PATH)).toContain('Mine.\n');
	expect(await shell.text(PATH)).not.toContain('Theirs.');
});

test('a deletion waits for the save of the row, then removes what it saved', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	const save = holdNext('write');
	type(session, 'Saved first.\n');
	await save.reached;

	const capturing = library.deletionFor(PATH);
	save.release();
	const deletion = expectOk(await capturing);

	expect(await library.delete(deletion)).toBeUndefined();
	expect(shell.kinds).toEqual(['write', 'remove']);
	expect(await shell.text(PATH)).toBeUndefined();
	await settle(library);
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.locked(session.path)).toBe(false);
});

test('a deletion whose reply was lost is confirmed by reading back, and recreates nothing', async () => {
	const { library } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	shell.control.loseReplies = 1;

	// The file is gone, so the removal landed after all.
	expect(await library.delete(deletion)).toBeUndefined();
	expect(await shell.text(PATH)).toBeUndefined();
	expect(shell.kinds).toEqual(['remove']);
});
