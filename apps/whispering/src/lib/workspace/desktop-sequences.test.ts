/**
 * Save, repair, and delete sequences over the production desktop adapter.
 *
 * The real library and its query cache run over `@epicenter/folder/tauri`,
 * with the shell's owner scripted in memory (`scripted-owner.test-support.ts`).
 * That is where a write can be held while the person types, refused before it
 * lands, or have its reply lost after it landed, and where a read can fail.
 *
 * Key behaviors:
 * - typing is written as it is typed: one write at a time and one waiting,
 *   which saves the newest input, so input superseded meanwhile is never written
 * - a write that was refused, whose reply was lost, or that met another
 *   writer's change rolls back to the file and is reported with the lost
 *   text; nothing is held, and the next edit writes on top
 * - a deletion runs after the file's writes, and one whose reply was lost
 *   recreates nothing
 *
 * See also:
 * - `desktop.test.ts` for the workspace over scripted shell replies
 * - `editing.test.ts` for editing over a browser folder
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import { settle, transformationEditor } from '../edits.test-support.js';
import { createQueryClient } from '../query.test-support.js';
import { deferred, openTestWorkspace } from '../workspace.test-support.js';
import { createScriptedOwner } from './scripted-owner.test-support.js';
import { WHISPERING_FOLDER_ID, type Workspace } from './types.js';

let owner = createScriptedOwner();
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (cmd: string, args?: Record<string, unknown>) =>
		owner.invoke(cmd, args),
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: () => owner.listen(),
}));

const { openFolder } = await import('@epicenter/folder/tauri');
const { createLibrary } = await import('../library.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATH = 'transformations/clean.md';
const SEED = '---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n';

/** The library over the desktop adapter, with the owner holding `files`. */
async function open(files: Record<string, string>, path = PATH) {
	owner = createScriptedOwner();
	for (const [path, text] of Object.entries(files)) owner.write(path, text);
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

/** The changes the owner applied to the data; opening publishes `epicenter.json` first. */
const changes = () =>
	owner.applied.filter(
		(change) => !('path' in change) || change.path !== 'epicenter.json',
	);
const kinds = () => changes().map((change) => change.kind);

/** The text of the `index`th change the owner applied. */
function written(index: number): string | undefined {
	const change = changes()[index];
	return change !== undefined && 'bytes' in change
		? new TextDecoder().decode(Uint8Array.from(change.bytes))
		: undefined;
}

/** Hold the owner's next change of `kind` until `release`; `reached` when it arrives. */
function holdNextApply(kind: string) {
	const reached = deferred<void>();
	const held = deferred<void>();
	owner.control.beforeApply = async (change) => {
		if (change.kind !== kind) return;
		owner.control.beforeApply = undefined;
		reached.resolve();
		await held.promise;
	};
	return { reached: reached.promise, release: () => held.resolve() };
}

test('a write whose reply was lost is reported with its text, holds nothing, and the file shows what landed once it reads', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;
	owner.control.failReads.add(PATH);

	type(session, 'Tidy it.\n');
	await settle(library);
	expect(failures).toEqual([
		{ name: 'Unconfirmed', lost: expect.stringContaining('Tidy it.') },
	]);
	expect(owner.text(PATH)).toContain('Tidy it.');
	expect(library.unsavedWork).toEqual([]);
	expect(await library.prepareToLeave()).toBe(true);

	owner.control.failReads.delete(PATH);
	await settle(library);
	expect(session.draft.body).toBe('Tidy it.\n');
});

test('typing during a write is shown at once and written after it; input superseded meanwhile is never written', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	const first = holdNextApply('replace');

	type(session, 'First.\n');
	await first.reached;
	expect(library.isSaving(PATH)).toBe(true);
	type(session, 'Second.\n');
	type(session, 'Third.\n');
	expect(session.draft.body).toBe('Third.\n');
	first.release();
	await settle(library);

	expect(failures).toEqual([]);
	expect(kinds()).toEqual(['replace', 'replace']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Third.\n');
	expect(owner.text(PATH)).toContain('Third.\n');
});

test('a refused write rolls back and is reported; the next edit writes', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	owner.control.refuseNext = 1;

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toEqual([
		{ name: expect.any(String), lost: expect.stringContaining('Mine.') },
	]);
	expect(session.draft.body).toBe('Tidy.\n');
	expect(owner.text(PATH)).toBe(SEED);

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toHaveLength(1);
	expect(owner.text(PATH)).toContain('Mine.\n');
});

test('another writer’s change is never written over: the write fails, writes nothing, and the cache shows theirs', async () => {
	const { library, failures, session } = await open({ [PATH]: SEED });
	const theirs = SEED.replace('Tidy.', 'Theirs.');
	owner.write(PATH, theirs);

	type(session, 'Mine.\n');
	await settle(library);
	expect(failures).toEqual([
		{ name: 'Conflict', lost: expect.stringContaining('Mine.') },
	]);
	expect(changes()).toEqual([]);
	expect(session.draft.body).toBe('Theirs.\n');
});

test('a deletion waits for the save of the row, then removes what it saved', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	const save = holdNextApply('replace');
	type(session, 'Saved first.\n');
	await save.reached;

	const capturing = library.deletionFor(PATH);
	save.release();
	const deletion = expectOk(await capturing);

	expect(await library.remove(deletion)).toBeUndefined();
	expect(kinds()).toEqual(['replace', 'remove']);
	expect(owner.text(PATH)).toBeUndefined();
	expect(library.selectedTransformation).toBeUndefined();
	expect(library.locked(session.path)).toBe(false);
});

test('a deletion whose reply was lost says so and recreates nothing', async () => {
	const { library } = await open({ [PATH]: SEED });
	const deletion = expectOk(await library.deletionFor(PATH));
	owner.control.loseReplies = 1;

	expect(await library.remove(deletion)).toContain(
		'may or may not have happened',
	);
	expect(owner.text(PATH)).toBeUndefined();
	expect(kinds()).toEqual(['remove']);
	expect(await library.prepareToLeave()).toBe(true);
});
