/**
 * Local Todos Mounted Tests
 *
 * Mounts the real Todos views in jsdom, as the page mounts them, over the
 * repository engine running in this process on `bun:sqlite` with no server.
 * A second client of the same engine stands in for a change made elsewhere
 * on this device; the browser host itself, which gives the repository to one
 * tab at a time, is covered by the Playwright smoke test. jsdom matches no media
 * query, so the view lays out as on a narrow screen.
 *
 * Key behaviors:
 * - Add, edit, complete, and delete persist across close and reopen
 * - Another tab's change updates a clean todo without replacing its controls
 * - Typing shows at once and keeps fields written elsewhere
 * - A write the engine refuses is reported, and the controls follow the stored note
 * - A note that does not fit opens into its source with its schema issue, and an edit keeps unnamed fields
 * - A failed open shows the error, and Try again opens again
 * - Open in another tab offers Use here; waiting and moved say so
 * - A change the server could not take is a notice, with its text, until dismissed
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { createRepository, type EnginePort, offlineTransport, openEngine, type Transport, WriteError } from '@epicenter/repository';
import { Ok } from 'wellcrafted/result';
import { openBunSqlite } from '@epicenter/repository/bun';
import { blur, button, click, setWide, type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { todosApp } from '../../lib/definition.js';
import type { TodosRepository, TodosTab } from '../../lib/repository.js';

const { flushSync, mount, unmount } = await import('svelte');
const state = await import('../../lib/app-state.test-support.svelte.ts');
const navigation = await import('../../lib/app-navigation.test-support.ts');
mock.module('$app/state', () => state);
mock.module('$app/navigation', () => navigation);
const { page } = state;
const { resetUrl } = navigation;
const { default: PageHost } = await import('./fixtures/PageHost.svelte');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	resetUrl();
});

const DETAIL = 'section[aria-label="Todo"]';
const LIST = '[aria-label="Todo list"]';
const TITLE = `${DETAIL} input[aria-label="Title"]`;
const NOTES = `${DETAIL} textarea[aria-label="Notes"]`;
const DONE = `${DETAIL} button[aria-label="Done"]`;
const SUMMARY = '[data-testid="status-summary"]';

/** A fresh device: one engine, which every client of the test shares. */
function freshDevice() {
	const engine = openEngine({ app: todosApp, driver: openBunSqlite(), transport: offlineTransport });
	cleanup.push(() => engine.close());
	/** When set, the engine refuses every write, as a full disk would. */
	let refuse = false;
	const port: EnginePort = {
		read: (request) => engine.read(request),
		submit(ops) {
			if (!refuse) return engine.submit(ops);
			const failed = WriteError.Unparseable({ path: 'todos/', reason: 'the disk is full' });
			return Promise.resolve(failed);
		},
		send: (ops) => engine.send(ops),
		dismiss: (id) => engine.dismiss(id),
		onChange: (listener) => engine.onChange(listener),
		// A client closing leaves the engine to the others.
		close() {},
	};
	return {
		/** Another client of this device's engine. */
		tab: (): TodosRepository => createRepository(todosApp, port),
		refuseWrites(value: boolean) {
			refuse = value;
		},
	};
}

type TabState = ReturnType<TodosTab['state']>;

/** A tab whose state the test sets, as the browser host would report it. */
function tabOf(first: TabState) {
	let state = first;
	const watchers = new Set<(state: TabState) => void>();
	const tab: TodosTab = {
		state: () => state,
		subscribe(onChange) {
			watchers.add(onChange);
			onChange(state);
			return () => watchers.delete(onChange);
		},
		close() {},
	};
	return {
		tab,
		set(next: TabState) {
			state = next;
			for (const watcher of watchers) watcher(next);
		},
	};
}

/** A tab that owns `repository`. */
const owning = (repository: TodosRepository) => tabOf({ status: 'open', repository }).tab;

/** Mount the page over the tab `open` opens; `close` unmounts it. */
function mountPage(open: () => TodosTab) {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target, props: { open } });
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
		target.remove();
	};
	cleanup.push(close);
	return {
		target,
		close,
		get<T extends Element = HTMLInputElement>(selector: string): T {
			const element = target.querySelector(selector);
			if (element === null) throw new Error(`Nothing matches '${selector}'`);
			// SAFETY: callers choose T for the element matched by their selector.
			return element as T;
		},
		text: (selector: string) => target.querySelector(selector)?.textContent?.trim(),
	};
}

