/**
 * Session Lifetime Tests
 *
 * Drives session startup, navigation policy, and release over a real folder.
 * These tests do not mount routes; layout ownership is checked separately in
 * `page-boundary.test.ts`. Held-work details belong to library and leave tests.
 *
 * Key behaviors:
 * - Opening a session opens the folder once; closing it releases it once
 * - Internal navigation is allowed even while the session holds unsaved work
 * - A navigation that unloads the document is held back only while a change
 *   is still being written; a recording or a transcription never holds it
 * - The close guard belongs to the session and stops listening when it closes
 * - A failed opening is answered for only when it was refused, or proves that
 *   everything it opened was closed; any other rejection leaves closes unanswered
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { recordingEditor, settle } from './edits.test-support.js';
import { createQueryClient } from './query.test-support.js';
import type { Session } from './session.svelte.js';
import { type Workspace, WorkspaceError } from './workspace/types.js';
import {
	deferred,
	eventually,
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const {
	mountSession,
	openSession,
	OpeningNotReleasedError,
	OpeningReleasedError,
} = await import('./session.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const session: Session = expectOk(
		await openSession(createQueryClient(), test.open),
	);
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
	expect(test.closeListeners.size).toBe(1);
	// The first read happened: the device's connections were read, and nothing was written.
	expect(library.connections?.transcription?.model).toBe('verification-model');

	await session.close();
	await session.close();

	expect(test.opens).toBe(1);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
});

test('internal navigation is allowed while unloading is blocked only by unsaved work', async () => {
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
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => Promise.reject(lost),
			},
		},
	};

	const rejected = await openSession(createQueryClient(), async () =>
		Ok(unreadable),
	).then(
		() => undefined,
		(cause: unknown) => cause,
	);

	// The rejection says the close completed, and carries the read's own error.
	expect(rejected).toBeInstanceOf(OpeningReleasedError);
	expect((rejected as InstanceType<typeof OpeningReleasedError>).startup).toBe(
		lost,
	);
	expect((rejected as Error).cause).toBe(lost);
	expect((rejected as Error).message).toBe('the folder host went away');
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
});

test('a workspace that cannot be opened is returned as the refusal, and no session exists', async () => {
	let opens = 0;
	const refused = expectErr(
		await openSession(createQueryClient(), async () => {
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
// What the layout holds, and who answers a close
// ============================================================================

/** Counts when answering for a failed opening starts and stops. */
function closeAnswerer() {
	const counts = { started: 0, stopped: 0 };
	return {
		counts,
		answerClose: () => {
			counts.started += 1;
			return () => {
				counts.stopped += 1;
			};
		},
	};
}

const refusal = () => {
	const { error: notPermitted } = OpenFolderError.WindowNotPermitted({
		scope: 'so.epicenter.whispering',
		window: 'main',
	});
	return WorkspaceError.DesktopFolder({ refusal: notPermitted });
};

test('while a session exists, only its guard answers a close: nothing answers for it unseen', async () => {
	const test = await openTestWorkspace();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(createQueryClient(), test.open, answerClose);
	const session = expectOk(await mounted.opening);
	cleanups.push(test.remove);

	// The shell asks. The session's own guard is the listener, and it answers.
	expect(test.closeListeners.size).toBe(1);
	for (const listener of test.closeListeners) listener();
	await Bun.sleep(50);
	expect(test.answers).toEqual(['asking', 'proceed']);
	expect(counts).toEqual({ started: 0, stopped: 0 });

	mounted.release();
	mounted.release();
	await session.close();
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a refused opening starts answering closes only once it has settled, and release stops it', async () => {
	const settle = deferred<ReturnType<typeof refusal>>();
	const { counts, answerClose } = closeAnswerer();

	const mounted = mountSession(
		createQueryClient(),
		() => settle.promise,
		answerClose,
	);
	// Still opening: a close asked now is not answered by anyone yet.
	await Bun.sleep(10);
	expect(counts).toEqual({ started: 0, stopped: 0 });

	settle.resolve(refusal());
	expect(expectErr(await mounted.opening).name).toBe('DesktopFolder');
	await Bun.sleep(0);
	expect(counts).toEqual({ started: 1, stopped: 0 });

	mounted.release();
	mounted.release();
	expect(counts).toEqual({ started: 1, stopped: 1 });
});

