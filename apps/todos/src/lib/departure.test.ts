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
 * - A todo write, a pull, a merge, or a terminal command still running is
 *   waited for before `ready`
 * - What cannot be saved, and a new todo's typed title, are counted for the
 *   person's choice; a round cancelled elsewhere, or by "Keep working", gives
 *   them back exactly as they were
 * - Leaving anyway is a `ready` vote only: nothing is discarded, and an
 *   `idle` that follows gives everything back
 * - `granted`, `leaving`, and a `discarded` vote stay fenced
 * - While fenced, every action, Git command, terminal command, and editing
 *   input is refused, and resuming gives them back
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type { Departure } from '@epicenter/epicenter/departure/page';
import { openFolder } from '@epicenter/folder/browser';
import type { RowSession } from '@epicenter/svelte/edit-session';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { createFakeHost } from '../../../epicenter/src/departure-page.test-support.js';
import type { TodoFields } from './definition.js';
import { todosDefinition } from './definition.js';
import { holdCloses } from './opfs-holds.test-support.js';
import type { TodosFolder } from './platform/types.js';
import type { Todos } from './todos.svelte.js';

type TodoSession = RowSession<TodoFields>;

const { createTodos } = await import('./todos.svelte.ts');
const { createDeparture } = await import('@epicenter/epicenter/departure/page');
const { DEPARTING } = await import('./todos.svelte.ts');

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
	await todos.check();
	const faults = opfsOf(storage).faults;
	return {
		todos,
		/** Hold the next todo row write; resolves once it is held. */
		holdNextSave() {
			hold = Promise.withResolvers<void>();
			started = Promise.withResolvers<void>();
			const release = hold.resolve;
			return { held: started.promise, release };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
		async text(path: string) {
			const read = await folder.files.read(path);
			return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
		},
	};
}

function todoSession(todos: Todos) {
	const item = todos.opened;
	if (item?.kind !== 'todo')
		throw new Error(`Expected an open todo, got ${item?.kind}`);
	return item.session;
}

/** What the title control does: edit the draft's title, which requests a save. */
function typeTitle(session: TodoSession, title: string) {
	session.edit((row) => {
		row.fields.title = title;
	});
}

/** What the notes control does: edit the draft's body, which requests a save. */
function typeNotes(session: TodoSession, notes: string) {
	session.edit((row) => {
		row.body = notes;
	});
}

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

/**
 * The folder with its Git fetch held at `fetch`, and its fast-forward and
 * merge counted, so a test sees which steps of a pull or merge ran.
 */
function heldGit(fetch: ReturnType<typeof gate>) {
	const applied = { pullFastForward: 0, mergeIncoming: 0 };
	const adapt = (folder: TodosFolder): TodosFolder => ({
		...folder,
		git: {
			...folder.git,
			get snapshot() {
				return folder.git.snapshot;
			},
			async fetch() {
				await fetch.wait();
				return Ok({ status: 'fetched', oid: undefined });
			},
			async pullFastForward() {
				applied.pullFastForward += 1;
				return folder.git.pullFastForward();
			},
			async mergeIncoming() {
				applied.mergeIncoming += 1;
				return folder.git.mergeIncoming();
			},
		},
	});
	return { adapt, applied };
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

test('a todo write still running is waited for before the page answers ready', async () => {
	const { host, departure, todos, text } = await started();
	await todos.create('Milk');
	const path = todos.current!.path;
	const editor = todoSession(todos);
	typeTitle(editor, 'Oat milk');
	expect(editor.state.status).toBe('saving');
	host.begin('restart');
	host.nudge();
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(await text(path)).toContain('title: Oat milk');
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'restart' });
	expect(todos.departing).toBe(true);
	expect(editor.state.status).toBe('saved');
});

