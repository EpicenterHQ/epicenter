/**
 * Local Todos Mounted Tests
 *
 * Mounts the real Todos views in jsdom, as the page mounts them, over the
 * repository API on a replica in this process (`bun:sqlite`, no server). A
 * second repository over the same replica stands in for a change made
 * elsewhere on this device; the browser host itself, which gives the
 * replica to one tab at a time, is covered by the Playwright tests. jsdom
 * matches no media query, so the view lays out as on a narrow screen.
 *
 * Key behaviors:
 * - Add, edit, complete, and delete persist across close and reopen
 * - Another tab's change updates a clean todo without replacing its controls
 * - A title typed here and done set elsewhere both survive
 * - A write the replica refuses is reported, and the controls follow the stored note
 * - A note that does not fit opens into its source with its schema issue, and an edit keeps unnamed fields
 * - The header says a held todo is not sent
 * - Storage that cannot be opened shows why, and Try again opens it
 * - The repository's status shows before the todos arrive and as a bar after, and the app is never mounted twice
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openBunSqlite } from '@epicenter/repository/bun';
import { openReplica, type Replica } from '@epicenter/repository/client';
import type { SqlDriver } from '../../../../../packages/repository/src/sql.js';
import { unwrap } from 'wellcrafted/result';
import { createLocalHost } from '../../../../../packages/repository/src/api/local.js';
import { openRepository } from '../../../../../packages/repository/src/api/repository.js';
import { blur, button, click, editorText, setWide, type, typeInEditor } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { todosApp } from '../../lib/definition.js';
import type { TodosRepository } from '../../lib/repository.js';

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
const NOTES = `${DETAIL} [aria-label="Notes"]`;
const DONE = `${DETAIL} button[aria-label="Done"]`;
const SUMMARY = '[data-testid="status-summary"]';

/** A fresh device: one replica on one database, which every repository of the test opens. */
function freshDevice() {
	const driver: SqlDriver = openBunSqlite();
	const replica = unwrap(openReplica({ driver, binding: { repository: 'todos', server: null, account: null }, device: 'this-device', app: todosApp, after: () => {}, now: () => 0 }));
	/** When set, the replica refuses every change, as a full disk would. */
	let refuse = false;
	const refusing: Replica = {
		...replica,
		change(changes) {
			if (refuse) throw new Error('the disk is full');
			return replica.change(changes);
		},
	};
	return {
		replica,
		/** A repository over this device's replica, with the host that runs it. */
		host() {
			const local = createLocalHost({ replica: refusing, app: todosApp });
			const repository: TodosRepository = openRepository({ app: todosApp, host: local.host });
			cleanup.push(() => repository.close());
			return { ...local, repository };
		},
		/** Another repository over this device's replica. */
		tab: (): TodosRepository => {
			const repository = openRepository({ app: todosApp, host: createLocalHost({ replica, app: todosApp }).host });
			cleanup.push(() => repository.close());
			return repository;
		},
		/** The todo's exact text as the replica holds it. */
		text: (stem: string) => replica.read(`todos/${stem}.md`),
		refuseWrites(value: boolean) {
			refuse = value;
		},
	};
}

/** Mount the page over `repository`; `close` unmounts it. */
function mountPage(repository: TodosRepository, syncsTo?: string, onLeave: () => void = () => {}) {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target, props: { repository, syncsTo, onLeave } });
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
		has: (selector: string) => target.querySelector(selector) !== null,
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

/** Mount the page over a repository on `device` and wait until it lists the todos. */
async function openPage(device: ReturnType<typeof freshDevice>, syncsTo?: string) {
	const { repository } = device.host();
	const opened = mountPage(repository, syncsTo);
	await until(() => opened.has('[aria-label="Todos"]'), 'the list');
	return opened;
}

const press = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** Seed `todos/milk.md` and open the page on it. */
async function onMilk() {
	const device = freshDevice();
	const other = device.tab();
	await until(() => other.status().status === 'open', 'the other tab');
	unwrap(await other.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false }, body: 'Two litres' }));
	resetUrl('http://localhost/?todo=milk');
	const opened = await openPage(device);
	await until(() => opened.get(TITLE).value === 'Milk' && opened.has(NOTES), 'milk to open');
	return { ...opened, device, other };
}