test('an opening that fails after its folder opened is also a failed opening: the folder is released, then closes are answered', async () => {
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	const { folder } = test.workspace;
	const unreadable: Workspace = {
		...test.workspace,
		folder: {
			...folder,
			kv: {
				...folder.kv,
				get: () => Promise.reject(new Error('the first read failed')),
			},
		},
	};
	const { counts, answerClose } = closeAnswerer();

	const mounted = mountSession(
		createQueryClient(),
		async () => Ok(unreadable),
		answerClose,
	);
	await expect(mounted.opening).rejects.toThrow('the first read failed');
	await Bun.sleep(0);

	// No session and no guard is left listening, so nothing else would answer.
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 1, stopped: 0 });
	mounted.release();
	expect(counts).toEqual({ started: 1, stopped: 1 });
});

test('an opener that throws partway through acquiring is never answered for, even with a close pending', async () => {
	// The real folder is open: the opener acquired it, then threw before
	// returning a workspace, as when releasing a mismatched folder fails.
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	cleanups.push(() => test.workspace.close());
	const thrown = new Error('closing the mismatched folder failed');
	const acquiring = deferred<void>();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(
		createQueryClient(),
		async () => {
			await acquiring.promise;
			throw thrown;
		},
		answerClose,
	);
	// The person asks to close while the opening is under way.
	test.requestClose();

	acquiring.resolve();
	const rejected = await mounted.opening.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(rejected).toBe(thrown);
	await Bun.sleep(20);

	// Nothing proves the folder was released, so neither the pending close
	// nor a later one is answered.
	expect(test.closes).toBe(0);
	test.requestClose();
	await Bun.sleep(20);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
	mounted.release();
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('an opening that fails without proof answers no close by itself, and quits only when the person presses Quit', async () => {
	const acquiring = deferred<void>();
	const { counts, answerClose } = closeAnswerer();
	let quits = 0;
	const mounted = mountSession(
		createQueryClient(),
		async () => {
			await acquiring.promise;
			throw new Error('the desktop workspace could not be loaded');
		},
		answerClose,
		async () => {
			quits += 1;
			return undefined;
		},
	);
	if (mounted.quit === undefined) throw new Error('expected a quit');

	// Still opening: Quit is refused, so nothing can answer for work under way.
	expect(await mounted.quit()).toBeDefined();
	expect(quits).toBe(0);

	acquiring.resolve();
	await expect(mounted.opening).rejects.toThrow('could not be loaded');
	await Bun.sleep(0);
	// Nothing proves the folder was released: no close is answered unseen.
	expect(counts).toEqual({ started: 0, stopped: 0 });

	expect(await mounted.quit()).toBeUndefined();
	expect(quits).toBe(1);

	mounted.release();
	expect(await mounted.quit()).toBeDefined();
	expect(quits).toBe(1);
});

test('a layout that went away before its opening failed never starts answering', async () => {
	const settle = deferred<ReturnType<typeof refusal>>();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(
		createQueryClient(),
		() => settle.promise,
		answerClose,
	);

	mounted.release();
	settle.resolve(refusal());
	await mounted.opening;
	await Bun.sleep(0);

	expect(counts).toEqual({ started: 0, stopped: 0 });
});

// ============================================================================
// A close asked while the session is still starting
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

/** Wait for something another task does. */
async function until(condition: () => boolean, what: string) {
	for (let waited = 0; waited < 300; waited++) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

test('a close asked while the first read is pending is not answered until the session has started, and then its guard decides', async () => {
	const { test, open, begun, finish } = await starting();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(createQueryClient(), open, answerClose);
	await begun();

	// The person asks to close, more than once, while the session is starting.
	test.requestClose();
	test.requestClose();
	await Bun.sleep(60);

	// Nobody is listening yet and nobody has answered: not even `asking`.
	expect(test.closeListeners.size).toBe(0);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
	expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(false);

	finish();
	const session = expectOk(await mounted.opening);
	cleanups.push(() => session.close());

	// The kept request reached the session's guard once it existed. The
	// session has started and holds nothing, so the guard lets it close.
	await until(() => test.answers.length === 2, 'the guard to answer');
	expect(test.answers).toEqual(['asking', 'proceed']);
	expect(test.closeListeners.size).toBe(1);
	expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(false);
	expect(session.library.connections?.transcription?.model).toBe(
		'verification-model',
	);
	// It was the guard's answer. Nothing answered for the opening unseen.
	expect(counts).toEqual({ started: 0, stopped: 0 });
	mounted.release();
});

test('a start that fails with a close pending answers nothing until everything it opened is released, and then hands over', async () => {
	const { test, open, begun, failWith } = await starting();
	// The workspace takes a moment to close, as a folder with work under way does.
	const closing = deferred<void>();
	const release = test.workspace.close;
	let closeBegan = false;
	const slowToClose = async () => {
		const opened = await open();
		return Ok({
			...expectOk(opened),
			async close() {
				closeBegan = true;
				await closing.promise;
				await release();
			},
		});
	};
	const seen: { closes: number; answers: number }[] = [];
	const mounted = mountSession(createQueryClient(), slowToClose, () => {
		seen.push({ closes: test.closes, answers: test.answers.length });
		return () => {};
	});
	await begun();
	test.requestClose();

	failWith(new Error('the first read failed'));
	await until(() => closeBegan, 'the failed session to start closing');
	await Bun.sleep(40);
	// The read has failed, but the folder is not released yet: still nothing answers.
	expect(seen).toEqual([]);
	expect(test.answers).toEqual([]);

	closing.resolve();
	await expect(mounted.opening).rejects.toThrow('the first read failed');
	await Bun.sleep(0);

	// Only now does the failed-opening answer take over, with the folder
	// released, no guard ever having listened, and no answer given before it.
	expect(seen).toEqual([{ closes: 1, answers: 0 }]);
	expect(test.closeListeners.size).toBe(0);
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

test('a start that fails and cannot release what it opened keeps both reasons and never answers a close', async () => {
	const { test, open, begun, failWith } = await startingUnreleasable();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(createQueryClient(), open, answerClose);
	await begun();
	test.requestClose();

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

	// The folder is still held. Nothing listens, and nothing answers for it,
	// not the close asked while starting and not one asked now.
	expect(test.closes).toBe(0);
	expect(test.closeListeners.size).toBe(0);
	test.requestClose();
	await Bun.sleep(20);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });

	mounted.release();
	await Bun.sleep(0);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a layout released while starting, whose closing then fails, answers nothing', async () => {
	const { test, open, begun, finish } = await startingUnreleasable();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(createQueryClient(), open, answerClose);
	await begun();

	mounted.release();
	test.requestClose();
	finish();

	const rejected = await unreleased(mounted.opening);
	expect((rejected.startup as Error).message).toContain('released');
	await Bun.sleep(20);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a workspace released before its session starts, whose closing fails, reports that too', async () => {
	const opened = deferred<void>();
	let closed = 0;
	const test = await openTestWorkspace();
	cleanups.push(test.remove);
	cleanups.push(() => test.workspace.close());
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(
		createQueryClient(),
		async () => {
			await opened.promise;
			return Ok({
				...test.workspace,
				async close() {
					closed += 1;
					throw new Error('the owner did not confirm the release');
				},
			});
		},
		answerClose,
	);

	mounted.release();
	opened.resolve();

	const rejected = await unreleased(mounted.opening);
	expect((rejected.startup as Error).message).toContain('released');
	expect(closed).toBe(1);
	await Bun.sleep(0);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});

test('a layout released while its session is starting leaves nothing listening and nothing open, and answers nothing', async () => {
	const { test, open, begun, finish } = await starting();
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(createQueryClient(), open, answerClose);
	await begun();

	mounted.release();
	test.requestClose();
	finish();

	await expect(mounted.opening).rejects.toThrow('released');
	await Bun.sleep(20);
	// The admitted read settled before the folder closed; nothing was seeded.
	expect(await Bun.file(`${test.root}/kv.json`).exists()).toBe(false);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(test.answers).toEqual([]);
	expect(counts).toEqual({ started: 0, stopped: 0 });
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
	const { counts, answerClose } = closeAnswerer();
	const mounted = mountSession(
		createQueryClient(),
		async () => {
			await opened.promise;
			return Ok(counted);
		},
		answerClose,
	);

	mounted.release();
	opened.resolve();

	await expect(mounted.opening).rejects.toThrow('released');
	expect(reads).toBe(0);
	expect(test.closes).toBe(1);
	expect(test.closeListeners.size).toBe(0);
	expect(counts).toEqual({ started: 0, stopped: 0 });
});
