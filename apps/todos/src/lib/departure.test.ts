/**
 * Departure Tests
 *
 * The real Todos owner behind the shared departure client
 * (`@epicenter/epicenter/departure/page`), over a real browser folder on the
 * in-memory OPFS stand-in and a stand-in for the host's side of the wire. The
 * client's own rules (listening first, version order, prompt identity, lost
 * answers, destroy) are tested beside it in `apps/epicenter`; these tests
 * cover what this owner fences, waits for, counts, and gives back.
 *
 * Key behaviors:
 * - A write, a sync, or a terminal command still running is waited for
 *   before `ready`: the page waits until nothing is mutating
 * - Only input never committed counts as unsaved: a new todo's typed
 *   title. A round cancelled elsewhere, or by "Keep working", gives it back
 * - Leaving anyway is a `ready` vote only: nothing is discarded, and an
 *   `idle` that follows gives everything back
 * - `granted`, `leaving`, and a `discarded` vote stay fenced
 * - While fenced, every edit, action, Git command, and terminal command is
 *   refused, and resuming gives them back
 * - Close waits for a running sync through its last step
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { Departure } from '@epicenter/epicenter/departure/page';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { createFakeHost } from '../../../epicenter/src/departure-page.test-support.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import type { TodosFolder } from './platform/types.js';
import { cached, observe, quiet, rowEditor } from './query.test-support.js';
import type { Todos } from './todos.svelte.js';

const { createTodos, DEPARTING } = await import('./todos.svelte.ts');
const { createDeparture } = await import('@epicenter/epicenter/departure/page');

let count = 0;
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/**
 * The real Todos owner over a fresh browser folder. `holdNextSave` holds the
 * next published write of a todo row until the returned function runs.
 */
async function openTodos(
	adapt: (folder: TodosFolder) => TodosFolder = (folder) => folder,
) {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let started: PromiseWithResolvers<void> | undefined;
	const folder = expectOk(
		await openFolder({
			id: `departure-test-${count++}`,
			definition: todosDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							const gate = hold;
							if (gate === undefined || !file.name.endsWith('.md')) return;
							hold = undefined;
							started?.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	const todos: Todos = createTodos(adapt(folder));
	cleanup.push(() => todos.close());
	cleanup.push(observe(todos));
	await quiet(todos);
	return {
		todos,
		/** Hold the next todo row write; resolves once it is held. */
		holdNextSave() {
			hold = Promise.withResolvers<void>();
			started = Promise.withResolvers<void>();
			const release = hold.resolve;
			return { held: started.promise, release };
		},
		async text(path: string) {
			const read = await folder.files.read(path);
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
	};
}

/** Add a todo; answers its stem and path. */
async function addTodo(todos: Todos, title: string) {
	const created = expectOk(await todos.create(title));
	await quiet(todos);
	return {
		stem: created.path.slice('todos/'.length, -'.md'.length),
		path: created.path,
	};
}

const titled =
	(title: string) =>
	<T extends { fields: { title: string; done: boolean } }>(row: T): T => ({
		...row,
		fields: { ...row.fields, title },
	});

/** The identity of the prompt shown now, as its controls carry it. */
function shownPrompt(departure: Departure): number {
	const notice = departure.notice;
	if (notice?.stage !== 'choose')
		throw new Error(`Expected a prompt, got ${notice?.stage}`);
	return notice.id;
}

function track(departure: Departure) {
	cleanup.push(() => departure.destroy());
	return departure;
}

/** Let reads, answers, saves, and drains run. */
async function settle() {
	for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) await Bun.sleep(5);
}

/** A started departure with an open owner, idle. */
async function started(adapt?: (folder: TodosFolder) => TodosFolder) {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	await departure.start();
	const opened = await openTodos(adapt);
	departure.attach(opened.todos.departure);
	return { host, departure, ...opened };
}

/** A gate a wrapped folder call waits on until the test opens it. */
function gate() {
	let held = Promise.withResolvers<void>();
	return {
		calls: 0,
		/** Resolves once a call is waiting. */
		entered: Promise.withResolvers<void>(),
		async wait() {
			this.calls += 1;
			this.entered.resolve();
			await held.promise;
		},
		open() {
			held.resolve();
			held = Promise.withResolvers<void>();
		},
	};
}

/** The folder with each sync held at `run` before it starts. */
function heldSync(run: ReturnType<typeof gate>) {
	return (folder: TodosFolder): TodosFolder => ({
		...folder,
		sync: {
			supported: folder.sync.supported,
			async run() {
				await run.wait();
				return folder.sync.run();
			},
			resolve: (attempt, choices) => folder.sync.resolve(attempt, choices),
		},
	});
}

/** The folder with each terminal command held at `exec` before it runs. */
function heldTerminal(exec: ReturnType<typeof gate>) {
	return (folder: TodosFolder): TodosFolder => ({
		...folder,
		terminal(options) {
			const shell = folder.terminal(options);
			return {
				get cwd() {
					return shell.cwd;
				},
				async exec(command, execOptions) {
					await exec.wait();
					return shell.exec(command, execOptions);
				},
			};
		},
	});
}

test('a write still running is waited for before the page answers ready', async () => {
	const { host, departure, todos, text, holdNextSave } = await started();
	const { stem, path } = await addTodo(todos, 'Milk');
	const { held, release } = holdNextSave();
	rowEditor(todos, stem)(titled('Oat milk'));
	await held;
	host.begin('restart');
	host.nudge();
	await settle();
	// The write is running: the page asks and waits for it.
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	expect(departure.notice?.stage).toBe('saving');

	release();
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(await text(path)).toContain('title: Oat milk');
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'restart' });
	expect(todos.departing).toBe(true);
});

test('a sync running when Epicenter asks is waited for before the page answers ready', async () => {
	const run = gate();
	const { host, todos } = await started(heldSync(run));
	const syncing = todos.sync();
	await run.entered.promise;
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	run.open();
	// No remote: the sync itself refuses, and only then is the page ready.
	expect(expectErr(await syncing).name).toBe('NoRemote');
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
});

test('a new todo title typed and not added counts: the page asks, and Keep working cancels the round and gives it back', async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toEqual({
		stage: 'choose',
		id: expect.any(Number),
		intent: 'quit',
		held: 1,
	});
	departure.keepWorking(shownPrompt(departure));
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'cancel',
	]);
	expect(host.status.phase).toBe('idle');
	expect(todos.departing).toBe(false);
	expect(todos.newTitle).toBe('Buy milk');
	// Nothing was created from it.
	expect(todos.queryClient.getQueryData<unknown[]>(['todos', 'rows'])).toEqual(
		[],
	);
});