/** Flush mounted views while waiting for asynchronous changes. */
async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		try {
			if (check()) return;
		} catch {}
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** Mount the page over a tab of `device` and wait until it lists the todos. */
async function openPage(device: ReturnType<typeof freshDevice>) {
	const opened = mountPage(() => owning(device.tab()));
	await until(() => opened.target.querySelector('[aria-label="Todos"]') !== null, 'the list');
	return opened;
}

const press = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** Seed `todos/milk.md` and open the page on it. */
async function onMilk() {
	const device = freshDevice();
	const other = device.tab();
	void other.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false }, body: 'Two litres' });
	resetUrl('http://localhost/?todo=milk');
	const opened = await openPage(device);
	await until(() => opened.get(TITLE).value === 'Milk', 'milk to open');
	return { ...opened, device, other };
}

test('add, edit, complete, and delete persist across close and reopen', async () => {
	const device = freshDevice();
	const first = await openPage(device);
	await until(() => first.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false, 'the empty list');
	expect(first.target.querySelector('[data-testid="save-version"]')).toBeNull();
	expect(first.target.querySelector('[data-testid="sync"]')).toBeNull();

	type(first.get('[aria-label="New todo title"]'), 'Buy milk');
	flushSync();
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain('Todo not added');
	click(first.get(LIST), 'Add');
	await until(() => first.get(TITLE).value === 'Buy milk', 'the new todo to open');
	const id = page.url.searchParams.get('todo');
	if (id === null) throw new Error('The new todo did not open');
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain('On this device');

	type(first.get(TITLE), 'Buy oat milk');
	type(first.get<HTMLTextAreaElement>(NOTES), 'Two litres');
	press(first.get(DONE));
	flushSync();
	// Each shows at once, before the engine answers.
	expect(first.get(TITLE).value).toBe('Buy oat milk');
	expect(first.get(DONE).getAttribute('aria-checked')).toBe('true');
	first.close();

	const second = await openPage(device);
	await until(() => second.get(TITLE).value === 'Buy oat milk', 'the todo to reopen');
	expect(second.get<HTMLTextAreaElement>(NOTES).value).toBe('Two litres');
	expect(second.get(DONE).getAttribute('aria-checked')).toBe('true');
	expect((await device.tab().todos.get({ stem: id }))?.text).toBe('---\ntitle: Buy oat milk\ndone: true\n---\nTwo litres');

	click(second.get(DETAIL), 'Delete');
	await until(() => document.querySelector('[role="alertdialog"]') !== null, 'the confirmation');
	const dialog = document.querySelector('[role="alertdialog"]');
	if (dialog === null) throw new Error('The delete confirmation did not open');
	click(dialog, 'Delete');
	await until(() => page.url.searchParams.get('todo') === null, 'the delete');
	second.close();

	const third = await openPage(device);
	await until(() => third.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false, 'an empty list');
	expect(await device.tab().todos.get({ stem: id })).toBeNull();
});

test("another tab's change updates a clean todo without replacing its controls", async () => {
	const { get, other } = await onMilk();
	const title = get(TITLE);
	const notes = get<HTMLTextAreaElement>(NOTES);

	void other.todos.write({ stem: 'milk' }, { body: 'Three litres' });
	await until(() => get<HTMLTextAreaElement>(NOTES).value === 'Three litres', 'the other tab’s notes');
	expect(get(TITLE)).toBe(title);
	expect(get(NOTES)).toBe(notes);
	expect(title.value).toBe('Milk');

	type(title, 'Oat milk');
	type(notes, 'Three litres, unsweetened');
	flushSync();
	expect(notes.value).toBe('Three litres, unsweetened');
	blur(title);
	const saved = await other.todos.get({ stem: 'milk' });
	expect(saved?.fields).toEqual({ title: 'Oat milk', done: false });
	expect(saved?.body).toBe('Three litres, unsweetened');
});

