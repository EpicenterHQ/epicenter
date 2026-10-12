/**
 * Departure Notice Mounted Tests
 *
 * Mounts the real `DepartureNotice` in jsdom over the shared departure client
 * (`@epicenter/epicenter/departure/page`) and the real Todos owner on the
 * in-memory OPFS stand-in, with a stand-in for the host's side of the wire. The buttons are
 * clicked through the DOM.
 *
 * Key behaviors:
 * - The notice names the intent: quitting, or restarting for an account
 *   change
 * - What would be lost is listed, and "Keep working" cancels the round; the
 *   page then edits again with its input as it was
 * - "Quit anyway" is a ready vote; the page stays fenced and keeps its input
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { createFakeHost } from '../../../../epicenter/src/departure-page.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import { click } from '../../lib/svelte-dom.test-support.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { startTodos } = await import('../../lib/todos.svelte.ts');
const { createDeparture } = await import('@epicenter/epicenter/departure/page');
const { default: DepartureNotice } = await import('./DepartureNotice.svelte');

let count = 0;
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup() {
	const folder = expectOk(
		await openFolder({
			id: `departure-notice-${count++}`,
			definition: todosDefinition,
			browser: { ...testBrowserStorage() },
		}),
	);
	const todos: Todos = startTodos(folder);
	cleanup.push(() => todos.close());
	const host = createFakeHost();
	const departure = createDeparture(host.port);
	cleanup.push(() => departure.destroy());
	await departure.start();
	departure.attach(todos.departure);
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(DepartureNotice, { target, props: { departure } });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	return { todos, host, departure, target };
}

async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) {
		await Bun.sleep(5);
		flushSync();
	}
	flushSync();
}

test('a restart lists what would be lost, and Keep working cancels it and gives the page back', async () => {
	const { todos, host, departure, target } = await setup();
	todos.newTitle = 'Buy milk';
	expect(target.textContent?.trim()).toBe('');
	host.begin('restart');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(target.textContent).toContain(
		'Epicenter is restarting for an account change',
	);
	expect(target.textContent).toContain(
		'the title of a new todo you have not added is still in the box',
	);
	expect(target.textContent).toContain('Restart anyway');

	click(target, 'Keep working');
	await eventually(() => !todos.departing);
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'cancel',
	]);
	expect(todos.newTitle).toBe('Buy milk');
	expect(target.textContent?.trim()).toBe('');
});

test("an earlier round's Quit anyway control, kept after its prompt left, approves nothing in a later restart", async () => {
	const { todos, host, departure, target } = await setup();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	const quitAnyway = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Quit anyway',
	)!;
	expect(quitAnyway).toBeDefined();

	// Another window ends the quit, and a restart begins.
	host.set({ phase: 'idle' });
	host.begin('restart');
	host.nudge();
	await eventually(
		() =>
			departure.notice?.stage === 'choose' &&
			departure.notice.intent === 'restart',
	);
	expect(target.textContent).toContain('Restart anyway');
	expect(quitAnyway.isConnected).toBe(false);

	quitAnyway.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await eventually(() => false);
	expect(host.answers.map((answer) => [answer.round, answer.answer])).toEqual([
		[1, 'asking'],
		[2, 'asking'],
	]);
	expect(departure.notice?.stage).toBe('choose');
	expect(todos.departing).toBe(true);

	// The restart's own control answers the restart.
	click(target, 'Restart anyway');
	await eventually(() => host.answers.length >= 3);
	expect(host.answers.at(-1)).toMatchObject({ round: 2, answer: 'ready' });
});

test('Quit anyway is a ready vote: the page stays fenced and keeps what it holds', async () => {
	const { todos, host, departure, target } = await setup();
	todos.newTitle = 'Buy milk';
	host.begin('quit');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(target.textContent).toContain('Epicenter is quitting');

	click(target, 'Quit anyway');
	await eventually(() => host.answers.length >= 2);
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(todos.departing).toBe(true);
	expect(todos.newTitle).toBe('Buy milk');
	expect(target.textContent).toContain('This window is ready');
	expect(target.textContent).toContain('the quit is cancelled');
});
