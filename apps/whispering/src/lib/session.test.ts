/**
 * Session Lifetime Tests
 *
 * Drives session startup, navigation policy, and release over a real folder.
 * These tests do not mount routes; layout ownership is checked separately in
 * `page-boundary.test.ts`. Write details belong to library tests.
 *
 * Key behaviors:
 * - Opening a session opens the folder once; closing it releases it once
 * - Internal navigation is allowed even while a change is being written
 * - A navigation that unloads the document is held back only while a change
 *   is still being written; a recording or a transcription never holds it
 * - A failed opening closes what it opened before it rejects, and a layout
 *   released early leaves nothing open
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { OpenFolderError } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { recordingEditor, settle } from './edits.test-support.js';
import type { Session } from './session.svelte.js';
import { type Workspace, WorkspaceError } from './workspace/types.js';
import {
	deferred,
	eventually,
	openTestWorkspace,
	type TestWorkspaceOptions,
	replaceTables,
} from './workspace.test-support.js';

const { mountSession, openSession } = await import('./session.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const session: Session = expectOk(await openSession(test.open));
	cleanups.push(async () => {
		await session.close();
		await test.remove();
	});
	return { session, library: session.library, test };
}

/** Moving between `/`, `/recordings`, and `/transformations`. */
const INTERNAL = { willUnload: false };
/** Closing the tab, reloading, or following a link out of the app. */
const UNLOAD = { willUnload: true };

test('a session opens the folder once and releases it once', async () => {
	const { session, library, test } = await open();
	expect(test.opens).toBe(1);
	// The first read happened: the device connections were read, and nothing was written.
	expect(library.connections?.transcription?.model).toBe('verification-model');

	await session.close();
	await session.close();

	expect(test.opens).toBe(1);
	expect(test.closes).toBe(1);
});

test('internal navigation is allowed while unloading is blocked only by a write in flight', async () => {
	const answer = deferred<Awaited<ReturnType<Workspace['transcribe']>>>();
	const { session, library } = await open({ transcribe: () => answer.promise });
	expect(session.blocksNavigation(INTERNAL)).toBe(false);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);

	// A recording holds nothing in the window: its row is in the folder from the start.
	await library.startRecording();
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
	await library.stopRecording();

	// Neither does a transcription: its row is in the folder before the request goes out.
	const transcribing = library.transcribe(library.entries[0]!);
	await eventually(
		() => library.resultsFor(library.entries[0]!.stem).length > 0,
	);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
	answer.resolve(Ok({ text: 'a steady tone' }));
	await transcribing;

	// A change still being written is held only here.
	recordingEditor(library).edit((row) => {
		row.fields.title = 'Typed just now';
	});
	expect(session.blocksNavigation(INTERNAL)).toBe(false);
	expect(session.blocksNavigation(UNLOAD)).toBe(true);
	await settle(library);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
});

test('a session whose first read fails releases the folder it opened', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const lost = new Error('the folder host went away');
	const unreadable: Workspace = {
		...test.workspace,
		folder: replaceTables(
			folder,
			{},
			{
				...folder.files,
				list: () => Promise.reject(lost),
			},
		),
	};

	const rejected = await openSession(async () => Ok(unreadable)).then(
		() => undefined,
		(cause: unknown) => cause,
	);

	// The folder was closed first; the rejection is the read's own error.
	expect(rejected).toBe(lost);
	expect(test.closes).toBe(1);
});

test('a workspace that cannot be opened is returned as the refusal, and no session exists', async () => {
	let opens = 0;
	const refused = expectErr(
		await openSession(async () => {
			opens += 1;
			const { error: insideTauri } = OpenFolderError.InsideTauri();
			return WorkspaceError.BrowserFolder({ refusal: insideTauri });
		}),
	);

	// One attempt, one answer: nothing else was opened in its place.
	expect(opens).toBe(1);
	expect(refused.name).toBe('BrowserFolder');
	expect(refused.message).toContain('Browser storage is not used');
});

// ============================================================================
// What the layout holds
// ============================================================================

test('a mounted session is released once, however often the layout releases it', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const mounted = mountSession(test.open);
	expectOk(await mounted.opening);

	mounted.release();
	mounted.release();
	await eventually(() => test.closes === 1);
	await Bun.sleep(20);
	expect(test.closes).toBe(1);
});

/**
 * A workspace whose first read is held open by the test. The folder underneath
 * is real and fresh; starting reads it and writes nothing.
 */
async function starting() {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const gate = deferred<void>();
	let begun = false;
	let fail: Error | undefined;
	const held = async () => {
		begun = true;
		await gate.promise;
		if (fail !== undefined) throw fail;
	};
	const { files } = folder;
	const workspace: Workspace = {
		...test.workspace,
		folder: replaceTables(
			folder,
			{},
			{
				...files,
				list: async () => {
					await held();
					return files.list();
				},
			},
		),
	};
	return {
		test,
		open: async () => Ok(workspace),
		/** Wait until the held call has been made and is pending. */
		async begun() {
			for (let waited = 0; waited < 200 && !begun; waited++) await Bun.sleep(5);
			expect(begun).toBe(true);
		},
		finish: () => gate.resolve(),
		failWith(error: Error) {
			fail = error;
			gate.resolve();
		},
	};
}

/**
 * A starting session whose workspace cannot be closed: its close rejects and
 * the real folder underneath stays open, as when the owner never confirms the
 * release. The test releases the real folder itself afterward.
 */
async function startingUnreleasable() {
	const started = await starting();
	const { test } = started;
	cleanups.push(() => test.workspace.close());
	return {
		...started,
		open: async () =>
			Ok({
				...expectOk(await started.open()),
				async close() {
					throw new Error('the owner did not confirm the release of sk-secret');
				},
			}),
	};
}

test('a start that fails and cannot release what it opened says both, without the release failure\u2019s details', async () => {
	const { test, open, begun, failWith } = await startingUnreleasable();
	const mounted = mountSession(open);
	await begun();

	const startup = new Error('the first read failed');
	failWith(startup);
	const rejected = await mounted.opening.then(
		() => undefined,
		(cause: unknown) => cause as Error,
	);

	expect(rejected?.cause).toBe(startup);
	expect(rejected?.message).toContain('the first read failed');
	expect(rejected?.message).toContain(
		'could not confirm that the folder was released',
	);
	expect(rejected?.message).not.toContain('sk-secret');
	expect(test.closes).toBe(0);
	mounted.release();
});

test('a layout released while its session is starting leaves nothing open', async () => {
	const { test, open, begun, finish } = await starting();
	const mounted = mountSession(open);
	await begun();

	mounted.release();
	finish();

	await expect(mounted.opening).rejects.toThrow('released');
	// The admitted read settled before the folder closed; nothing was written.
	expect(await readdir(test.root)).toEqual([]);
	expect(test.closes).toBe(1);
});

test('a layout released while its workspace is still opening closes that workspace without starting a session', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	let reads = 0;
	const { folder } = test.workspace;
	const { files } = folder;
	const counted: Workspace = {
		...test.workspace,
		folder: replaceTables(
			folder,
			{},
			{
				...files,
				list: () => {
					reads += 1;
					return files.list();
				},
			},
		),
	};
	const opened = deferred<void>();
	const mounted = mountSession(async () => {
		await opened.promise;
		return Ok(counted);
	});

	mounted.release();
	opened.resolve();

	await expect(mounted.opening).rejects.toThrow('released');
	expect(reads).toBe(0);
	expect(test.closes).toBe(1);
});