test('a round cancelled elsewhere gives back the typed title, and leaving anyway is a ready vote only', async () => {
	const { host, departure, todos } = await started();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	departure.leaveAnyway(shownPrompt(departure));
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'quit' });
	// Still fenced while the other window decides; nothing was discarded.
	todos.newTitle = 'ignored';
	expect(todos.newTitle).toBe('Buy milk');

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(todos.newTitle).toBe('Buy milk');
	todos.newTitle = 'Buy oat milk';
	expect(todos.newTitle).toBe('Buy oat milk');
});

test('granted, leaving, and a discarded vote stay fenced: nothing is edited or started', async () => {
	for (const next of [
		{ phase: 'granted' },
		{ phase: 'leaving' },
		{ phase: 'collecting', vote: 'discarded' },
	] as const) {
		const { host, departure, todos } = await started();
		const { stem } = await addTodo(todos, 'Milk');
		host.begin('quit');
		host.set(next);
		host.nudge();
		await settle();
		expect(todos.departing).toBe(true);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(todos.edit(stem, titled('Late'))).toBe(false);
		expect(cached(todos, stem).row.fields.title).toBe('Milk');
		expect(expectErr(await todos.create('Another'))).toMatchObject({
			reason: DEPARTING,
		});
		todos.newTitle = 'Typed';
		expect(todos.newTitle).toBe('');
		// Focus while fenced reads again; still fenced.
		host.focus();
		await settle();
		expect(todos.departing).toBe(true);
	}
});