test('title typed here and done set elsewhere both survive', async () => {
	const { get, other } = await onMilk();
	type(get(TITLE), 'Oat milk');
	flushSync();
	void other.todos.set({ stem: 'milk' }, 'done', true);
	await until(() => get(DONE).getAttribute('aria-checked') === 'true', 'done from the other tab');
	expect(get(TITLE).value).toBe('Oat milk');
	const saved = await other.todos.get({ stem: 'milk' });
	expect(saved?.fields).toEqual({ title: 'Oat milk', done: true });
	expect(saved?.body).toBe('Two litres');
});

test('rapid typing shows and saves the latest title', async () => {
	const { get, other } = await onMilk();
	for (const typed of ['O', 'Oa', 'Oat', 'Oat milk']) {
		type(get(TITLE), typed);
		flushSync();
		expect(get(TITLE).value).toBe(typed);
	}
	expect((await other.todos.get({ stem: 'milk' }))?.fields.title).toBe('Oat milk');
	await until(() => get(TITLE).value === 'Oat milk', 'the latest title to stay');
});

test('a deleted todo shows absence even when its editor was already open', async () => {
	resetUrl('http://localhost/?todo=ghost');
	const ghost = await openPage(freshDevice());
	await until(() => ghost.text(DETAIL)?.includes('This todo is no longer here') ?? false, 'the missing todo');
	ghost.close();
	const { target, get, text, other } = await onMilk();
	expect(get(TITLE).value).toBe('Milk');
	void other.todos.delete({ stem: 'milk' });
	await until(() => text(DETAIL)?.includes('This todo is no longer here') ?? false, 'the deletion observation');
	expect(target.querySelector(TITLE)).toBeNull();
	expect(target.querySelector('button[aria-label="Complete Milk"]')).toBeNull();
});

test('a write the engine refuses is reported, and the controls follow the stored note', async () => {
	const { get, device } = await onMilk();
	setWide(true);
	cleanup.push(() => setWide(false));
	// The wide layout mounts the detail again.
	await until(() => get(TITLE).value === 'Milk', 'the wide detail');
	device.refuseWrites(true);

	type(get(TITLE), 'Oat milk');
	await until(() => document.body.textContent?.includes('Could not save the title') ?? false, 'the title error');
	await until(() => get(TITLE).value === 'Milk', 'the stored title');

	press(get(DONE));
	await until(() => document.body.textContent?.includes('Could not update todo') ?? false, 'the Done error');
	await until(() => get(DONE).getAttribute('aria-checked') === 'false', 'the stored done');
	expect(get('button[aria-label="Complete Milk"]').getAttribute('aria-checked')).toBe('false');
	expect((await device.tab().todos.get({ stem: 'milk' }))?.fields).toEqual({ title: 'Milk', done: false });
});

test('a failed Add reports the error', async () => {
	const device = freshDevice();
	const opened = await openPage(device);
	device.refuseWrites(true);
	type(opened.get('[aria-label="New todo title"]'), 'Buy tea');
	flushSync();
	click(opened.get(LIST), 'Add');
	await until(() => document.body.textContent?.includes('Could not add todo') ?? false, 'the Add error');
	expect(opened.text('[aria-label="Todos"]')).toContain('No todos yet');
});

test('a new title not added does not prompt before a browser reload', async () => {
	const opened = await openPage(freshDevice());
	type(opened.get('[aria-label="New todo title"]'), 'Buy tea');
	flushSync();
	expect(opened.get(SUMMARY).getAttribute('aria-label')).toContain('Todo not added');
	expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
	expect(navigation.leave()).toBe(false);
	expect(opened.get('[aria-label="New todo title"]').value).toBe('Buy tea');
});