test('add, edit, complete, and delete persist across close and reopen', async () => {
	const device = freshDevice();
	const first = await openPage(device);
	await until(() => first.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false, 'the empty list');

	type(first.get('[aria-label="New todo title"]'), 'Buy milk');
	flushSync();
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain('Todo not added');
	click(first.get(LIST), 'Add');
	await until(() => first.get(TITLE).value === 'Buy milk' && first.has(NOTES), 'the new todo to open');
	const id = page.url.searchParams.get('todo');
	if (id === null) throw new Error('The new todo did not open');
	expect(first.get(SUMMARY).getAttribute('aria-label')).toContain('On this device');

	type(first.get(TITLE), 'Buy oat milk');
	typeInEditor(first.get(NOTES), 'Two litres');
	press(first.get(DONE));
	flushSync();
	// Each shows at once, before the replica answers.
	expect(first.get(TITLE).value).toBe('Buy oat milk');
	expect(first.get(DONE).getAttribute('aria-checked')).toBe('true');
	await until(() => device.text(id) === '---\ntitle: Buy oat milk\ndone: true\n---\nTwo litres', 'every edit stored');
	first.close();

	const second = await openPage(device);
	await until(() => second.get(TITLE).value === 'Buy oat milk' && second.has(NOTES), 'the todo to reopen');
	expect(editorText(second.get(NOTES))).toBe('Two litres');
	expect(second.get(DONE).getAttribute('aria-checked')).toBe('true');

	click(second.get(DETAIL), 'Delete');
	await until(() => document.querySelector('[role="alertdialog"]') !== null, 'the confirmation');
	const dialog = document.querySelector('[role="alertdialog"]');
	if (dialog === null) throw new Error('The delete confirmation did not open');
	click(dialog, 'Delete');
	await until(() => page.url.searchParams.get('todo') === null, 'the delete');
	await until(() => device.text(id) === null, 'the delete stored');
	second.close();

	const third = await openPage(device);
	await until(() => third.text('[aria-label="Todos"]')?.includes('No todos yet') ?? false, 'an empty list');
});

test("another tab's change updates a clean todo without replacing its controls", async () => {
	const { get, other, device } = await onMilk();
	const title = get(TITLE);
	const notes = get(NOTES);

	unwrap(await other.todos.write({ stem: 'milk' }, '---\ntitle: Milk\ndone: false\n---\nThree litres'));
	await until(() => editorText(get(NOTES)) === 'Three litres', 'the other tab’s notes');
	expect(get(TITLE)).toBe(title);
	expect(get(NOTES)).toBe(notes);
	expect(title.value).toBe('Milk');

	type(title, 'Oat milk');
	typeInEditor(notes, 'Three litres, unsweetened');
	flushSync();
	expect(editorText(notes)).toBe('Three litres, unsweetened');
	blur(title);
	await until(() => device.text('milk') === '---\ntitle: Oat milk\ndone: false\n---\nThree litres, unsweetened', 'both saved');
});

test('a title typed here and done set elsewhere both survive', async () => {
	const { get, other, device } = await onMilk();
	type(get(TITLE), 'Oat milk');
	flushSync();
	unwrap(await other.todos.patch({ stem: 'milk' }, { done: true }));
	await until(() => get(DONE).getAttribute('aria-checked') === 'true', 'done from the other tab');
	expect(get(TITLE).value).toBe('Oat milk');
	await until(() => device.text('milk') === '---\ntitle: Oat milk\ndone: true\n---\nTwo litres', 'both fields stored');
});

test('rapid typing shows and saves the latest title', async () => {
	const { get, device } = await onMilk();
	for (const typed of ['O', 'Oa', 'Oat', 'Oat milk']) {
		type(get(TITLE), typed);
		flushSync();
		expect(get(TITLE).value).toBe(typed);
	}
	await until(() => device.text('milk')?.includes('title: Oat milk') ?? false, 'the latest title stored');
	await until(() => get(TITLE).value === 'Oat milk', 'the latest title to stay');
});

test('a deleted todo shows absence even when its editor was already open', async () => {
	resetUrl('http://localhost/?todo=ghost');
	const ghost = await openPage(freshDevice());
	await until(() => ghost.text(DETAIL)?.includes('This todo is no longer here') ?? false, 'the missing todo');
	ghost.close();
	const { target, text, other } = await onMilk();
	unwrap(await other.todos.delete({ stem: 'milk' }));
	await until(() => text(DETAIL)?.includes('This todo is no longer here') ?? false, 'the deletion observation');
	expect(target.querySelector(TITLE)).toBeNull();
	expect(target.querySelector('button[aria-label="Complete Milk"]')).toBeNull();
});