test('while fenced, every edit, action, Git command, and terminal command is refused; resuming gives them back', async () => {
	const { todos, text } = await openTodos();
	const { stem, path } = await addTodo(todos, 'Milk');
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	const saved = await text(path);
	const deletion = expectOk(await todos.deletionFor('notes.txt'));

	todos.departure.fence();
	expect(todos.edit(stem, titled('Late'))).toBe(false);
	expect(todos.editText('notes.txt', 'typed')).toBe(false);
	todos.newTitle = 'Typed';
	expect(todos.newTitle).toBe('');
	const refusal = { name: 'NotStarted', reason: DEPARTING };
	expect(expectErr(await todos.create('New'))).toMatchObject(refusal);
	expect(expectErr(await todos.rename(path, 'oat.md'))).toMatchObject(refusal);
	expect(expectErr(await todos.deletionFor(path))).toMatchObject(refusal);
	expect(expectErr(await todos.remove(deletion))).toMatchObject(refusal);
	expect(
		expectErr(await todos.createFile({ directory: '', name: 'more.txt' })),
	).toMatchObject(refusal);
	expect(
		expectErr(await todos.createFolder({ directory: '', name: 'docs' })),
	).toMatchObject(refusal);
	expect(expectErr(await todos.saveVersion())).toMatchObject(refusal);
	expect(expectErr(await todos.recoverIncoming())).toMatchObject(refusal);
	expect(expectErr(await todos.sync()).message).toContain(DEPARTING);
	// The terminal takes no typing and Enter runs nothing.
	todos.terminal.command = 'touch shell.txt';
	expect(todos.terminal.command).toBe('');
	await todos.terminal.run();
	expect(todos.terminal.runs).toEqual([]);
	await settle();
	expect(await text('shell.txt')).toBeUndefined();
	expect(await text(path)).toBe(saved);
	expect(await text('notes.txt')).toBe('saved');
	expect(todos.git.lastCommit).toBeUndefined();

	todos.departure.resume();
	expect(todos.departing).toBe(false);
	rowEditor(todos, stem)(titled('After'));
	await quiet(todos);
	expect(await text(path)).toContain('title: After');
	expectOk(await todos.remove(deletion));
	expect(await text('notes.txt')).toBeUndefined();
});

for (const ending of [
	{ phase: 'granted' },
	{ phase: 'collecting', vote: 'discarded' },
] as const)
	test(`${ending.phase === 'granted' ? 'granted' : 'a discarded vote'} during a held drain ends the handling: the drain finishes, and nothing more is answered or prompted`, async () => {
		const { host, departure, todos, holdNextSave, text } = await started();
		const { stem, path } = await addTodo(todos, 'Milk');
		const { held, release } = holdNextSave();
		rowEditor(todos, stem)(titled('Slow'));
		todos.newTitle = 'Buy milk';
		host.begin('quit');
		host.nudge();
		await held;
		await settle();
		expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);

		host.set(ending);
		host.nudge();
		await settle();
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		release();
		await eventually(() => todos.queryClient.isMutating() === 0);
		await settle();
		// The admitted write landed; no ready, no prompt, and still fenced.
		expect(await text(path)).toContain('title: Slow');
		expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(todos.departing).toBe(true);
	});

test('close waits for a running sync through its last step', async () => {
	const run = gate();
	const { todos } = await openTodos(heldSync(run));
	const syncing = todos.sync();
	await run.entered.promise;
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	await settle();
	expect(closed).toBe(false);
	run.open();
	expect(expectErr(await syncing).name).toBe('NoRemote');
	await closing;
	expect(closed).toBe(true);
});

test('a terminal command admitted before a departure is waited for; meanwhile the session keeps its command, history, and output, and Enter does nothing', async () => {
	const exec = gate();
	const { host, todos, text } = await started(heldTerminal(exec));
	const { terminal } = todos;
	terminal.command = 'echo first > first.txt';
	const running = terminal.run();
	await exec.entered.promise;
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	exec.open();
	await running;
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(await text('first.txt')).toBe('first\n');

	// Fenced: typing, recall, and Enter change nothing.
	const runs = terminal.runs.length;
	terminal.command = 'echo second > second.txt';
	expect(terminal.command).toBe('');
	expect(terminal.recall('previous')).toBe(false);
	expect(terminal.isFenced).toBe(true);
	await terminal.run();
	expect(terminal.runs.length).toBe(runs);
	expect(exec.calls).toBe(1);

	// The quit is cancelled elsewhere: the terminal takes typing again.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(terminal.isFenced).toBe(false);
	terminal.command = 'echo kept';
	expect(terminal.command).toBe('echo kept');
	expect(terminal.recall('previous')).toBe(true);
	expect(terminal.command).toBe('echo first > first.txt');
});

test('a command typed in the terminal before a departure stays exactly as typed through a cancelled round, and is not counted as unsaved', async () => {
	const { host, todos } = await started();
	const { terminal } = todos;
	terminal.command = 'git status';
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers.map((answer) => answer.answer)).toEqual(['ready']);
	await terminal.run();
	expect(terminal.command).toBe('git status');
	expect(terminal.runs).toEqual([]);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(terminal.command).toBe('git status');
});
