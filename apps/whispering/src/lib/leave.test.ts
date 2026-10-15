/**
 * What the page answers when the desktop shell asks to close, driven against
 * the real product state over a real folder.
 *
 * Key behaviors:
 * - Nothing held: the page answers `proceed` with no prompt
 * - A row save still running is waited for, then `proceed`
 * - A live recording holds nothing: its row and audio are in the folder
 * - A write that failed was rolled back and reported; it holds nothing
 * - "Keep working" answers `cancel` and every held byte is still there
 * - "Discard and quit" answers `proceed`
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rowPath } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import { createFixtureDevice, toneWav } from './capture.js';
import {
	recordingEditor,
	settle,
	transformationEditor,
} from './edits.test-support.js';
import type { Library } from './library.svelte.js';
import { createQueryClient } from './query.test-support.js';
import type { CloseDecision, Workspace } from './workspace/types.js';
import { openTestFolder, testConnections } from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');
const { createLeaveGuard } = await import('./leave.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const library of opened.splice(0)) await library.close();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function open({
	failPrepare = false,
	deliverProceed,
	beforeTransformationRead,
}: {
	/** Make finding out what is held throw. */
	failPrepare?: boolean;
	/** How a `proceed` reaches the shell: held, or lost. It is recorded first. */
	deliverProceed?: () => Promise<void>;
	/** Runs before each read of a transformation row. */
	beforeTransformationRead?: () => Promise<void>;
} = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-leave-')),
	);
	roots.push(root);
	const folder = await openTestFolder(root);
	const { transformations } = folder.tables;
	const tables = {
		...folder.tables,
		transformations: {
			...transformations,
			get: async (stem: string) => {
				await beforeTransformationRead?.();
				return transformations.get(stem);
			},
		},
	};
	const answers: CloseDecision[] = [];
	const requestListeners = new Set<() => void>();
	const hostGoneListeners = new Set<() => void>();
	let quitSignals = 0;
	let transformCalls = 0;
	const workspace: Workspace = {
		kind: 'native',
		folder: { ...folder, tables } as Workspace['folder'],
		location: root,
		terminal: {
			cwd: '/',
			exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
			note: 'test',
		},
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		captureNotice: undefined,
		reveal: undefined,
		transcribe: async () => Ok({ text: 'a steady tone' }),
		transform: async ({ input }) => {
			transformCalls += 1;
			return Ok({ text: `Cleaned: ${input.trim()}` });
		},
		transformNote: 'test',
		closing: {
			onRequest(listener) {
				requestListeners.add(listener);
				return () => requestListeners.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
				if (decision === 'proceed') await deliverProceed?.();
			},
			onRequestWithoutHost(listener) {
				hostGoneListeners.add(listener);
				return () => hostGoneListeners.delete(listener);
			},
			quitWithoutHost() {
				quitSignals += 1;
			},
		},
		connections: testConnections().member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
		debugControls: true,
		injection: undefined,
		close: () => folder.close(),
	};
	const library = createLibrary(workspace, createQueryClient());
	opened.push(library);
	await library.start();
	const guard = createLeaveGuard(
		failPrepare
			? {
					prepareToLeave: async () => {
						throw new Error('the folder host went away');
					},
					get unsavedWork() {
						return library.unsavedWork;
					},
					pauseAdmission: () => library.pauseAdmission(),
					resumeAdmission: () => library.resumeAdmission(),
				}
			: library,
		workspace.closing,
	);
	/** The shell asks to close, exactly as the workspace delivers it. */
	async function ask() {
		const before = answers.length;
		for (const listener of requestListeners) listener();
		// Settled when the page has gone past its acknowledgement: it either
		// proceeded or put up its prompt.
		for (let waited = 0; waited < 200; waited++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (
				answers.length > before &&
				(guard.asking || answers.at(-1) === 'proceed')
			)
				return;
		}
		throw new Error('the page never settled a close request');
	}
	return {
		library,
		guard,
		root,
		answers,
		ask,
		listeners: requestListeners,
		/** The shell tried to close but its host is gone. */
		askWithoutHost() {
			for (const listener of hostGoneListeners) listener();
		},
		get quitSignals() {
			return quitSignals;
		},
		/** How many transformation requests reached the endpoint. */
		get transformCalls() {
			return transformCalls;
		},
	};
}