test('a round cancelled elsewhere gives back a failed save and the newer input typed after it, as they were', async () => {
	const { host, departure, todos, failNextWrite, text } = await started();
	await todos.create('Milk');
	const path = todos.current!.path;
	const saved = await text(path);
	const editor = todoSession(todos);
	failNextWrite(path);
	typeTitle(editor, 'First');
	await editor.settled();
	expect(editor.state.status).toBe('error');
	failNextWrite(path);
	typeTitle(editor, 'Newer');
	await editor.settled();

	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toEqual({
		stage: 'choose',
		id: expect.any(Number),
		intent: 'quit',
		held: 1,
	});
	expect(todos.failedSavePath).toBe(path);
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	// Nothing was retried for the failed save.
	expect(await text(path)).toBe(saved);

	// Another window's "Keep working" ends the round.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(departure.notice).toBeUndefined();
	expect(editor.state.status).toBe('error');
	expect(editor.draft.fields.title).toBe('Newer');
	expect(await text(path)).toBe(saved);
});

test('leaving anyway is a ready vote only: the failed save and its input stay fenced until idle gives them back', async () => {
	const { host, departure, todos, failNextWrite, text } = await started();
	await todos.create('Milk');
	const path = todos.current!.path;
	const saved = await text(path);
	const editor = todoSession(todos);
	failNextWrite(path);
	typeTitle(editor, 'Mine');
	await eventually(() => editor.state.status === 'error');

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
	expect(todos.departing).toBe(true);
	expect(editor.state.status).toBe('error');
	expect(editor.draft.fields.title).toBe('Mine');
	// Still fenced while the other window decides.
	typeNotes(editor, 'ignored\n');
	expect(editor.draft.body).toBe('');

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);
	expect(editor.state.status).toBe('error');
	expect(editor.draft.fields.title).toBe('Mine');
	expect(await text(path)).toBe(saved);
});

test('granted, leaving, and a discarded vote stay fenced: nothing is edited or started', async () => {
	for (const next of [
		{ phase: 'granted' },
		{ phase: 'leaving' },
		{ phase: 'collecting', vote: 'discarded' },
	] as const) {
		const { host, departure, todos } = await started();
		await todos.create('Milk');
		const editor = todoSession(todos);
		host.begin('quit');
		host.set(next);
		host.nudge();
		await settle();
		expect(todos.departing).toBe(true);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		typeTitle(editor, 'Late');
		expect(editor.draft.fields.title).toBe('Milk');
		expect(await todos.create('Another')).toBe(DEPARTING);
		todos.newTitle = 'Typed';
		expect(todos.newTitle).toBe('');
		// Focus while fenced reads again; still fenced.
		host.focus();
		await settle();
		expect(todos.departing).toBe(true);
	}
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
	expect(todos.failedSavePath).toBeUndefined();
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
	expect(todos.entries).toEqual([]);
});

test('while fenced, every action, Git command, terminal command, and editing input is refused; resuming gives them back', async () => {
	const { todos, text } = await openTodos();
	await todos.create('Milk');
	const path = todos.current!.path;
	const milk = todoSession(todos);
	expectOk(await todos.folder.files.create('notes.txt', 'saved'));
	await todos.refresh();
	const saved = await text(path);
	const entry = todos.entries[0]!;

	todos.departure.fence();
	// The open todo refuses input; Try again requests nothing.
	typeTitle(milk, 'Late');
	typeNotes(milk, 'late\n');
	milk.edit((row) => {
		row.fields.done = true;
	});
	milk.retry();
	expect(milk.draft).toEqual({
		fields: { title: 'Milk', done: false },
		body: '',
	});
	expect(milk.state.status).toBe('saved');
	// Actions refuse.
	todos.newTitle = 'Typed';
	expect(todos.newTitle).toBe('');
	expect(await todos.create('New')).toBe(DEPARTING);
	expect(await todos.toggle(entry)).toBe(DEPARTING);
	expect(await todos.rename(path, 'oat.md')).toBe(DEPARTING);
	expect(expectErr(await todos.deletionFor(path))).toBe(DEPARTING);
	expect(
		await todos.remove({ kind: 'file', path: 'notes.txt', sha256: 'x' }),
	).toBe(DEPARTING);
	expect(await todos.createFile('', 'more.txt')).toBe(DEPARTING);
	expect(await todos.createFolder('', 'docs')).toBe(DEPARTING);
	// Opening another file changes nothing on disk, and its text refuses input.
	await todos.open('notes.txt', 'files');
	const opened = todos.opened;
	if (opened?.kind !== 'text') throw new Error('Expected the notes text');
	const notes = opened.session;
	notes.input('typed');
	expect(notes.draft).toBe('saved');
	expect(notes.state.status).toBe('saved');
	// Git and the terminal refuse.
	expect(await todos.commitAndPush()).toEqual({
		commit: { status: 'blocked', reason: DEPARTING },
		push: { status: 'skipped', reason: DEPARTING },
	});
	expect(expectErr(await todos.pull()).message).toContain(DEPARTING);
	expect(expectErr(await todos.merge()).message).toContain(DEPARTING);
	expect(expectErr(await todos.fetch()).message).toContain(DEPARTING);
	expect(await todos.recoverIncoming()).toEqual({ kind: 'busy' });
	// The terminal takes no typing and Enter runs nothing.
	todos.terminal.command = 'touch shell.txt';
	expect(todos.terminal.command).toBe('');
	await todos.terminal.run();
	expect(todos.terminal.runs).toEqual([]);
	expect(await text('shell.txt')).toBeUndefined();
	await settle();
	expect(await text(path)).toBe(saved);
	expect(await text('notes.txt')).toBe('saved');
	expect(todos.entries).toHaveLength(1);

	todos.departure.resume();
	expect(todos.departing).toBe(false);
	notes.input('after');
	expect((await notes.settled()).status).toBe('saved');
	expect(await text('notes.txt')).toBe('after');
	await todos.open(path, 'todos');
	const reopened = todoSession(todos);
	typeTitle(reopened, 'After');
	expect((await reopened.settled()).status).toBe('saved');
	expect(await text(path)).toContain('title: After');
});