test('a write the replica refuses is reported, and the controls follow the stored note', async () => {
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
	expect(device.text('milk')).toBe('---\ntitle: Milk\ndone: false\n---\nTwo litres');
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
	await until(() => other.status().status === 'open', 'the other tab');
	// Written as another program might: `done` is not a boolean, and `owner` is not in the schema.
	unwrap(
		await other.commit((batch) => {
			batch.todos.write({ stem: 'odd' }, '---\ntitle: Odd\ndone: soon\n---\nNotes\n');
			batch.todos.write({ stem: 'extra' }, '---\ntitle: Extra\ndone: false\nowner: sam\n---\n');
		}),
	);
	const opened = await openPage(device);
	await until(() => opened.has('[aria-label="Needs repair"]'), 'the repair list');
	expect(opened.text('[aria-label="Needs repair"]')).toContain('todos/odd.md');

	click(opened.get('[aria-label="Needs repair"]'), 'Repair');
	const SOURCE = `${DETAIL} [aria-label="Source of todos/odd.md"]`;
	await until(() => opened.has(SOURCE), 'the source');
	expect(editorText(opened.get(SOURCE))).toBe('---\ntitle: Odd\ndone: soon\n---\nNotes\n');
	await until(() => opened.text('[data-testid="editor-status"]')?.includes('/done must be boolean') ?? false, 'the schema issue');

	press(opened.get('[data-todo="todos/extra.md"]'));
	await until(() => opened.get(TITLE).value === 'Extra', 'extra to open');
	type(opened.get(TITLE), 'Extra, renamed');
	await until(() => device.text('extra') === '---\ntitle: Extra, renamed\ndone: false\nowner: sam\n---\n', 'the rename, keeping owner');
	expect(device.text('odd')).toBe('---\ntitle: Odd\ndone: soon\n---\nNotes\n');
});

test('the header says a held todo is not sent, and never Synced while one waits', async () => {
	const device = freshDevice();
	const other = device.tab();
	await until(() => other.status().status === 'open', 'the other tab');
	unwrap(await other.todos.create({ stem: 'milk' }, { fields: { title: 'Milk', done: false } }));
	const opened = await openPage(device, 'https://sync.example');
	// With no server reached, the create is still sending.
	await until(() => opened.get(SUMMARY).getAttribute('aria-label')?.includes('Sending') ?? false, 'sending');
	unwrap(await other.todos.write({ stem: 'milk' }, '---\ntitle: [Milk\ndone: false\n---\n'));
	await until(() => opened.get(SUMMARY).getAttribute('aria-label')?.includes('Not sent') ?? false, 'the held todo');
	unwrap(await other.todos.write({ stem: 'milk' }, '---\ntitle: Milk\ndone: false\n---\n'));
	await until(() => opened.get(SUMMARY).getAttribute('aria-label')?.includes('Sending') ?? false, 'the repair sending');
});

test('storage that cannot be opened shows why, and Try again opens it', async () => {
	const device = freshDevice();
	const local = device.host();
	local.end({ status: 'unavailable', reason: 'Storage access is blocked', retry: () => local.resume() });
	const opened = mountPage(local.repository);
	await until(() => opened.text('[role="alert"]')?.includes('Storage access is blocked') ?? false, 'the refusal');
	expect(opened.has(LIST)).toBe(false);
	press(button(opened.target, 'Try again'));
	await until(() => opened.has('[aria-label="Todos"]'), 'the list');
});

test("the repository's status shows before the todos arrive and as a bar after, and the app is never mounted twice", async () => {
	const device = freshDevice();
	const local = device.host();
	let used = 0;
	// Another tab holds the replica, before this page's first session.
	local.end({ status: 'elsewhere', useHere: () => used++ });
	const opened = mountPage(local.repository);
	await until(() => opened.target.textContent?.includes('Todos is open in another tab') ?? false, 'the takeover offer');
	expect(opened.has(LIST)).toBe(false);
	press(button(opened.target, 'Use here'));
	expect(used).toBe(1);
	local.end({ status: 'waiting', reason: 'busy' });
	await until(() => opened.target.textContent?.includes('Waiting for the other tab') ?? false, 'the wait');
	local.resume();
	await until(() => opened.has('[aria-label="Todos"]'), 'the list');
	const list = opened.get(LIST);

	// Another tab takes it: the list stays, under a bar that offers it back.
	local.end({ status: 'moved', useHere: () => used++ });
	await until(() => opened.get('[data-testid="repository-status"]').getAttribute('data-status') === 'moved', 'the moved bar');
	expect(opened.get(LIST)).toBe(list);
	press(button(opened.get('[data-testid="repository-status"]'), 'Use here'));
	expect(used).toBe(2);
	local.resume();
	await until(() => !opened.has('[data-testid="repository-status"]'), 'the bar to go');
	expect(opened.get(LIST)).toBe(list);
});

test('a repository that does not open offers to choose another, from every screen before its todos arrive', async () => {
	const device = freshDevice();
	const local = device.host();
	let left = 0;
	local.end({ status: 'unavailable', reason: 'Storage access is blocked', retry: () => {} });
	const opened = mountPage(local.repository, undefined, () => left++);
	await until(() => opened.text('[role="alert"]')?.includes('Storage access is blocked') ?? false, 'the refusal');
	press(button(opened.target, 'Choose another repository'));
	expect(left).toBe(1);
	local.end({ status: 'opening' });
	await until(() => opened.target.textContent?.includes('Opening') ?? false, 'opening');
	press(button(opened.target, 'Choose another repository'));
	expect(left).toBe(2);
});