test('a note that does not fit opens into its source with its schema issue, and an edit keeps unnamed fields', async () => {
	const device = freshDevice();
	const other = device.tab();
	// Written as another program might: `done` is not a boolean, and `owner` is not in the schema.
	void other.batch((b) => {
		b.todos.write({ stem: 'odd' }, { fields: { title: 'Odd', done: 'soon' as never }, body: 'Notes\n' });
		b.todos.write({ stem: 'extra' }, { fields: { title: 'Extra', done: false, owner: 'sam' } as never });
	});
	const opened = await openPage(device);
	await until(() => opened.target.querySelector('[aria-label="Needs repair"]') !== null, 'the repair list');
	expect(opened.text('[aria-label="Needs repair"]')).toContain('todos/odd.md');

	click(opened.get('[aria-label="Needs repair"]'), 'Repair');
	const SOURCE = `${DETAIL} [aria-label="Source of todos/odd.md"]`;
	await until(() => opened.target.querySelector(SOURCE) !== null, 'the source');
	expect([...opened.get(SOURCE).querySelectorAll('.cm-line')].map((line) => line.textContent)).toEqual([
		'---',
		'title: Odd',
		'done: soon',
		'---',
		'Notes',
		'',
	]);
	await until(() => opened.text('[data-testid="source-status"]')?.includes('/done must be boolean') ?? false, 'the schema issue');

	press(opened.get('[data-todo="todos/extra.md"]'));
	await until(() => opened.get(TITLE).value === 'Extra', 'extra to open');
	type(opened.get(TITLE), 'Extra, renamed');
	expect((await other.todos.get({ stem: 'extra' }))?.fields).toEqual({ title: 'Extra, renamed', done: false, owner: 'sam' });
	expect((await other.todos.get({ stem: 'odd' }))?.text).toBe('---\ntitle: Odd\ndone: soon\n---\nNotes\n');
});

test('a failed open shows the error, and Try again opens again', async () => {
	const device = freshDevice();
	const held = tabOf({ status: 'opening' });
	const error = { name: 'Unavailable', message: 'Storage access is blocked', reason: 'blocked' } as const;
	held.set({ status: 'unavailable', error, retry: () => held.set({ status: 'open', repository: device.tab() }) });
	const opened = mountPage(() => held.tab);
	await until(() => opened.text('[role="alert"]')?.includes('Storage access is blocked') ?? false, 'the refusal');
	expect(opened.target.querySelector(LIST)).toBeNull();
	press(button(opened.target, 'Try again'));
	await until(() => opened.target.querySelector('[aria-label="Todos"]') !== null, 'the list');
});

test('a repository open in another tab offers Use here, and a moved one says so', async () => {
	const device = freshDevice();
	const held = tabOf({ status: 'opening' });
	let used = 0;
	held.set({ status: 'elsewhere', useHere: () => used++ });
	const opened = mountPage(() => held.tab);
	await until(() => opened.target.textContent?.includes('Todos is open in another tab') ?? false, 'the takeover offer');
	press(button(opened.target, 'Use here'));
	expect(used).toBe(1);
	held.set({ status: 'waiting', reason: 'busy' });
	await until(() => opened.target.textContent?.includes('Waiting for the other tab') ?? false, 'the wait');
	held.set({ status: 'open', repository: device.tab() });
	await until(() => opened.target.querySelector('[aria-label="Todos"]') !== null, 'the list');
	held.set({ status: 'moved', useHere: () => used++ });
	await until(() => opened.target.textContent?.includes('Todos moved to another tab') ?? false, 'the moved notice');
	expect(opened.target.querySelector(LIST)).toBeNull();
});

test('a change the server could not take is shown as a notice, with its text to copy, until dismissed', async () => {
	const transport: Transport = {
		connect: () => ({
			connected: () => true,
			hello: async () => Ok({ kind: 'changes' as const, seq: 0, files: [] }),
			push: async () => Ok({ kind: 'refused' as const, path: '', reason: 'batch 1 arrived after 3', overlaps: [] }),
			close() {},
		}),
	};
	const engine = openEngine({ app: todosApp, driver: openBunSqlite(), transport });
	cleanup.push(() => engine.close());
	const opened = mountPage(() => owning(createRepository(todosApp, engine)));
	await until(() => opened.target.querySelector('[aria-label="Todos"]') !== null, 'the list');
	type(opened.get('[aria-label="New todo title"]'), 'Buy tea');
	flushSync();
	click(opened.get(LIST), 'Add');
	await until(() => opened.text('[aria-label="Notices"]')?.includes('could not be saved to the server') ?? false, 'the notice');
	expect(opened.text('[aria-label="Notices"]')).toContain('batch 1 arrived after 3');
	expect(button(opened.target, 'Copy text')).toBeDefined();
	press(button(opened.target, 'Dismiss'));
	await until(() => opened.target.querySelector('[aria-label="Notices"]') === null, 'the notice to go');
});