/** Wait for something another task does. */
async function until(condition: () => boolean, what: string) {
	for (let waited = 0; waited < 200; waited++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function record(library: Library) {
	await library.startRecording();
	await library.stopRecording();
}

/** A draft as plain data, to compare before and after. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Name a model in the open transformation, so it can run. */
async function nameModel(library: Library) {
	const session = transformationEditor(library);
	session.edit((row) => {
		row.fields.model = 'chat-model';
	});
	await settle(library);
}

test('with everything saved, a close request is acknowledged and proceeds without a prompt', async () => {
	const { library, guard, answers, ask } = await open();
	await record(library);

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.asking).toBe(false);
});

test('a row save still running is waited for, then the close proceeds', async () => {
	const { library, guard, answers, ask, root } = await open();
	await record(library);
	const session = recordingEditor(library);
	session.edit((row) => {
		row.fields.title = 'Typed just now';
	});
	expect(library.isSaving(session.path)).toBe(true);

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.asking).toBe(false);
	expect(library.isSaving(session.path)).toBe(false);
	const saved = await Bun.file(join(root, session.path)).text();
	expect(saved).toContain('title: Typed just now');
});

test('a live recording holds nothing: its row and audio are in the folder, and closing keeps it', async () => {
	const { library, guard, answers, ask, root } = await open();
	await library.startRecording();
	const [entry] = library.entries;

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.held).toEqual([]);
	await library.close();
	expect(
		await Bun.file(join(root, rowPath('recordings', entry!.stem))).exists(),
	).toBe(true);
	expect(await Bun.file(join(root, entry!.row.fields.audioPath)).exists()).toBe(
		true,
	);
});

test('a recording deleted elsewhere under typing stays deleted: the write fails, the lost text is reported, and the close proceeds', async () => {
	const { library, answers, ask, root } = await open();
	await record(library);
	const failures: string[] = [];
	library.onWriteFailed((failure) => failures.push(failure.lost));
	const session = recordingEditor(library);
	const path = join(root, session.path);
	await rm(path);
	session.edit((row) => {
		row.fields.title = 'Typed after it was removed';
	});
	await settle(library);
	expect(failures).toEqual([
		expect.stringContaining('title: Typed after it was removed'),
	]);
	expect(library.selection).toBeUndefined();

	await ask();

	expect(answers).toEqual(['asking', 'proceed']);
	expect(await Bun.file(path).exists()).toBe(false);
});

test('a failed write rolls back and is reported, the close does not write it again, and typing after it saves', async () => {
	const { library, guard, answers, ask, root } = await open();
	await record(library);
	const failures: string[] = [];
	library.onWriteFailed((failure) => failures.push(failure.lost));
	const session = recordingEditor(library);
	const path = join(root, session.path);
	const before = await Bun.file(path).text();
	// The row's directory refuses the save; the cache rolls back.
	chmodSync(join(root, 'recordings'), 0o555);
	try {
		session.edit((row) => {
			row.fields.title = 'Typed before it failed';
		});
		await settle(library);
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
	}
	expect(failures).toEqual([
		expect.stringContaining('title: Typed before it failed'),
	]);
	expect(session.draft.fields.title).not.toBe('Typed before it failed');

	// Nothing is held: the failure was reported, and the file is as it was.
	await ask();
	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.asking).toBe(false);
	expect(await Bun.file(path).text()).toBe(before);
});

test('when what is held cannot be determined, the page asks instead of proceeding', async () => {
	const { guard, answers, ask } = await open({ failPrepare: true });

	await ask();

	expect(answers).toEqual(['asking']);
	expect(guard.asking).toBe(true);
	await guard.stay();
	expect(answers).toEqual(['asking', 'cancel']);
});

test('with the host gone, a close attempt keeps the window, and quitting stays an explicit choice', async () => {
	const started = await open();
	const { guard, answers } = started;

	started.askWithoutHost();

	expect(guard.asking).toBe(true);
	expect(guard.hostGone).toBe(true);
	// Nothing is sent to a host that is not there, and nothing has quit.
	expect(answers).toEqual([]);
	expect(started.quitSignals).toBe(0);

	await guard.stay();

	expect(guard.asking).toBe(false);
	expect(started.quitSignals).toBe(0);

	// Only the explicit choice quits, through the shell's direct signal.
	started.askWithoutHost();
	await guard.discardAndQuit();
	expect(started.quitSignals).toBe(1);
	expect(answers).toEqual([]);
});

