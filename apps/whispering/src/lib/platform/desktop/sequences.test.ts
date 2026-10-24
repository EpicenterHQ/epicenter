/**
 * Save, repair, and delete sequences over the desktop opener.
 *
 * The real whispering and its local folder context run over the native
 * `Folder` the desktop page opens (`openTauriFolder`, reached by its module
 * until a public entry exports it), in a directory the shell grants
 * (`granted-shell.test-support.ts` in the folder package). That is where a
 * change can be held while the person types, fail before it lands, or lose
 * its reply after it landed, and where a read can fail.
 *
 * Key behaviors:
 * - each explicit save captures the current text and publishes in order,
 *   including saves requested while an earlier publication is running
 * - failed publications retain input; new input can publish over an
 *   unconfirmed or outside publication
 * - deletion runs after earlier admitted saves and a lost reply is recovered
 *   by reading back the removal without recreating it
 *
 * See also:
 * - `services.test.ts` for the services over the shell and the host
 * - `../../editing.test.ts` for editing over a directory this process opens
 */
import {
	closeTestWhispering,
	createTestWhispering,
} from '../../whispering.test-support.js';

import '../../../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { expectOk } from 'wellcrafted/testing';
import {
	createGrantedShell,
	type DataChange,
	type GrantedShell,
	grantedDirectory,
} from '../../../../../../packages/folder/src/granted-shell.test-support.js';
import { whisperingTables } from '../../definition.js';
import { settle, transformationEditor } from '../../edits.test-support.js';

import { deferred, openTestServices } from '../../services.test-support.js';
import type { WhisperingServices } from '../types.js';

let shell: GrantedShell;
mock.module('@tauri-apps/api/core', () => ({
	SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
	transformCallback: () => 0,
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
}));
// The shell's watcher: these tests change the directory only through the page.
mock.module('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ listen: async () => () => {} }),
}));

const { openTauriFolder } = await import(
	'../../../../../../packages/folder/src/native/tauri.js'
);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n';

/** Whispering over the desktop opener, in a granted directory holding `files`. */
async function open(files: Record<string, string>, path = PATH) {
	const root = await grantedDirectory();
	shell = createGrantedShell(root);
	for (const [path, text] of Object.entries(files))
		await shell.write(path, text);
	const stubs = await openTestServices();
	const folder = expectOk(await openTauriFolder({ tables: whisperingTables }));
	const services: WhisperingServices = {
		...stubs.services,
	};
	const { whispering, context } = await createTestWhispering({
		services,
		folder,
	});
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await stubs.folder.close();
		await stubs.remove();
		await rm(root, { recursive: true, force: true });
	});
	await whispering.start();
	// The sequence below starts after app initialization has saved its exclusions.
	shell.changes.length = 0;
	whispering.open(path);
	return {
		whispering,
		context,
		session: await transformationEditor(whispering, context),
	};
}

/** Type a new body into the open transformation. */
const type = (
	session: Awaited<ReturnType<typeof transformationEditor>>,
	body: string,
) =>
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

test('new typing after an unconfirmed save publishes the newer source', async () => {
	const { context, whispering, session } = await open({ [PATH]: SEED });
	shell.control.loseReplies = 1;
	// The engine reads the file to check it before it writes. Once the write
	// is under way, the file cannot be read back either.
	shell.control.beforeChange = async () => {
		shell.control.beforeChange = undefined;
		shell.control.failReads.add(PATH);
	};

	type(session, 'Tidy it.\n');
	await settle(whispering, context);
	expect(whispering.isUnsaved(PATH)).toBe(true);
	expect(whispering.unsaved).toBe(true);
	expect(await shell.text(PATH)).toContain('Tidy it.');

	shell.control.failReads.delete(PATH);
	await settle(whispering, context);
	type(session, 'Tidy it all.\n');
	await settle(whispering, context);
	expect(whispering.unsaved).toBe(false);
	expect(await shell.text(PATH)).toContain('Tidy it all.\n');
});

test('typing during a save is shown at once and each explicit save publishes its captured source', async () => {
	const { context, whispering, session } = await open({ [PATH]: SEED });
	const first = holdNext('write');

	type(session, 'First.\n');
	await first.reached;
	expect(whispering.isSaving(PATH)).toBe(true);
	type(session, 'Second.\n');
	type(session, 'Third.\n');
	expect(session.draft.body).toBe('Third.\n');
	first.release();
	await settle(whispering, context);

	expect(whispering.unsaved).toBe(false);
	expect(shell.kinds).toEqual(['write', 'write', 'write']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Second.\n');
	expect(written(2)).toContain('Third.\n');
	expect(await shell.text(PATH)).toContain('Third.\n');
});

test('a refused save keeps the typing as not saved; the next edit saves it', async () => {
	const { context, whispering, session } = await open({ [PATH]: SEED });
	shell.control.refuseNext = 1;

	type(session, 'Mine.\n');
	await settle(whispering, context);
	expect(whispering.isUnsaved(PATH)).toBe(true);
	expect(session.draft.body).toBe('Mine.\n');
	expect(await shell.text(PATH)).toBe(SEED);

	type(session, 'Mine, again.\n');
	await settle(whispering, context);
	expect(whispering.unsaved).toBe(false);
	expect(await shell.text(PATH)).toContain('Mine, again.\n');
});

test('new local input publishes over another writer’s source', async () => {
	const { context, whispering, session } = await open({ [PATH]: SEED });
	await shell.write(PATH, SEED.replace('Tidy.', 'Theirs.'));

	type(session, 'Mine.\n');
	await settle(whispering, context);
	expect(whispering.unsaved).toBe(false);
	expect(await shell.text(PATH)).toContain('Mine.\n');
	expect(await shell.text(PATH)).not.toContain('Theirs.');
});

test('a deletion waits for the save of the row, then removes what it saved', async () => {
	const { context, whispering, session } = await open({ [PATH]: SEED });
	const save = holdNext('write');
	type(session, 'Saved first.\n');
	await save.reached;

	const capturing = whispering.deletionFor(PATH);
	save.release();
	const deletion = expectOk(await capturing);

	expect(await whispering.delete(deletion)).toBeUndefined();
	expect(shell.kinds).toEqual(['write', 'remove']);
	expect(await shell.text(PATH)).toBeUndefined();
	await settle(whispering, context);
	expect(whispering.selectedTransformation).toBeUndefined();
});

test('a deletion whose reply was lost is confirmed by reading back, and recreates nothing', async () => {
	const { whispering } = await open({ [PATH]: SEED });
	const deletion = expectOk(await whispering.deletionFor(PATH));
	shell.control.loseReplies = 1;

	// The file is gone, so the removal landed after all.
	expect(await whispering.delete(deletion)).toBeUndefined();
	expect(await shell.text(PATH)).toBeUndefined();
	expect(shell.kinds).toEqual(['remove']);
});