for (const ending of [
	{ phase: 'granted' },
	{ phase: 'collecting', vote: 'discarded' },
] as const)
	test(`${ending.phase === 'granted' ? 'granted' : 'a discarded vote'} during a held drain ends the handling: the drain finishes, and nothing more is answered or prompted`, async () => {
		const { host, departure, todos, holdNextSave, text } = await started();
		await todos.create('Milk');
		const path = todos.current!.path;
		const { held, release } = holdNextSave();
		typeTitle(todoSession(todos), 'Slow');
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
		await eventually(() => !todos.saving);
		await settle();
		// The admitted save landed; no ready, no prompt, and still fenced.
		expect(await text(path)).toContain('title: Slow');
		expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(todos.departing).toBe(true);
	});

test('a pull admitted before a departure is waited for, and its apply step is withdrawn and says so', async () => {
	const fetch = gate();
	const { adapt, applied } = heldGit(fetch);
	const { host, departure, todos } = await started(adapt);
	const pulling = todos.pull();
	await fetch.entered.promise;
	host.begin('quit');
	host.nudge();
	await settle();
	// The pull is still running: the page asks and waits for it.
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);
	expect(departure.notice?.stage).toBe('saving');

	fetch.open();
	expect(expectErr(await pulling).message).toContain('nothing was applied');
	expect(applied.pullFastForward).toBe(0);
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
});

test('a merge admitted before a departure is withdrawn after its fetch, and close waits for a running pull through its last step', async () => {
	const fetch = gate();
	const { adapt, applied } = heldGit(fetch);
	const { host, todos } = await started(adapt);
	const merging = todos.merge();
	await fetch.entered.promise;
	host.begin('restart');
	host.nudge();
	await settle();
	fetch.open();
	expect(expectErr(await merging).message).toContain('nothing was applied');
	expect(applied.mergeIncoming).toBe(0);
	await eventually(() => host.answers.length >= 2);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(todos.departing).toBe(false);

	fetch.entered = Promise.withResolvers();
	const pulling = todos.pull();
	await fetch.entered.promise;
	let closed = false;
	const closing = todos.close().then(() => {
		closed = true;
	});
	await settle();
	expect(closed).toBe(false);
	fetch.open();
	// A fetch that answers after close began applies nothing; close waited
	// for the whole pull before it closed the folder.
	expect(expectErr(await pulling).name).toBe('Closed');
	await closing;
	expect(closed).toBe(true);
	expect(applied.pullFastForward).toBe(0);
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