test('a guard disposed while it is finding out what is held approves nothing', async () => {
	const answers: CloseDecision[] = [];
	const listeners = new Set<() => void>();
	const prepared = Promise.withResolvers<boolean>();
	const guard = createLeaveGuard(
		{
			prepareToLeave: () => prepared.promise,
			unsavedWork: [],
			pauseAdmission() {},
			resumeAdmission() {},
		},
		{
			onRequest(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
			},
			onRequestWithoutHost: () => () => {},
			quitWithoutHost() {},
		},
	);

	for (const listener of listeners) listener();
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(answers).toEqual(['asking']);

	// The session closes while the guard is still waiting on its saves.
	guard.dispose();
	prepared.resolve(true);
	await new Promise((resolve) => setTimeout(resolve, 10));

	expect(answers).toEqual(['asking']);
	expect(guard.asking).toBe(false);
});

test('the guard stops listening when the view goes away', async () => {
	const { guard, listeners } = await open();
	expect(listeners.size).toBe(1);
	guard.dispose();
	expect(listeners.size).toBe(0);
});

// ============================================================================
// Nothing new starts once the shell has asked
// ============================================================================

test('a capture or typing asked for while the approval is on its way is refused', async () => {
	const delivered = Promise.withResolvers<void>();
	const { library, guard, answers, ask } = await open({
		deliverProceed: () => delivered.promise,
	});
	await record(library);
	const session = recordingEditor(library);
	const before = plain(session.draft);

	// Nothing was held, so `proceed` is sent. It has not arrived yet.
	await ask();
	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.phase).toBe('quitting');

	await library.startRecording();
	expect(library.locked(session.path)).toBe(true);
	session.edit((row) => {
		row.fields.title = 'Typed after approval';
	});

	expect(library.recorder.phase).toBe('idle');
	expect(plain(session.draft)).toEqual(before);
	expect(library.isSaving(session.path)).toBe(false);
	expect(library.holdsUnsavedWork).toBe(false);

	delivered.resolve();
	await until(() => !guard.sending, 'the quit to be delivered');
	// Committed: there is nothing to keep working on.
	await guard.stay();
	expect(guard.phase).toBe('quitting');
	expect(library.admitting).toBe(false);
	expect(answers).toEqual(['asking', 'proceed']);
});

test('while the person decides nothing new starts, and keep working admits work again with everything intact', async () => {
	const { library, guard, answers, ask, root } = await open({
		failPrepare: true,
	});
	await library.createTransformation({ title: 'Clean up', prompt: 'Tidy.\n' });
	const session = transformationEditor(library);
	session.edit((row) => {
		row.body = 'Typed before the close.\n';
	});
	await settle(library);

	await ask();
	expect(answers).toEqual(['asking']);
	expect(guard.phase).toBe('asking');

	// Every way to start something is refused, whoever calls it.
	await library.startRecording();
	expect(library.recorder.phase).toBe('idle');
	session.edit((row) => {
		row.body = 'typed while asked';
	});
	expect(session.draft.body).toBe('Typed before the close.\n');
	expect(library.isSaving(session.path)).toBe(false);
	expect(await library.editSource(session.path)).toContain('closing');
	expect(await library.createFile('', 'note.md')).toContain('closing');
	expect(await Bun.file(join(root, 'note.md')).exists()).toBe(false);
	const terminal = library.terminal;
	if (terminal === undefined)
		throw new Error('The native workspace has a terminal');
	terminal.command = 'echo hi';
	await terminal.run();
	expect(terminal.runs.at(-1)?.result?.stderr).toContain('closing');
	expect((await library.saveVersion()).status).toBe('blocked');

	await guard.stay();

	expect(answers).toEqual(['asking', 'cancel']);
	expect(library.admitting).toBe(true);
	expect(session.draft.body).toBe('Typed before the close.\n');
	session.edit((row) => {
		row.body = 'Typed before the close.\nMore.\n';
	});
	await settle(library);
	expect(await Bun.file(join(root, session.path)).text()).toContain('More.');
	await library.startRecording();
	expect(library.recorder.phase).toBe('recording');
	await library.cancelRecording();
});

