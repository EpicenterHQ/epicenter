/**
 * Save, repair, and delete sequences over the production desktop opener.
 *
 * The real library and its query cache run over `@epicenter/folder/tauri`,
 * on the page's own folder engine, in a directory the shell grants
 * (`granted-folder.test-support.ts`). That is where a change can be held
 * while the person types, fail before it lands, or lose its reply after it
 * landed, and where a read can fail.
 *
 * Key behaviors:
 * - typing is written as it is typed: one write at a time and one waiting,
 *   which saves the newest input, so input superseded meanwhile is never written
 * - a write that failed, whose reply was lost, or that met another writer's
 *   change rolls back to the file and is reported with the lost text; nothing
 *   is held, and the next edit writes on top
 * - a deletion runs after the file's writes, and one whose reply was lost
 *   is reported and recreates nothing
 *
 * See also:
 * - `desktop.test.ts` for the workspace over the shell and the host
 * - `editing.test.ts` for editing over a browser folder
 */
import '../svelte-modules.test-support.js';
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import { settle, transformationEditor } from '../edits.test-support.js';
import { createQueryClient } from '../query.test-support.js';
import { deferred, openTestWorkspace } from '../workspace.test-support.js';
import {
	createGrantedShell,
	type DataChange,
	type GrantedShell,
	grantedDirectory,
} from './granted-folder.test-support.js';
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

const { openFolder } = await import('@epicenter/folder/tauri');
const { createLibrary } = await import('../library.svelte.ts');

const gitConfig = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterAll(() => {
	for (const [key, value] of Object.entries(gitConfig))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n';

/** The library over the desktop opener, in a granted directory holding `files`. */
async function open(files: Record<string, string>, path = PATH) {
	const root = await grantedDirectory();
	shell = createGrantedShell(root, WHISPERING_FOLDER_ID);
	for (const [path, text] of Object.entries(files))
		await shell.write(path, text);
	const stubs = await openTestWorkspace();
	const folder = expectOk(
		await openFolder({
			id: WHISPERING_FOLDER_ID,
			definition: whisperingDefinition,
		}),
	);
	const workspace: Workspace = {
		...stubs.workspace,
		folder,
		close: () => folder.close(),
	};
	const library = createLibrary(workspace, createQueryClient());
	cleanups.push(async () => {
		await library.close();
		await stubs.workspace.close();
		await stubs.remove();
		await rm(root, { recursive: true, force: true });
	});
	await library.start();
	await library.open(path);
	const failures: { name: string; lost: string }[] = [];
	library.onWriteFailed(({ error, lost }) =>
		failures.push({ name: error.name, lost }),
	);
	return { library, failures, session: transformationEditor(library) };
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

test('a write whose reply was lost is reported with its text, holds nothing, and the file shows what landed once it reads', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	shell.control.loseReplies = 1;
	// The engine reads the file to check it before it writes. Once the write
	// is under way, the file cannot be read back either.
	shell.control.beforeChange = async () => {
		shell.control.beforeChange = undefined;
		shell.control.failReads.add(PATH);
	};

	type(session, 'Tidy it.\n');
	await settle(library);
	expect(failures).toEqual([
		{ name: 'Unconfirmed', lost: expect.stringContaining('Tidy it.') },
	]);
	expect(await shell.text(PATH)).toContain('Tidy it.');

	shell.control.failReads.delete(PATH);
	await library.check();
	await settle(library);
	expect(session.draft.body).toBe('Tidy it.\n');
});

test('typing during a write is shown at once and written after it; input superseded meanwhile is never written', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	const first = holdNext('write');

	type(session, 'First.\n');
	await first.reached;
	expect(library.isSaving(PATH)).toBe(true);
	type(session, 'Second.\n');
	type(session, 'Third.\n');
	expect(session.draft.body).toBe('Third.\n');
	first.release();
	await settle(library);

	expect(failures).toEqual([]);
	expect(shell.kinds).toEqual(['write', 'write']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Third.\n');
	expect(await shell.text(PATH)).toContain('Third.\n');
});

test('a refused write rolls back and is reported; the next edit writes', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	shell.control.refuseNext = 1;

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toEqual([
		{ name: expect.any(String), lost: expect.stringContaining('Mine.') },
	]);
	expect(session.draft.body).toBe('Tidy.\n');
	expect(await shell.text(PATH)).toBe(SEED);

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toHaveLength(1);
	expect(await shell.text(PATH)).toContain('Mine.\n');
});

test('another writer’s change merges with the typing: where both changed, the typing wins', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	await shell.write(PATH, SEED.replace('Tidy.', 'Theirs.'));

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toEqual([]);
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

	expect(await library.remove(deletion)).toBeUndefined();
	expect(shell.kinds).toEqual(['write', 'remove']);
	expect(await shell.text(PATH)).toBeUndefined();
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.locked(session.path)).toBe(false);
});

test('a deletion whose reply was lost is reported and recreates nothing', async () => {
	const { library } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	shell.control.loseReplies = 1;

	expect(await library.remove(deletion)).toContain(
		'the reply never reached the window',
	);
	expect(await shell.text(PATH)).toBeUndefined();
	expect(shell.kinds).toEqual(['remove']);
});
