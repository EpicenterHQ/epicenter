/**
 * Save, repair, and delete sequences over the production desktop adapter.
 *
 * The real library and its edit sessions run over `@epicenter/folder/tauri`,
 * with the shell's owner scripted in memory (`scripted-owner.test-support.ts`).
 * That is where a write can be held while the person types, refused before it
 * lands, or have its reply lost after it landed, and where a read can fail.
 *
 * Key behaviors:
 * - typing is saved as it is typed: one write at a time, and the latest
 *   input behind it, so input superseded while a write runs is never written
 * - a save that failed, or whose reply was lost, stays on screen and holds the
 *   close while unresolved; Save again writes the current draft
 * - another writer's change to the same part is a review that writes
 *   nothing, and Saved elsewhere takes it
 * - a deletion waits for the open draft's saves, and one whose reply was lost
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
import { allFrom, transformationSession } from '../drafts.test-support.js';
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
	const library = createLibrary(workspace);
	cleanups.push(async () => {
		await library.close();
		await stubs.workspace.close();
		await stubs.remove();
	});
	await library.start();
	await library.open(path);
	return { library, session: transformationSession(library) };
}

/** Type a new body into the open transformation. */
const type = (
	session: ReturnType<typeof transformationSession>,
	body: string,
) =>
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

test('a save whose reply was lost and cannot be read back stays unknown, holds the close, and Save again writes the draft', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	owner.control.loseReplies = 1;
	owner.control.failReads.add(PATH);

	type(session, 'Tidy it.\n');
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Unconfirmed');
	expect(owner.text(PATH)).toContain('Tidy it.');
	expect(library.unsavedWork).toEqual([
		`${PATH} has edits whose last save was not confirmed.`,
	]);
	expect(await library.prepareToLeave()).toBe(false);

	owner.control.failReads.delete(PATH);
	session.retry();
	expect((await session.settled()).status).not.toBe('saving');
	expect(owner.text(PATH)).toContain('Tidy it.');
});

test('typing during a save is shown at once and saved after it; input superseded meanwhile is never written', async () => {
	const { session } = await open({ [PATH]: SEED });
	const first = holdNextApply('replace');

	type(session, 'First.\n');
	await first.reached;
	expect(session.state.status).toBe('saving');
	type(session, 'Second.\n');
	type(session, 'Third.\n');
	expect(session.draft.body).toBe('Third.\n');
	first.release();
	expect((await session.settled()).status).toBe('saved');

	expect(kinds()).toEqual(['replace', 'replace']);
	expect(written(0)).toContain('First.\n');
	expect(written(1)).toContain('Third.\n');
	expect(owner.text(PATH)).toContain('Third.\n');
});

test('a refused save keeps the draft on screen; Try again saves it', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	owner.control.refuseNext = 1;

	type(session, 'Mine.\n');
	expect((await session.settled()).status).toBe('error');
	expect(session.draft.body).toBe('Mine.\n');
	expect(owner.text(PATH)).toBe(SEED);
	expect(library.saveProblems).toBe(1);

	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(owner.text(PATH)).toContain('Mine.\n');
});

test('another writer’s change to the same body is a review, and Saved elsewhere takes it without writing', async () => {
	const { library, session } = await open({ [PATH]: SEED });
	const theirs = SEED.replace('Tidy.', 'Theirs.');
	owner.write(PATH, theirs);

	type(session, 'Mine.\n');
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(session.review?.conflicts.map((conflict) => conflict.kind)).toEqual([
		'body',
	]);
	expect(changes()).toEqual([]);

	expect(
		await library.resolveReview(session, allFrom(session, 'incoming')),
	).toBeUndefined();
	expect(session.draft.body).toBe('Theirs.\n');
	expect(changes()).toEqual([]);
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
	expect(session.locked).toBe(true);
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