test('a quit whose answer is lost stays committed: nothing is admitted again, and quitting again is the only action', async () => {
	const started = await open({
		deliverProceed: async () => {
			throw new TypeError('Load failed');
		},
	});
	const { library, guard, answers, ask, listeners } = started;

	await ask();
	await until(() => !guard.sending, 'the quit to be tried');
	expect(answers).toEqual(['asking', 'proceed']);
	expect(guard.phase).toBe('quitting');
	expect(guard.problem).toBe('Load failed');
	// The page quit on its own judgement, so it chose no other way out.
	expect(started.quitSignals).toBe(0);

	await guard.stay();
	expect(guard.phase).toBe('quitting');
	expect(library.admitting).toBe(false);
	await library.startRecording();
	expect(library.recorder.phase).toBe('idle');

	// The shell asks again: acknowledged, and nothing resumes.
	for (const listener of listeners) listener();
	await until(() => answers.length === 3, 'the acknowledgement');
	expect(answers).toEqual(['asking', 'proceed', 'asking']);
	expect(guard.phase).toBe('quitting');

	// The person quits again: the same answer, and the quit address in case
	// the host is gone.
	await guard.discardAndQuit();
	expect(answers).toEqual(['asking', 'proceed', 'asking', 'proceed']);
	expect(started.quitSignals).toBe(1);

	// The shell says its host is gone: quitting again uses the quit address.
	started.askWithoutHost();
	expect(guard.phase).toBe('quitting');
	await guard.discardAndQuit();
	expect(started.quitSignals).toBe(2);
	expect(answers).toHaveLength(4);
	expect(library.admitting).toBe(false);
});

test('a transformation whose reads were under way when the shell asked to close is waited for and never sent', async () => {
	let hold: PromiseWithResolvers<void> | undefined;
	const started = await open({
		beforeTransformationRead: () => hold?.promise ?? Promise.resolve(),
	});
	const { library, guard, answers, ask } = started;
	await record(library);
	await library.transcribe(library.entries[0]!);
	await library.createTransformation({ title: 'Clean up', prompt: 'Tidy.\n' });
	const profile = library.selectedTransformation!;
	await nameModel(library);
	const transcript = library.resultsFor(library.entries[0]!.stem)[0]!;
	hold = Promise.withResolvers<void>();
	const running = library.transform(transcript.path, profile.path);

	// The page waits for its reads: they are admitted work.
	const asking = ask();
	await until(() => answers.length > 0, 'the acknowledgement');
	expect(guard.phase).toBe('preparing');
	hold.resolve();
	await asking;

	// Nothing new starts once the shell asked, so it was never sent.
	expect(await running).toContain('closing');
	expect(started.transformCalls).toBe(0);
	expect(library.recipeRuns).toEqual([]);
	expect(library.transformationResults).toEqual([]);
	expect(answers).toEqual(['asking', 'proceed']);
});

test('a recipe run on pasted text whose read was under way when the shell asked to close is never sent, and none starts meanwhile', async () => {
	let hold: PromiseWithResolvers<void> | undefined;
	const started = await open({
		beforeTransformationRead: () => hold?.promise ?? Promise.resolve(),
	});
	const { library, guard, answers, ask } = started;
	await library.createTransformation({ title: 'Clean up', prompt: 'Tidy.\n' });
	const profile = library.selectedTransformation!;
	await nameModel(library);
	hold = Promise.withResolvers<void>();
	const running = library.transformText(profile.path, 'pasted words\n');

	const asking = ask();
	await until(() => answers.length > 0, 'the acknowledgement');
	expect(guard.phase).toBe('preparing');
	// A new run on pasted text is refused while the page decides.
	expect(await library.transformText(profile.path, 'other words\n')).toContain(
		'closing',
	);
	hold.resolve();
	await asking;

	expect(await running).toContain('closing');
	expect(started.transformCalls).toBe(0);
	expect(library.recipeRuns).toEqual([]);
	expect(answers).toEqual(['asking', 'proceed']);
});

test('a guard that was disposed answers nothing, whatever its prompt still offers', async () => {
	const { guard, answers, ask } = await open({ failPrepare: true });
	await ask();
	expect(guard.phase).toBe('asking');
	guard.dispose();

	await guard.stay();
	await guard.discardAndQuit();

	expect(answers).toEqual(['asking']);
	expect(guard.phase).toBe('asking');
});

