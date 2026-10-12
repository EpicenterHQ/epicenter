/**
 * Session Lifetime Tests
 *
 * Drives session startup, navigation policy, and release over a real folder.
 * These tests do not mount routes; layout ownership is checked separately in
 * `page-boundary.test.ts`. Held-work details belong to the library tests, and
 * what a close waits for to `editing.test.ts`.
 *
 * Key behaviors:
 * - Opening a session opens the folder once; closing it releases it once
 * - Internal navigation is allowed even while the session holds unsaved work
 * - A navigation that unloads the document is held back only while something
 *   exists only in the window
 * - A layout released before its session starts closes what it opened
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Session } from './session.svelte.js';
import { type Workspace, WorkspaceError } from './workspace/types.js';
import {
	deferred,
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { mountSession, openSession, OpeningNotReleasedError } = await import(
	'./session.svelte.ts'
);

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
	// The first read happened: the device's connections were read, and nothing was written.
	expect(library.connections?.transcription?.model).toBe('verification-model');

	await session.close();
	await session.close();

	expect(test.opens).toBe(1);
	expect(test.closes).toBe(1);
});

test('internal navigation is allowed while unloading is blocked only by unsaved work', async () => {
	const { session, library } = await open();
	expect(session.blocksNavigation(INTERNAL)).toBe(false);
	expect(session.blocksNavigation(UNLOAD)).toBe(false);

	await library.startRecording();
	expect(session.blocksNavigation(INTERNAL)).toBe(false);
	expect(session.blocksNavigation(UNLOAD)).toBe(true);

	await library.stopRecording();
	expect(session.blocksNavigation(UNLOAD)).toBe(false);
});

test('a session whose first read fails releases the folder it opened', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const lost = new Error('the folder host went away');
	const unreadable: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => Promise.reject(lost),
			},
		},
	};

	const rejected = await openSession(async () => Ok(unreadable)).then(
		() => undefined,
		(cause: unknown) => cause,
	);

	// The close completed, and the rejection is the read's own error.
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
// While the session is starting
// ============================================================================

/**
 * A workspace whose first read is held open by the test. The folder underneath
 * is real and fresh; starting reads it without creating settings.
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
	const workspace: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: async () => {
					await held();
					return folder.kv.get();
				},
			},
		},
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

test('a start that fails closes what it opened', async () => {
	const { test, open, begun, failWith } = await starting();
	const mounted = mountSession(open);
	await begun();

	failWith(new Error('the first read failed'));
	await expect(mounted.opening).rejects.toThrow('the first read failed');
	expect(test.closes).toBe(1);
	mounted.release();
});

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

/** What an opening rejected with, which must be an unreleased failure. */
async function unreleased(opening: Promise<unknown>) {
	const rejected = await opening.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	if (!(rejected instanceof OpeningNotReleasedError))
		throw new Error(`expected an unreleased opening, got ${String(rejected)}`);
	return rejected;
}

test('a start that fails and cannot release what it opened keeps both reasons', async () => {
	const { test, open, begun, failWith } = await startingUnreleasable();
	const mounted = mountSession(open);
	await begun();

	failWith(new Error('the first read failed'));
	const rejected = await unreleased(mounted.opening);
	await Bun.sleep(20);

	// Why it failed and why it could not be released are both kept. What the
	// person reads names the first and does not repeat the second's details.
	expect(rejected.startup).toBeInstanceOf(Error);
	expect((rejected.startup as Error).message).toBe('the first read failed');
	expect((rejected.cleanup as Error).message).toContain('did not confirm');
	expect(rejected.message).toContain('the first read failed');
	expect(rejected.message).toContain(
		'could not confirm that the folder was released',
	);
	expect(rejected.message).not.toContain('sk-secret');

	// The folder is still held.
	expect(test.closes).toBe(0);
	mounted.release();
});

test('a layout released while starting, whose closing then fails, reports both reasons', async () => {
	const { test, open, begun, finish } = await startingUnreleasable();
	const mounted = mountSession(open);
	await begun();

	mounted.release();
	finish();

	const rejected = await unreleased(mounted.opening);
	expect((rejected.startup as Error).message).toContain('released');
});

test('a workspace released before its session starts, whose closing fails, reports that too', async () => {
	const opened = deferred<void>();
	let closed = 0;
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	cleanups.push(() => test.workspace.close());
	const mounted = mountSession(async () => {
		await opened.promise;
		return Ok({
			...test.workspace,
			async close() {
				closed += 1;
				throw new Error('the owner did not confirm the release');
			},
		});
	});

	mounted.release();
	opened.resolve();

	const rejected = await unreleased(mounted.opening);
	expect((rejected.startup as Error).message).toContain('released');
	expect(closed).toBe(1);
});

test('a layout released while its session is starting leaves nothing open', async () => {
	const { test, open, begun, finish } = await starting();
	const mounted = mountSession(open);
	await begun();

	mounted.release();
	finish();

	await expect(mounted.opening).rejects.toThrow('released');
	await Bun.sleep(20);
	// The admitted read settled before the folder closed; nothing was seeded.
	expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(false);
	expect(test.closes).toBe(1);
});

test('a layout released while its workspace is still opening closes that workspace without starting a session', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	let reads = 0;
	const { folder } = test.workspace;
	const counted: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => {
					reads += 1;
					return folder.kv.get();
				},
			},
		},
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