/** A guard over a library whose preparation the test finishes. */
function scripted() {
	const answers: CloseDecision[] = [];
	const requests = new Set<() => void>();
	const hostGone = new Set<() => void>();
	const prepared = Promise.withResolvers<boolean>();
	const counts = { prepares: 0, quitSignals: 0 };
	let admitting = true;
	const guard = createLeaveGuard(
		{
			prepareToLeave() {
				counts.prepares += 1;
				return prepared.promise;
			},
			unsavedWork: [],
			pauseAdmission() {
				admitting = false;
			},
			resumeAdmission() {
				admitting = true;
			},
		},
		{
			onRequest(listener) {
				requests.add(listener);
				return () => requests.delete(listener);
			},
			async answer(decision) {
				answers.push(decision);
			},
			onRequestWithoutHost(listener) {
				hostGone.add(listener);
				return () => hostGone.delete(listener);
			},
			quitWithoutHost() {
				counts.quitSignals += 1;
			},
		},
	);
	return {
		guard,
		answers,
		counts,
		prepared,
		get admitting() {
			return admitting;
		},
		ask: () => {
			for (const listener of requests) listener();
		},
		askWithoutHost: () => {
			for (const listener of hostGone) listener();
		},
	};
}

test('requests that arrive together stop admission at once and prepare once', async () => {
	const page = scripted();

	page.ask();
	page.ask();
	// Before anything was awaited.
	expect(page.admitting).toBe(false);
	expect(page.guard.phase).toBe('preparing');
	await until(() => page.counts.prepares === 1, 'the preparation');
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(page.answers).toEqual(['asking', 'asking']);
	expect(page.counts.prepares).toBe(1);

	page.prepared.resolve(true);
	await until(() => page.answers.length === 3, 'the answer');
	expect(page.answers).toEqual(['asking', 'asking', 'proceed']);
});

test('the host going away while saves settle shows the prompt, and approves nothing by itself', async () => {
	const page = scripted();
	page.ask();
	await until(() => page.answers.length === 1, 'the acknowledgement');

	page.askWithoutHost();
	expect(page.guard.phase).toBe('asking');
	expect(page.guard.hostGone).toBe(true);
	page.prepared.resolve(true);
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(page.answers).toEqual(['asking']);
	expect(page.counts.quitSignals).toBe(0);
	expect(page.admitting).toBe(false);
	await page.guard.discardAndQuit();
	expect(page.counts.quitSignals).toBe(1);
});

test('quitting while saves settle waits for them: nothing finishes a save after the shell exits', async () => {
	const page = scripted();
	page.ask();
	await until(() => page.answers.length === 1, 'the acknowledgement');
	// The host goes away while the saves the page admitted are still running,
	// and the person quits at once.
	page.askWithoutHost();
	expect(page.guard.asking).toBe(true);

	const quitting = page.guard.discardAndQuit();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(page.guard.phase).toBe('quitting');
	expect(page.counts.quitSignals).toBe(0);

	page.prepared.resolve(true);
	await quitting;
	expect(page.counts.quitSignals).toBe(1);
	expect(page.answers).toEqual(['asking']);
});

test('keep working while saves settle admits work again, and the finished preparation approves nothing', async () => {
	const page = scripted();
	page.ask();
	await until(() => page.answers.length === 1, 'the acknowledgement');

	await page.guard.stay();
	expect(page.answers).toEqual(['asking', 'cancel']);
	expect(page.admitting).toBe(true);
	page.prepared.resolve(true);
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(page.answers).toEqual(['asking', 'cancel']);
	expect(page.guard.phase).toBe('idle');
});

test('a closed library takes no input and cannot resume admission', async () => {
	const { library, guard } = await open();
	await record(library);
	const session = recordingEditor(library);
	const before = plain(session.draft);
	guard.dispose();
	await library.close();
	library.resumeAdmission();
	session.edit((row) => {
		row.fields.title = 'Typed after release';
	});
	expect(library.admitting).toBe(false);
	expect(library.locked(session.path)).toBe(true);
	expect(plain(session.draft)).toEqual(before);
});
